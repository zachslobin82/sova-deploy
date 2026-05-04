// ============================================================================
// Sova SMS Server — Maya AI Text Receptionist
// TMW (Therapeutic Massage & Wellness, Newtown CT)
//
// Architecture:
//   GHL Workflow → POST /sms-inbound (this server)
//     → GPT-4.1 processes with full TMW knowledge base
//     → GHL API sends SMS reply to client
//     → Cancellations also fire SMS alert to Carolyn
//
//   Retell Voice Agent → POST /create-ghl-booking (this server)
//     → Creates appointment in GHL Calendars API
//     → Returns success/failure JSON to Retell
//
// Run: node sms-server.js
// ============================================================================

const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CONFIG = {
  openAiApiKey:   process.env.OPENAI_API_KEY,
  ghlBearerToken: process.env.GHL_BEARER_TOKEN,
  ghlLocationId:  'i354kGTSmTlt3zeEVsCG',
  ghlFromNumber:  '+18605904699',
  carolynCell:    '+18456121174',
  businessName:   'Therapeutic Massage & Wellness',
  agentName:      'Maya',
  bookingUrl:     'blvd.me/therapeuticmassageandwellness',
  giftCardUrl:    'blvd.me/therapeuticmassageandwellness/gift-cards',
  mainPhone:      '203-304-1313',
};

if (!CONFIG.openAiApiKey)   console.warn('[WARN] OPENAI_API_KEY not set');
if (!CONFIG.ghlBearerToken) console.warn('[WARN] GHL_BEARER_TOKEN not set');

const conversations = new Map();
function getHistory(phone) { if (!conversations.has(phone)) conversations.set(phone, []); return conversations.get(phone); }
function addToHistory(phone, role, content) { const h = getHistory(phone); h.push({ role, content }); if (h.length > 20) h.splice(0, h.length - 20); }

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

WHEN CLIENT CANCELS VIA TEXT:
1. Acknowledge warmly
2. Confirm what you're cancelling
3. Tell them Carolyn will update the system
4. Try to rebook: "Would you like to find another time?"

WHEN CLIENT ASKS ABOUT GIFT CARDS: blvd.me/therapeuticmassageandwellness/gift-cards

WHAT YOU NEVER DO
- Never tell a client to call for something you can handle via text
- Never send multiple questions in one message
- Never list every service unless specifically asked`;

async function getMayaResponse(clientPhone, incomingMessage) {
  addToHistory(clientPhone, 'user', incomingMessage);
  const history = getHistory(clientPhone);
  const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${CONFIG.openAiApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4.1', max_tokens: 300, messages: [{ role: 'system', content: MAYA_SYSTEM_PROMPT }, ...history] }) });
  if (!response.ok) { const err = await response.text(); throw new Error(`OpenAI error: ${response.status} — ${err}`); }
  const data = await response.json();
  const reply = data.choices[0].message.content.trim();
  addToHistory(clientPhone, 'assistant', reply);
  return reply;
}

function isCancellation(message) {
  const lower = message.toLowerCase();
  return ['cancel','cancellation','need to cancel','want to cancel',"can't make it",'cannot make it',"won't be able",'reschedule','need to reschedule','move my appointment','change my appointment'].some(t => lower.includes(t));
}

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (phone.startsWith("+")) return `+${digits}`;
  return phone;
}

async function sendGhlSms(toPhone, message) {
  const normalizedPhone = normalizePhone(toPhone);
  console.log(`[SEND SMS] To: ${toPhone} normalized: ${normalizedPhone}`);
  let conversationId = null, conversationProviderId = null;
  let contactId = null;
  const convRes = await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${CONFIG.ghlLocationId}&q=${encodeURIComponent(normalizedPhone)}`, { headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, Version: '2021-04-15' } });
  console.log('[SEND SMS] Conv search status: ' + convRes.status);
  if (convRes.ok) {
    const cd = await convRes.json();
    console.log('[SEND SMS] Conv search result: ' + JSON.stringify(cd).substring(0, 200));
    const conv = cd && cd.conversations && cd.conversations[0] ? cd.conversations[0] : null;
    if (conv) { conversationId = conv.id || null; contactId = conv.contactId || null; conversationProviderId = conv.conversationProviderId || null; console.log('[SEND SMS] Found conversation: ' + conversationId + ' contactId: ' + contactId + ' providerId: ' + conversationProviderId); }
    else { console.warn('[SEND SMS] No conversation found for ' + normalizedPhone); }
  } else { const e = await convRes.text(); console.warn('[SEND SMS] Conv search failed: ' + convRes.status + ' ' + e); }
  if (!conversationId && !contactId) throw new Error('No conversationId or contactId for ' + normalizedPhone);
  const payload = { type: 'SMS', message, fromNumber: CONFIG.ghlFromNumber, toNumber: normalizedPhone, locationId: CONFIG.ghlLocationId };
  if (conversationId) payload.conversationId = conversationId;
  if (contactId) payload.contactId = contactId;
  if (conversationProviderId) payload.conversationProviderId = conversationProviderId;
  const smsRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', { method: 'POST', headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-04-15' }, body: JSON.stringify(payload) });
  if (!smsRes.ok) { const e = await smsRes.text(); throw new Error(`GHL SMS send failed: ${smsRes.status} — ${e}`); }
  return await smsRes.json();
}

async function alertCarolyn(clientPhone, clientMessage) {
  const alertMessage = `Maya Alert: Client (${clientPhone}) cancelled via text.\nTheir message: "${clientMessage}"\nPlease cancel in Boulevard and free the slot.`;
  try { await sendGhlSms(CONFIG.carolynCell, alertMessage); console.log(`[CAROLYN ALERT] Sent to ${CONFIG.carolynCell}`); }
  catch (err) { console.error(`[CAROLYN ALERT] Failed: ${err.message}`); }
}

async function createGhlAppointment({ calendarId, locationId, startTime, endTime, firstName, lastName, email, phone, title }) {
  let contactId = null;
  if (phone) {
    const sr = await fetch(`https://services.leadconnectorhq.com/contacts/search/phone?phone=${encodeURIComponent(phone)}&locationId=${locationId || CONFIG.ghlLocationId}`, { headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, Version: '2021-04-15' } });
    if (sr.ok) { const d = await sr.json(); contactId = d?.contacts?.[0]?.id || null; }
  }
  if (!contactId) {
    const cr = await fetch('https://services.leadconnectorhq.com/contacts/', { method: 'POST', headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-07-28' }, body: JSON.stringify({ locationId: locationId||CONFIG.ghlLocationId, firstName: firstName||'', lastName: lastName||'', email: email||'', phone: phone||'' }) });
    if (!cr.ok) { const e = await cr.text(); throw new Error(`GHL contact create failed: ${cr.status} — ${e}`); }
    const cd = await cr.json(); contactId = cd?.contact?.id || null;
  }
  if (!contactId) throw new Error('Could not find or create GHL contact');
  const ar = await fetch('https://services.leadconnectorhq.com/calendars/events/appointments', { method: 'POST', headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-04-15' }, body: JSON.stringify({ calendarId, locationId: locationId||CONFIG.ghlLocationId, contactId, startTime, endTime, title: title||`Appointment — ${firstName} ${lastName}`, appointmentStatus: 'confirmed', ignoreDateRange: false, toNotify: true }) });
  if (!ar.ok) { const e = await ar.text(); throw new Error(`GHL appointment create failed: ${ar.status} — ${e}`); }
  return await ar.json();
}

app.post('/create-ghl-booking', async (req, res) => {
  console.log('\n[BOOKING REQUEST]', JSON.stringify(req.body, null, 2));
  const { calendarId, locationId, startTime, endTime, firstName, lastName, email, phone, title } = req.body;
  const missing = []; if (!calendarId) missing.push('calendarId'); if (!startTime) missing.push('startTime'); if (!endTime) missing.push('endTime');
  if (missing.length > 0) return res.status(400).json({ success: false, error: `Missing: ${missing.join(', ')}` });
  try {
    const result = await createGhlAppointment({ calendarId, locationId, startTime, endTime, firstName, lastName, email, phone, title });
    const appointmentId = result?.id || result?.appointment?.id || 'unknown';
    console.log(`[BOOKING SUCCESS] ID: ${appointmentId}`);
    return res.status(200).json({ success: true, appointmentId, message: `Confirmed for ${firstName} ${lastName}` });
  } catch (err) { console.error('[BOOKING ERROR]', err.message); return res.status(500).json({ success: false, error: err.message }); }
});

app.post('/sms-inbound', async (req, res) => {
  res.status(200).json({ received: true });
  try {
    const body = req.body;
    console.log('\n[INBOUND SMS]', JSON.stringify(body, null, 2));
    const clientPhone     = body.phone || body.contact?.phone || body.fromPhone || body.from || null;
    const incomingMessage = body.message || body.messageBody || body.smsBody || body.body || null;
    if (!clientPhone || !incomingMessage) { console.warn('[INBOUND SMS] Cannot extract phone/message:', body); return; }
    console.log(`[INBOUND SMS] From: ${clientPhone} | Message: "${incomingMessage}"`);
    if (isCancellation(incomingMessage)) { console.log('[CANCELLATION] Alerting Carolyn...'); await alertCarolyn(clientPhone, incomingMessage); }
    const mayaReply = await getMayaResponse(clientPhone, incomingMessage);
    console.log(`[MAYA REPLY] → "${mayaReply}"`);
    await sendGhlSms(clientPhone, mayaReply);
    console.log(`[SMS SENT] To: ${clientPhone}`);
  } catch (err) { console.error('[ERROR]', err.message); }
});

app.get('/health', (req, res) => { res.json({ status: 'ok', agent: CONFIG.agentName, client: CONFIG.businessName, endpoints: ['/sms-inbound', '/create-ghl-booking', '/health'], timestamp: new Date().toISOString() }); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓ Sova SMS Server running on port ${PORT}`);
  console.log(`  Agent: ${CONFIG.agentName} | Client: ${CONFIG.businessName}`);
  console.log(`  Endpoints: POST /sms-inbound | POST /create-ghl-booking | GET /health`);
  console.log(`  GHL Token: ${CONFIG.ghlBearerToken ? '✓ loaded' : '✗ MISSING'}`);
  console.log(`  OpenAI:    ${CONFIG.openAiApiKey ? '✓ loaded' : '✗ MISSING'}\n`);
});
