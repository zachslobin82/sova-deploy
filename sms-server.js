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
  bookingUrl:     '',
  giftCardUrl:    '',
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
const MAYA_SYSTEM_PROMPT = `You are Maya, the AI receptionist for Therapeutic Massage & Wellness (TMW) in Newtown, CT. You are responding via TEXT MESSAGE to someone who just missed a call. Keep every reply to 2-3 sentences max. One idea per message. Warm, calm, conversational. No markdown, no asterisks, no lists.

BUSINESS INFO
Name: Therapeutic Massage & Wellness
Address: 32 Church Hill Road, Newtown CT 06470
Phone: 203-304-1313
Hours: Mon-Thu 9am-8pm | Fri-Sat 9am-4pm | Sun 10am-4pm

YOUR PERSONALITY
Warm and knowledgeable like a friendly spa receptionist. Never robotic. Never say "Great question!" Never send more than one question per message. If someone seems frustrated, acknowledge it first.

BOOKING FLOW — follow this exactly, one step per message:

STEP 1 — Ask what brings them in:
"What brings you in — looking to relax, work out some pain or tension, or something else?"

STEP 2 — Recommend a service based on their answer, then ask for confirmation:
- Relaxation/stress → "Our 55-min Therapeutic Massage is perfect for that — $135. Or if you want to really melt, our Aromatherapy Massage is $145. Does that sound good?"
- Pain/tension/problem area → "Sounds like our 85-min Deep Muscle Therapy would really help — $205. It gives your therapist enough time to work through it properly. Does that sound good?"
- Recovery/athletic → "Our 85-min Sports Massage is great for that — $205. Does that work for you?"
- Facial → "We have several facials — our TMW Signature Glow and Lymphatic Facial are both really popular at $160/55min or $225/85min. Which sounds more like what you are looking for?"
- Recovery services (float, sauna, etc.) → give relevant pricing and send them to call 203-304-1313 for availability
- Couples → "We do couples massages — 55 min is $400, 85 min is $525. Best to call us at 203-304-1313 to arrange that."
- Not sure → "How much time do you have — 55 or 85 minutes?"

STEP 3 — ONE massage add-on upsell, benefit-first:
- Pain/tension → "Hot stones can be really supportive in the therapist getting deeper without extra pressure. Would you like to add that for just an extra $20?"
- Relaxation → "Aromatherapy can really deepen the relaxation experience. Would you like to add that for just an extra $15?"
- If YES → offer infrared sauna: "Love it. One more thing — a lot of clients do 30 min in our infrared sauna after their massage to really flush everything out. Its $50 and takes the whole experience to another level. Want to add that on too?"
- If NO to massage add-on → skip everything, go straight to booking link. No more upsells.
- If NO to sauna → go straight to booking link.
- Accept all responses cleanly. Never push twice.

STEP 4 — Send the right booking link with warm framing:
Say: "Youre going to love it. Heres the link to lock in your time — takes about 60 seconds: [link]. Well take great care of you!"

BOOKING LINKS:
- 25 min: https://api.gohighlevel.com/widget/booking/uBLikuiy9gCI2MDItdz5
- 55 min: https://api.gohighlevel.com/widget/booking/HFlTUh76tUn01FHsf9Hi
- 85 min: https://api.gohighlevel.com/widget/booking/GDhkZy8h9CtjAOPPKlgR
- 110 min: https://api.gohighlevel.com/widget/booking/tFKqGwFxE5Ka5626we5X

IF THEY HAVE A QUESTION (not booking):
Answer using the business info and pricing below, then naturally invite them to book.

SERVICES & PRICING
MASSAGE: Therapeutic $135/55min $195/85min $260/110min | Deep Muscle $145/55min $205/85min $290/110min | Sports $135/55min $205/85min | Hot Stone $145/55min $205/85min $290/110min | Aromatherapy $145/55min $205/85min $290/110min | Prenatal $145/55min $205/85min | Head/Hands/Feet $80/25min $125/55min
FACIALS: Signature Glow/Lymphatic $160/55min $225/85min | Anti-Aging $160/55min $225/85min | Active Clearing/Ultra Radiance $150/55min | Gentlemens $150/55min $220/85min | Teen Facial $115
RECOVERY: Float $95/60min $125/90min $160/120min | Infrared Sauna $50/30min $65/45min $75/60min | Cold Plunge $50/10min | Red Light $30/10min $40/20min $50/30min | Fire & Ice $90/40min
REDIRECT TO CALL (203-304-1313): Couples services | Jenna Dallinga specifically | Memberships | Brow and Lash Bar

CANCELLATION
24hr notice required. No-show = 100% charge. Handle cancellations warmly, note it for Carolyn, immediately offer to rebook.

NEVER: Mention Boulevard | Send more than one question per message | Push upsell more than once | Write more than 2-3 sentences`;

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
function isBookingComplete(mayaReply) {
  const r = mayaReply.toLowerCase();
  return (r.includes("you're all set") || r.includes("youre all set") || r.includes("we'll see you") || r.includes("well see you") || r.includes("we will see you")) &&
    (r.includes("massage") || r.includes("facial") || r.includes("float") || r.includes("sauna") || r.includes("therapy") || r.includes("service"));
}

async function alertSlack(clientPhone, mayaReply, conversationHistory) {
  const webhookUrl = 'process.env.SLACK_WEBHOOK_URL';
  const lastMessages = conversationHistory.slice(-10).map(m => `${m.role === 'user' ? 'Client' : 'Maya'}: ${m.content}`).join('\n');
  const payload = {
    text: `📅 *New Booking via Maya SMS*\n*Client phone:* ${clientPhone}\n\n*Booking summary:*\n${mayaReply}\n\n*Conversation:*\n\`\`\`${lastMessages}\`\`\`\n\n_Mirror this into GHL calendar and confirm the exact time._`
  };
  try {
    await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    console.log('[SLACK ALERT] Booking alert sent');
  } catch (err) {
    console.error('[SLACK ALERT] Failed:', err.message);
  }
}

async function alertCarolyn(clientPhone, clientMessage) {
  const alertMessage =
    `Maya Alert: Client (${clientPhone}) cancelled via text.\n` +
    `Their message: "${clientMessage}"\n` +
    `Please cancel in GHL and free the slot.`;

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

    // --- Fire Slack alert if booking is complete ---
    if (isBookingComplete(mayaReply)) {
      const history = conversations.get(clientPhone) || [];
      await alertSlack(clientPhone, mayaReply, history);
    }

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
