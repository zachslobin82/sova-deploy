// ============================================================================
// Sova SMS Server — Maya AI Text Receptionist
// TMW (Therapeutic Massage & Wellness, Newtown CT)
//
// Architecture:
// GHL Workflow → POST /sms/inbound (this server)
// → GPT-4.1 processes with full TMW knowledge base
// → GHL API sends SMS reply to client
// → Every alert + every conversation posts to TMW Slack (#mayaalerts)
//   via SLACK_WEBHOOK_URL. No SMS alerts to staff (Oct 2026).
//
// BOOKING MODE (Sep 2026): Boulevard is still the live calendar.
// Maya does NOT send booking links. She collects the request and hands it
// to the front desk via Slack; they book it in Boulevard and confirm with the client.
//
// Run: node sms-server.js
// ============================================================================

const express = require('express');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------
const CONFIG = {
openAiApiKey: process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY',
ghlBearerToken: process.env.GHL_BEARER_TOKEN || 'pit-fb285c5d-a16c-45be-adce-f35d0722bd52',
ghlLocationId: process.env.GHL_LOCATION_ID || 'i354kGTSmTlt3zeEVsCG',
ghlFromNumber: process.env.GHL_FROM_NUMBER || '+18605904699',
businessName: 'Therapeutic Massage & Wellness',
agentName: 'Maya',
mainPhone: '203-304-1313',
// Branded link domain. Set LINKS_BASE_URL in Railway (e.g. https://links.tmwmassage.net)
// and every client-facing link switches over. No code change needed.
linksBaseUrl: (process.env.LINKS_BASE_URL || 'https://sova-deploy-production.up.railway.app').replace(/\/$/, ''),
};

// ----------------------------------------------------------------------------
// IN-MEMORY CONVERSATION STORE
// ----------------------------------------------------------------------------
const conversations = new Map();

function getHistory(phone) {
if (!conversations.has(phone)) conversations.set(phone, []);
return conversations.get(phone);
}

function addToHistory(phone, role, content) {
const history = getHistory(phone);
history.push({ role, content });
if (history.length > 20) history.splice(0, history.length - 20);
}

// ----------------------------------------------------------------------------
// MAYA'S SYSTEM PROMPT
// ----------------------------------------------------------------------------
const MAYA_SYSTEM_PROMPT = `You are Maya, the AI receptionist for Therapeutic Massage & Wellness (TMW) in Newtown, CT. You are responding via TEXT MESSAGE to someone who just missed a call. Keep every reply to 2-3 sentences max. One idea per message. Warm, calm, conversational. No markdown, no asterisks, no lists.

BUSINESS INFO
Name: Therapeutic Massage & Wellness
Address: 32 Church Hill Road, Newtown CT 06470
Phone: 203-304-1313
Hours: Mon-Thu 9am-8pm | Fri-Sat 9am-4pm | Sun 10am-4pm

YOUR PERSONALITY
Warm and knowledgeable like a friendly spa receptionist. Never robotic. Never say "Great choice!" or "Great question!" Never send more than one question per message. If someone seems frustrated, acknowledge it first.

BOOKING FLOW — follow this exactly, one step per message:

STEP 1 — Ask what brings them in. No greeting, no "thanks for reaching out" — go straight to the question:
"What brings you in — looking to relax, work out some pain or tension, or something else?"
CRITICAL: If CURRENT FLOW STATE is START, your ONLY response is this Step 1 question, word for word. Do not mention services, prices, or links. Do not assume what they want.
OFF-TOPIC: If the client's first message is clearly not about booking (wrong number, billing, complaint, general question unrelated to a service), answer helpfully in one sentence and direct them to call 203-304-1313. Do not start the booking flow.

STEP 2 — Recommend with soft alternative, then ask which they prefer:
- Relaxation/stress → "Our 55-min Therapeutic Massage is perfect for relaxation and is $135. However, if you really want to melt, our 85-min allows the therapist to go deeper on any specific problem areas and gives them more time to work — and its $195. Which sounds best for you?"
- Pain/tension/problem area → "Sounds like our 85-min Deep Muscle Therapy would really help with that — $205. However, if youre shorter on time, our 55-min session is $145 and still gets great results. Which sounds best for you?"
- Recovery/athletic → "Our 85-min Sports Massage is great for that — $205. We also have a 55-min for $135 if youre shorter on time. Which sounds best for you?"
- Facial → "We have several facials — our TMW Signature Glow and Lymphatic Facial are both really popular at $160/55min or $225/85min. Which sounds more like what you are looking for?"
- Recovery services → give relevant pricing and send them to call 203-304-1313 for availability
- Couples → "We do couples massages — 55 min is $400, 85 min is $525. Best to call us at 203-304-1313 to arrange that."

STEP 3 — Ask about therapist preference. One message, one question:
"Do you have a preferred therapist, or is anyone available fine?"
- If NO preference → move to Step 4 (add-on upsell).
- If YES preference → acknowledge the therapist by name in one short sentence, then move to Step 4. Include the text THERAPIST_REQUESTED in your reply so the system can alert the team. Do not say this to the client.

STEP 4 — ONE massage add-on upsell, benefit-first. Only offer ONCE. If they decline, go straight to Step 5 — no more upsells:
- Pain/tension → "Hot stones can be really supportive in the therapist getting deeper without extra pressure. Would you like to add that for just an extra $20?"
- Relaxation → "Aromatherapy can really deepen the relaxation experience. Would you like to add that for just an extra $15?"
- Facials → skip this step and go straight to Step 5.
- If YES or NO → go to Step 5.

STEP 5 — Ask for their preferred day and time. One message:
"What day and time works best for you? A general window is perfect."

STEP 6 — Once they give a day/time, close warmly. One message, then stop:
"Perfect. I'll pass this to our front desk and they'll text you shortly to confirm your appointment."
Include the text BOOKING_REQUEST at the end of this reply so the system can alert the team. Do not say this to the client.

IMPORTANT: You cannot see the schedule and you cannot book appointments. Never promise a specific time is available. Never send any links. Never say the appointment is booked or confirmed — the front desk confirms it.

TONE RULE: No exclamation points anywhere in Maya responses. Warm and composed, not bubbly.

IF THEY HAVE A QUESTION (not booking):
Answer using the business info and pricing below, then naturally invite them to book.

SERVICES & PRICING
MASSAGE: Therapeutic $135/55min $195/85min $260/110min | Deep Muscle $145/55min $205/85min $290/110min | Sports/Stretching $135/55min $205/85min | Hot Stone $145/55min $205/85min $290/110min | Aromatherapy $145/55min $205/85min $290/110min | Mother-To-Be $145/55min $205/85min | TMW Signature De-Stress $145/55min $205/85min $290/110min | Head/Hands/Feet $80/25min $125/55min | Teen Massage $105/55min
FACIALS: TMW Signature Glow $80/25min $160/55min $225/85min | Lymphatic Facial $80/25min $160/55min $225/85min | Anti-Aging $160/55min $225/85min | Active Clearing $150/55min $225/85min | Ultra Radiance $150/55min $220/85min | Gentlemens $150/55min $220/85min | Teen Facial $115 | Back Facial $150/55min
RECOVERY: Float $95/60min $125/90min $160/120min | Infrared Sauna $40/20min $50/30min $80/60min | Traditional Sauna $50/20min $70/30min | Cold Plunge $50/10min | Red Light $30/10min $40/20min $50/30min | Fire & Ice $90/40min | Compression Therapy $30/15min $40/30min $65/60min | TMW Experience Day Pass $50 | Recovery Day Pass $110 | Ultimate Recovery $200
REDIRECT TO CALL (203-304-1313): Couples services | Jenna Dallinga specifically | Memberships | Brow and Lash Bar | Lymphatic Drainage | Chemical Peels | Cosmetic services (brows/lashes)

CANCELLATION
24hr notice required. No-show = 100% charge. Handle cancellations warmly, note it for the front desk, immediately offer to rebook.

NEVER: Mention Boulevard | Send links | Say an appointment is booked or confirmed | Send more than one question per message | Push upsell more than once | Write more than 2-3 sentences`;

// ----------------------------------------------------------------------------
// FLOW STATE DETECTOR
// ----------------------------------------------------------------------------
function detectFlowState(history) {
const lastAssistant = [...history].reverse().find(m => m.role === 'assistant')?.content?.toLowerCase() || '';
if (lastAssistant.includes('pass this to our front desk')) return 'REQUEST_SENT — conversation complete. If client replies, answer briefly and let them know the front desk will text to confirm. Do not restart the flow.';
if (lastAssistant.includes('what day and time works')) return 'STEP5_COMPLETE — waiting for preferred day/time. When they give one, send the Step 6 closing message with BOOKING_REQUEST.';
if (lastAssistant.includes('brings you in')) return 'STEP1_COMPLETE — waiting for client to say why they are coming in';
if (lastAssistant.includes('which sounds best') || lastAssistant.includes('which works better') || lastAssistant.includes('which sounds more')) return 'STEP2_COMPLETE — waiting for client to choose their service/duration';
if (lastAssistant.includes('preferred therapist') || lastAssistant.includes('anyone available fine')) return 'STEP3_COMPLETE — waiting for therapist preference. Then move to the add-on upsell (or Step 5 for facials).';
if (lastAssistant.includes('hot stones')) return 'ADDON_OFFERED — waiting for yes or no to hot stones. Either way, move to Step 5 (ask preferred day/time).';
if (lastAssistant.includes('aromatherapy')) return 'ADDON_OFFERED — waiting for yes or no to aromatherapy. Either way, move to Step 5 (ask preferred day/time).';
return 'START — conversation just beginning';
}

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
{
role: 'system',
content: MAYA_SYSTEM_PROMPT + '\n\nCURRENT FLOW STATE: ' + detectFlowState(history) + '\nYou MUST act according to this state. Do not restart the flow. Do not re-ask questions already answered.'
},
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
// ----------------------------------------------------------------------------
function isCancellation(message) {
const lower = message.toLowerCase();
const triggers = [
'cancel', 'cancellation', 'need to cancel', 'want to cancel',
"can't make it", 'cannot make it', "won't be able", 'reschedule',
'need to reschedule', 'move my appointment', 'change my appointment',
];
return triggers.some(t => lower.includes(t));
}

// ----------------------------------------------------------------------------
// SLACK ALERT
// ----------------------------------------------------------------------------
async function alertSlack(message) {
const webhookUrl = process.env.SLACK_WEBHOOK_URL;
if (!webhookUrl) return;
try {
await fetch(webhookUrl, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ text: message }),
});
} catch (err) {
console.error('[SLACK ALERT] Failed:', err.message);
}
}

// ----------------------------------------------------------------------------
// GHL: SEND SMS
// ----------------------------------------------------------------------------
async function sendGhlSms(toPhone, message) {
const d = toPhone.replace(/\D/g, '');
toPhone = '+' + (d.length === 10 ? '1' + d : d);

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
// SLACK HELPERS
// ----------------------------------------------------------------------------
function who(name, phone) {
return name ? `${name} (${phone})` : phone;
}

// Mirrors every Maya exchange into Slack so the team can follow along
// without logging into GHL.
async function postConversation(name, phone, clientMsg, mayaMsg) {
await alertSlack(
`:speech_balloon: *${who(name, phone)}*\n` +
`> *Client:* ${clientMsg}\n` +
(mayaMsg ? `> *Maya:* ${mayaMsg}` : '')
);
}

// ----------------------------------------------------------------------------
// BOOKING REQUEST (hand-off to front desk via Slack)
// ----------------------------------------------------------------------------
function buildRequestSummary(clientPhone) {
const history = conversations.get(clientPhone) || [];
// Client's own words, in order — gives the front desk the full request at a glance
const clientLines = history.filter(m => m.role === 'user').map(m => `- ${m.content}`);
return clientLines.slice(-8).join('\n');
}

async function alertBookingRequest(name, clientPhone, addons, therapistRequested) {
const summary = buildRequestSummary(clientPhone);
const addonText = addons.length ? addons.join(', ') : 'none';
const therapistText = therapistRequested ? 'YES — see their messages' : 'no preference';

await alertSlack(
`:calendar: *BOOKING REQUEST — ${who(name, clientPhone)}*\n` +
`*To do:* book in Boulevard, then text them to confirm.\n` +
`Add-ons: ${addonText} | Therapist: ${therapistText}\n` +
`What they said:\n${summary}`
);
}

// ----------------------------------------------------------------------------
// DETECT ADD-ONS
// ----------------------------------------------------------------------------
function detectAddOns(conversationHistory) {
const addons = [];
const messages = conversationHistory;
for (let i = 0; i < messages.length; i++) {
const msg = messages[i];
if (msg.role === 'assistant') {
const isHotStones = msg.content.toLowerCase().includes('hot stones');
const isAromatherapy = msg.content.toLowerCase().includes('aromatherapy');
const nextUser = messages[i + 1];
if (nextUser && nextUser.role === 'user') {
const said = nextUser.content.toLowerCase();
const saidYes = said.includes('yes') || said.includes('sure') || said.includes('ok') || said.includes('great') || said.includes('love') || said.includes('add') || said.includes('sounds good') || said.includes('that sounds');
if (saidYes && isHotStones) addons.push('Hot Stones +$20');
if (saidYes && isAromatherapy) addons.push('Aromatherapy +$15');
}
}
}
return addons;
}

async function writeAddOnsToContact(contactId, addons) {
if (!contactId || addons.length === 0) return;
try {
await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
method: 'PUT',
headers: {
Authorization: `Bearer ${CONFIG.ghlBearerToken}`,
'Content-Type': 'application/json',
Version: '2021-07-28',
},
body: JSON.stringify({
customFields: [{ id: '8EOok3x105CyQIIJyMtx', value: addons.join(', ') }],
}),
});
console.log('[ADD-ONS] Written to contact:', addons.join(', '));
} catch (err) {
console.error('[ADD-ONS] Failed to write:', err.message);
}
}

// Tracks whether a client asked for a specific therapist during this conversation
const therapistRequestedBy = new Set();

// ----------------------------------------------------------------------------
// MAIN WEBHOOK ENDPOINT
// ----------------------------------------------------------------------------
app.post('/sms/inbound', async (req, res) => {
res.status(200).json({ received: true });

try {
const body = req.body;
console.log('\n[INBOUND SMS]', JSON.stringify(body, null, 2));

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

const clientName =
body.full_name ||
[body.first_name, body.last_name].filter(Boolean).join(' ') ||
body.contact?.name ||
'';

console.log(`[INBOUND SMS] From: ${clientPhone} | Message: "${incomingMessage}"`);

if (isCancellation(incomingMessage)) {
console.log('[CANCELLATION DETECTED] Alerting Slack...');
await alertSlack(
`:warning: *CANCELLATION — ${who(clientName, clientPhone)}*\n` +
`*To do:* cancel in Boulevard and free the slot.\n` +
`Their message: "${incomingMessage}"`
);
}

// Recovery upsell YES intercept — short-circuits Maya for this reply only
if (isRecoveryYes(clientPhone, incomingMessage)) {
console.log('[RECOVERY YES] Client opted in — alerting Slack');
await alertSlack(`:muscle: *RECOVERY ADD-ON — ${who(clientName, clientPhone)}*\n*To do:* check availability and text them to confirm the service + time.`);
const recoveryReply = `Great — someone from our team will reach out shortly to confirm availability and get that set up for you.`;
await sendGhlSms(clientPhone, recoveryReply);
await postConversation(clientName, clientPhone, incomingMessage, recoveryReply);
recoveryUpsellSent.delete(clientPhone);
return;
}

const mayaReply = await getMayaResponse(clientPhone, incomingMessage);
const isBookingRequest = mayaReply.includes('BOOKING_REQUEST');
if (mayaReply.includes('THERAPIST_REQUESTED')) therapistRequestedBy.add(clientPhone);

const cleanReply = mayaReply
.replace(/THERAPIST_REQUESTED/g, '')
.replace(/BOOKING_REQUEST/g, '')
.trim();
console.log(`[MAYA REPLY] → "${cleanReply}"`);

await sendGhlSms(clientPhone, cleanReply);
console.log(`[SMS SENT] To: ${clientPhone}`);
await postConversation(clientName, clientPhone, incomingMessage, cleanReply);

const history = conversations.get(clientPhone) || [];
const addons = detectAddOns(history);
if (addons.length > 0) {
const contactRes = await fetch(
`https://services.leadconnectorhq.com/contacts/?locationId=${CONFIG.ghlLocationId}&query=${encodeURIComponent(clientPhone)}`,
{ headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, Version: '2021-04-15' } }
);
if (contactRes.ok) {
const contactData = await contactRes.json();
const contactId = contactData?.contacts?.[0]?.id || null;
await writeAddOnsToContact(contactId, addons);
}
}

// Hand-off: client gave a day/time → alert the front desk in Slack
if (isBookingRequest) {
await alertBookingRequest(clientName, clientPhone, addons, therapistRequestedBy.has(clientPhone));
therapistRequestedBy.delete(clientPhone);
}

} catch (err) {
console.error('[ERROR]', err.message);
await alertSlack(`:rotating_light: *Maya error* — a client text may not have been answered.\n${err.message}`);
}
});

// ----------------------------------------------------------------------------
// MISSED CALL ALERT
// Fires from the GHL "Recipe - Auto Missed Call Text-Back" workflow
// (Webhook action, after "SMS to Lead").
// ----------------------------------------------------------------------------
app.post('/missed-call', async (req, res) => {
res.status(200).json({ received: true });
try {
const body = req.body || {};
const phone = body.phone || body.contact?.phone || body.from || 'unknown number';
const name =
body.full_name ||
[body.first_name, body.last_name].filter(Boolean).join(' ') ||
'';
await alertSlack(
`:telephone_receiver: *MISSED CALL — ${who(name, phone)}*\n` +
`Maya texted them. Their replies will show up here.`
);
} catch (err) {
console.error('[MISSED CALL] Failed:', err.message);
}
});

// ----------------------------------------------------------------------------
// POST-BOOKING: Intake form + cancellation policy + recovery upsell
// (Fires from GHL "Appointment Booked" workflow. Dormant while Boulevard
// is the live calendar — kept intact for the GHL cutover.)
// ----------------------------------------------------------------------------

// Track phones that have been sent a recovery upsell (in-memory, resets on restart)
const recoveryUpsellSent = new Set();

function getRecoveryUpsell(concern) {
const c = (concern || '').toLowerCase();
if (c.includes('neck') || c.includes('shoulder') || c.includes('tension') || c.includes('back') || c.includes('pain') || c.includes('muscle')) {
return `One more thing — many clients with muscle tension love pairing their massage with infrared sauna beforehand. The heat loosens tissue so your therapist can work deeper. It's $40 for 20 min. Reply YES if you'd like us to check availability around your appointment.`;
}
if (c.includes('sport') || c.includes('recover') || c.includes('athletic') || c.includes('workout')) {
return `One more thing — for recovery-focused sessions, compression therapy pairs really well with massage. It flushes soreness and accelerates muscle repair. 30 min is $40. Reply YES if you'd like us to check availability around your appointment.`;
}
if (c.includes('stress') || c.includes('relax')) {
return `One more thing — float therapy is the ultimate complement to a relaxation massage. 60 minutes of complete sensory rest — it takes the experience to a different level. From $95. Reply YES if you'd like us to check availability around your appointment.`;
}
return `One more thing — many of our clients add a recovery experience before or after their session — sauna, float, cold plunge, and more. Reply YES if you'd like us to check what's available around your appointment time.`;
}

app.post('/sms/post-booking', async (req, res) => {
res.sendStatus(200);
try {
const body = req.body;
const clientPhone = body.phone || body.contact?.phone;
const firstName = body.first_name || body.firstName || body.contact?.firstName || '';
const apptTime = body.appointment_t || body.appointmentTime || body.startTime || '';
const concern = body.concern || body.sessionType || '';
if (!clientPhone) return;

let timeStr = '';
if (apptTime) {
try {
timeStr = new Date(apptTime).toLocaleString('en-US', {
weekday: 'short', month: 'long', day: 'numeric',
hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
});
} catch (_) { timeStr = apptTime; }
}

const namePart = firstName ? `${firstName}, ` : '';
const timePart = timeStr ? ` on ${timeStr}` : '';
const INTAKE_URL = `${CONFIG.linksBaseUrl}/intake`;

// MSG 1 — confirmation + intake form
await sendGhlSms(clientPhone, `${namePart}you're all set${timePart}. Before you come in, please fill out your intake form — it helps your therapist prepare: ${INTAKE_URL}`);
await new Promise(r => setTimeout(r, 1500));

// MSG 2 — cancellation policy
await sendGhlSms(clientPhone, `A quick note on our cancellation policy: 24 hours notice is required for any cancellations or changes. Less than 24 hours incurs a 50% charge. 6 hours or less incurs a 100% charge. To cancel or reschedule, call 203-304-1313.`);
await new Promise(r => setTimeout(r, 1500));

// MSG 3 — recovery upsell
const upsellMsg = getRecoveryUpsell(concern);
await sendGhlSms(clientPhone, upsellMsg);
recoveryUpsellSent.add(clientPhone);

await alertSlack(`[Maya] :clipboard: Post-booking SMS sent → ${clientPhone}${timePart}`);
console.log(`[POST-BOOKING] SMS sent to ${clientPhone}`);
} catch (err) {
console.error('[POST-BOOKING ERROR]', err.message);
}
});

// RECOVERY UPSELL YES HANDLER — fires when client replies YES after post-booking
// Detected in /sms/inbound before Maya processes it
function isRecoveryYes(phone, message) {
if (!recoveryUpsellSent.has(phone)) return false;
const m = message.toLowerCase().trim();
return m === 'yes' || m === 'yes please' || m === 'yeah' || m === 'yep' || m === 'sure' || m === 'definitely';
}

// ----------------------------------------------------------------------------
// INTAKE FORM SUBMISSION
app.post('/intake/submit', async (req, res) => {
res.sendStatus(200);
try {
const d = req.body;
const contactId = d.contactId || null;
const phone = d.phone || null;

// Build GHL note
const notes = [
'MASSAGE INTAKE FORM',
`Submitted: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
'',
`DOB: ${d.dob || 'n/a'}`,
`Address: ${[d.address, d.city, d.zip].filter(Boolean).join(', ')}`,
`Minor: ${d.isMinor || 'n/a'}`,
'',
`MEDICATIONS: ${d.medications || 'n/a'}`,
d.medicationsDetail ? `Detail: ${d.medicationsDetail}` : null,
'',
`PREGNANT: ${d.pregnant || 'n/a'}`,
d.pregnantWeeks ? `Weeks: ${d.pregnantWeeks}` : null,
d.pregnantRiskFactors ? `Risk: ${d.pregnantRiskFactors}` : null,
'',
`CHRONIC PAIN: ${d.chronicPain || 'none'}`,
d.painFactors ? `Factors: ${d.painFactors}` : null,
d.injuries ? `Injuries: ${d.injuries}` : null,
'',
`CONDITIONS: ${d.conditions || 'None'}`,
d.conditionsDetail ? `Detail: ${d.conditionsDetail}` : null,
'',
`FRAGRANCE ALLERGIES: ${d.fragranceAllergies || 'none'}`,
'',
`PREVIOUS MASSAGE: ${d.previousMassage || 'n/a'}`,
`MASSAGE TYPE SEEKING: ${d.massageType || 'n/a'}`,
`PRESSURE PREFERENCE: ${d.pressure || 'n/a'}`,
`SESSION GOALS: ${d.sessionGoals || 'n/a'}`,
`PROMOTIONS OPT-IN: ${d.promotions || 'n/a'}`,
'',
'AGREED TO POLICIES: Yes',
].filter(l => l !== null).join('\n');

if (contactId) {
try {
await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
method: 'POST',
headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
body: JSON.stringify({ body: notes, userId: contactId }),
});
await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
method: 'PUT',
headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
body: JSON.stringify({
firstName: d.firstName, lastName: d.lastName,
email: d.email, phone: d.phone,
address1: d.address, city: d.city, postalCode: d.zip,
dateOfBirth: d.dob, tags: ['Intake Form Completed'],
}),
});
} catch (err) { console.error('[INTAKE] GHL write error:', err.message); }
}
await alertSlack(`[Maya] :clipboard: Intake submitted\n${d.firstName} ${d.lastName} (${phone})\nConditions: ${d.conditions || 'none'}`);
console.log(`[INTAKE] Submitted for ${d.firstName} ${d.lastName}`);
} catch (err) { console.error('[INTAKE ERROR]', err.message); }
});

// PREFERENCES FORM SUBMISSION
app.post('/preferences/submit', async (req, res) => {
res.sendStatus(200);
try {
const d = req.body;
const contactId = d.contactId || null;
const notes = [
'MASSAGE PREFERENCES',
`Submitted: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
'',
`STANDARDS: ${d.standards || 'not selected'}`,
`CONVERSATION: ${d.conversation || 'not answered'}`,
`ADD-ONS REQUESTED: ${d.addons || 'none'}`,
].join('\n');
if (contactId) {
try {
await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
method: 'POST',
headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
body: JSON.stringify({ body: notes, userId: contactId }),
});
// Also write add-ons to the Maya add-ons custom field if present
if (d.addons && d.addons !== 'No Thank You') {
await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
method: 'PUT',
headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-07-28' },
body: JSON.stringify({ customFields: [{ id: '8EOok3x105CyQIIJyMtx', value: d.addons }] }),
});
}
} catch (err) { console.error('[PREFS] GHL write error:', err.message); }
}
await alertSlack(`[Maya] :memo: Preferences submitted\n${d.firstName || 'Client'}\nStandards: ${d.standards || 'none'}\nConversation: ${d.conversation || 'n/a'}\nAdd-ons: ${d.addons || 'none'}`);
console.log('[PREFS] Submitted');
} catch (err) { console.error('[PREFS ERROR]', err.message); }
});

// FORM PAGES
app.get('/intake', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'intake.html')); });
app.get('/preferences', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'preferences.html')); });

// HEALTH CHECK
// ----------------------------------------------------------------------------
app.get('/health', (req, res) => {
res.json({
status: 'ok',
agent: CONFIG.agentName,
client: CONFIG.businessName,
linksBaseUrl: CONFIG.linksBaseUrl,
timestamp: new Date().toISOString(),
});
});

// ----------------------------------------------------------------------------
// START
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log(`\n✓ Sova SMS Server running on port ${PORT}`);
console.log(` Agent: ${CONFIG.agentName}`);
console.log(` Client: ${CONFIG.businessName}`);
console.log(` Links: ${CONFIG.linksBaseUrl}`);
console.log(` Webhook: POST /sms/inbound`);
console.log(` Health: GET /health\n`);
});
