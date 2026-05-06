// ============================================================================
// Sova SMS Server — Maya AI Text Receptionist
// TMW (Therapeutic Massage & Wellness, Newtown CT)
//
// Architecture:
//   GHL Workflow → POST /sms-inbound (this server)
//   → GPT-4.1 processes with full TMW knowledge base
//   → GHL API sends SMS reply to client
//   → Cancellations also fire SMS alert to Carolyn
//
// Run:  node sms-server.js
// Expose: ngrok http 3000  (copy HTTPS URL → paste into GHL Workflow webhook)
// ============================================================================

const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------
const CONFIG = {
  // Retell / OpenAI
  openAiApiKey: process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY',

  // GHL
  ghlBearerToken: 'pit-fb285c5d-a16c-45be-adce-f35d0722bd52',
  ghlLocationId:  'i354kGTSmTlt3zeEVsCG',
  ghlFromNumber:  '+18605904699',   // TMW GHL number

  // Carolyn alert number
  carolynCell:    '+18456121174',

  // Business
  businessName:   'Therapeutic Massage & Wellness',
  agentName:      'Maya',
  bookingUrl:     'blvd.me/therapeuticmassageandwellness',
  giftCardUrl:    'blvd.me/therapeuticmassageandwellness/gift-cards',
  mainPhone:      '203-304-1313',
};

// ----------------------------------------------------------------------------
// IN-MEMORY CONVERSATION STORE
// Keyed by client phone number. Stores last 10 turns per conversation.
// For production: swap with Redis or a lightweight DB.
// ----------------------------------------------------------------------------
const conversations = new Map();

function getHistory(phone) {
  if (!conversations.has(phone)) conversations.set(phone, []);
  return conversations.get(phone);
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  // Keep last 20 messages (10 turns) to stay within token budget
  if (history.length > 20) history.splice(0, history.length - 20);
}

// ----------------------------------------------------------------------------
// MAYA'S SYSTEM PROMPT — Full TMW knowledge base
// ----------------------------------------------------------------------------
const MAYA_SYSTEM_PROMPT = `You are Maya, the AI front desk receptionist for Therapeutic Massage & Wellness (TMW) in Newtown, CT. You are responding via TEXT MESSAGE — keep replies concise, warm, and conversational. Never write walls of text. One idea per message. Use plain language, no markdown, no asterisks.

BUSINESS INFO
Name: Therapeutic Massage & Wellness
Address: 32 Church Hill Road, Newtown CT 06470
Main phone: 203-304-1313
Hours: Mon–Thu 9am–8pm | Fri–Sat 9am–4pm | Sun 10am–4pm
Booking: blvd.me/therapeuticmassageandwellness
Gift cards: blvd.me/therapeuticmassageandwellness/gift-cards

YOUR PERSONALITY
- Warm, calm, professional — like a knowledgeable friend at the spa
- One question or piece of info at a time
- Never robotic. Never list-dump. Never say "Great question!"
- If someone seems frustrated, acknowledge it first before helping

BOOKING APPROACH
For all bookable services, send the Boulevard booking link: blvd.me/therapeuticmassageandwellness
Tell them they can book 24/7 there. You can also help gather their preferences and tell them what to select.

SERVICES & PRICING

MASSAGE
- Therapeutic Massage: $135/55min, $195/85min, $260/110min
- Deep Muscle Therapy: $145/55min, $205/85min, $290/110min
- Sports & Stretch: $135/55min, $205/85min
- Hot Stone: $145/55min, $205/85min, $290/110min
- Aromatherapy: $145/55min, $205/85min, $290/110min
- De-Stress Massage: $145/55min, $205/85min, $290/110min
- Lymphatic Drainage (Christina): $155+/55min, $205+/85min — premium specialist rates
- Prenatal: $145/55min, $205/85min
- Recovery Massage: $140/85min, $200/110min
- Head/Hands/Feet: $80/25min, $125/55min
- Tension Tamer: $80/25min, $125/55min

FACIALS
- Active Clearing: $150/55min, $225/85min
- Anti-Aging: $160/55min, $225/85min
- Lymphatic Facial: $160/55min, $225/85min
- TMW Signature Glow: $160/55min, $225/85min
- Ultra Radiance: $150/55min, $220/85min
- Gentlemen's Facial: $150/55min, $220/85min
- Back Facial: $150/55min
- Teen Facial: $115
- Chemical Peels: $100–$145

RECOVERY
- Float Therapy: $95/60min, $125/90min, $160/120min
- Infrared Sauna: $40/20min, $50/30min, $80/60min
- Traditional Sauna: $50/20min, $70/30min
- Red Light Therapy: $30/10min, $40/20min, $50/30min
- Compression Therapy: $30/15min, $40/30min, $65/60min
- Cold Plunge: $50/10min
- Fire & Ice: $90/40min
- Day Pass (single recovery): $50 | Full recovery suite: $110

REDIRECT TO CALL SPA (203-304-1313) FOR:
- Jenna Dallinga specifically: $250/hr new clients, ART, IMA — always redirect to call
- Couples services
- Memberships and packages
- Brow & Lash Bar services

CANCELLATION POLICY (you handle ALL text cancellations — NEVER tell client to call)
- Standard: 24-hour notice required. After deadline: 50% fee.
- Services $250+: 48-hour notice. Deposit non-refundable after deadline.
- Services $500+: Full payment due 7 days prior. Non-refundable.
- No-show: 100% charge.
- Changes must be made via phone or text to Maya.

WHEN CLIENT CANCELS VIA TEXT:
1. Acknowledge warmly ("Got it, no problem!")
2. Confirm what you're cancelling (service, date, time if they told you)
3. Tell them you've noted it and Carolyn will update the system
4. Immediately try to rebook: "Would you like to find another time that works better?"
5. If they want to rebook → help them, send booking link
6. If they don't want to rebook → wish them well, tell them you're here when they're ready

WHEN CLIENT ASKS ABOUT GIFT CARDS:
Send this link: blvd.me/therapeuticmassageandwellness/gift-cards

CONTEXT AWARENESS
- If someone replies "yes" or "no" or "okay" without context, refer to conversation history
- If unclear what they're responding to, ask a gentle clarifying question
- Never restart the conversation — always maintain context from prior messages

WHAT YOU NEVER DO
- Never tell a client to call for something you can handle via text
- Never send multiple questions in one message
- Never list every service unless specifically asked
- Never say you'll "check" something and get back to them — respond with what you know
- Never confirm a cancellation is processed in the system (that's Carolyn's job)`;

// ----------------------------------------------------------------------------
// GPT-4.1 CALL
// ----------------------------------------------------------------------------
async function getMayaResponse(clientPhone, incomingMessage) {
  addToHistory(clientPhone, 'user', incomingMessage);
  const history = getHistory(clientPhone);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CONFIG.openAiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1',
      max_tokens: 300,
      messages: [
        { role: 'system', content: MAYA_SYSTEM_PROMPT },
        ...history,
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  const reply = data.choices[0].message.content.trim();
  addToHistory(clientPhone, 'assistant', reply);
  return reply;
}

// ----------------------------------------------------------------------------
// CANCELLATION DETECTOR
// Returns true if the message looks like a cancellation request
// ----------------------------------------------------------------------------
function isCancellation(message) {
  const lower = message.toLowerCase();
  const triggers = [
    'cancel', 'cancellation', 'need to cancel', 'want to cancel',
    'can\'t make it', 'cannot make it', 'won\'t be able', 'reschedule',
    'need to reschedule', 'move my appointment', 'change my appointment',
  ];
  return triggers.some(t => lower.includes(t));
}

// ----------------------------------------------------------------------------
// GHL: SEND SMS
// Uses GHL's conversation API to send an outbound SMS from Maya's number
// ----------------------------------------------------------------------------
async function sendGhlSms(toPhone, message) {
  const d = toPhone.replace(/\D/g, '');
  toPhone = '+' + (d.length === 10 ? '1' + d : d);
  // First, get or create a conversation for this contact
  const contactRes = await fetch(
    `https://services.leadconnectorhq.com/contacts/?locationId=${CONFIG.ghlLocationId}&query=${encodeURIComponent(toPhone)}`,
    {
      headers: {
        Authorization: `Bearer ${CONFIG.ghlBearerToken}`,
        Version: '2021-04-15',
      },
    }
  );

  let contactId = null;
  if (contactRes.ok) {
    const contactData = await contactRes.json();
    contactId = contactData?.contacts?.[0]?.id || null;
  }

  // Send SMS via GHL conversations endpoint
  const payload = {
    type: 'SMS',
    message,
    fromNumber: CONFIG.ghlFromNumber,
    toNumber: toPhone,
    locationId: CONFIG.ghlLocationId,
  };

  if (contactId) payload.contactId = contactId;

  const smsRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CONFIG.ghlBearerToken}`,
      'Content-Type': 'application/json',
      Version: '2021-04-15',
    },
    body: JSON.stringify(payload),
  });

  if (!smsRes.ok) {
    const errText = await smsRes.text();
    throw new Error(`GHL SMS send failed: ${smsRes.status} — ${errText}`);
  }

  return await smsRes.json();
}

// ----------------------------------------------------------------------------
// ALERT CAROLYN via SMS
// Fires when a client cancels via text
// ----------------------------------------------------------------------------
async function alertCarolyn(clientPhone, clientMessage) {
  const alertMessage =
    `Maya Alert: Client (${clientPhone}) cancelled via text.\n` +
    `Their message: "${clientMessage}"\n` +
    `Please cancel in Boulevard and free the slot.`;

  try {
    await sendGhlSms(CONFIG.carolynCell, alertMessage);
    console.log(`[CAROLYN ALERT] Sent to ${CONFIG.carolynCell}`);
  } catch (err) {
    // Non-fatal — log but don't crash the main flow
    console.error(`[CAROLYN ALERT] Failed to send: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// MAIN WEBHOOK ENDPOINT
// GHL Workflow POSTs here when a client replies to Maya's SMS
//
// GHL sends various payload shapes depending on workflow config.
// We handle the most common ones.
// ----------------------------------------------------------------------------
app.post('/sms-inbound', async (req, res) => {
  // Always ACK immediately so GHL doesn't retry
  res.status(200).json({ received: true });

  try {
    const body = req.body;
    console.log('\n[INBOUND SMS]', JSON.stringify(body, null, 2));

    // --- Extract phone and message from GHL payload ---
    // GHL workflow custom webhooks typically send:
    // body.phone / body.message  OR  body.contact.phone / body.messageBody
    const clientPhone =
      body.phone ||
      body.contact?.phone ||
      body.fromPhone ||
      body.from ||
      null;

    const incomingMessage =
      body.message ||
      body.messageBody ||
      body.smsBody ||
      body.body ||
      null;

    if (!clientPhone || !incomingMessage) {
      console.warn('[INBOUND SMS] Could not extract phone or message from payload:', body);
      return;
    }

    console.log(`[INBOUND SMS] From: ${clientPhone} | Message: "${incomingMessage}"`);

    // --- Fire Carolyn alert if cancellation detected ---
    if (isCancellation(incomingMessage)) {
      console.log('[CANCELLATION DETECTED] Alerting Carolyn...');
      await alertCarolyn(clientPhone, incomingMessage);
    }

    // --- Get Maya's response ---
    const mayaReply = await getMayaResponse(clientPhone, incomingMessage);
    console.log(`[MAYA REPLY] → "${mayaReply}"`);

    // --- Send reply via GHL ---
    await sendGhlSms(clientPhone, mayaReply);
    console.log(`[SMS SENT] To: ${clientPhone}`);

  } catch (err) {
    console.error('[ERROR]', err.message);
  }
});

// ----------------------------------------------------------------------------
// HEALTH CHECK
// ----------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    agent: CONFIG.agentName,
    client: CONFIG.businessName,
    timestamp: new Date().toISOString(),
  });
});

// ----------------------------------------------------------------------------
// START
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓ Sova SMS Server running on port ${PORT}`);
  console.log(`  Agent:   ${CONFIG.agentName}`);
  console.log(`  Client:  ${CONFIG.businessName}`);
  console.log(`  Webhook: POST /sms-inbound`);
  console.log(`  Health:  GET  /health`);
  console.log(`\n  Next: run ngrok http ${PORT} and paste the HTTPS URL into GHL Workflow\n`);
});
