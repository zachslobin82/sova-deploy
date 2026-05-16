// ============================================================================
// Sova SMS Server — Maya AI Text Receptionist
// TMW (Therapeutic Massage & Wellness, Newtown CT)
//
// Architecture:
// GHL Workflow → POST /sms/inbound  (also /sms-inbound for backwards compat)
//             → GPT-4.1 processes with full TMW knowledge base
//             → GHL API sends SMS reply to client
//             → Cancellations also fire SMS alert to Carolyn
//
// Retell Voice Agent → POST /create-ghl-booking
//             → Creates appointment in GHL Calendars API
//             → Returns success/failure JSON to Retell
//
// Run: node sms-server.js
// ============================================================================

const express = require('express');
const axios   = require('axios');
const path    = require('path');
const app     = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------
const CONFIG = {
  openAiApiKey:   process.env.OPENAI_API_KEY,
  ghlBearerToken: process.env.GHL_BEARER_TOKEN,
  ghlLocationId:  'i354kGTSmTlt3zeEVsCG',
  ghlFromNumber:  '+18605904699',
  carolynCell:    '+18456121174',
  businessName:   'Therapeutic Massage & Wellness',
  agentName:      'Maya',
  mainPhone:      '203-304-1313',
};

if (!CONFIG.openAiApiKey)   console.warn('[WARN] OPENAI_API_KEY not set');
if (!CONFIG.ghlBearerToken) console.warn('[WARN] GHL_BEARER_TOKEN not set');

const SLACK_HOOK     = process.env.SLACK_WEBHOOK_URL || '';
const ADDON_FIELD_ID = '8EOok3x105CyQIIJyMtx';

// GHL booking widget links (sent to client via SMS)
const BOOKING_LINKS = {
  25:  'https://api.gohighlevel.com/widget/booking/uBLikuiy9gCI2MDItdz5',
  55:  'https://api.gohighlevel.com/widget/booking/HFlTUh76tUn01FHsf9Hi',
  85:  'https://api.gohighlevel.com/widget/booking/GDhkZy8h9CtjAOPPKlgR',
  110: 'https://api.gohighlevel.com/widget/booking/tFKqGwFxE5Ka5626we5X',
};

const FACIAL_BOOKING_LINKS = {
  25: 'https://api.gohighlevel.com/widget/booking/fluYr7ftpZxYb2u279nW',
  55: 'https://api.gohighlevel.com/widget/booking/CKyiFGAukBqYL4DH7hoi',
  85: 'https://api.gohighlevel.com/widget/booking/WU8aIw5r3MjedkLd9BB8',
};

// ----------------------------------------------------------------------------
// CONVERSATION HISTORY (GPT-4.1 multi-turn)
// ----------------------------------------------------------------------------
const conversations = new Map();
function getHistory(phone) { if (!conversations.has(phone)) conversations.set(phone, []); return conversations.get(phone); }
function addToHistory(phone, role, content) { const h = getHistory(phone); h.push({ role, content }); if (h.length > 20) h.splice(0, h.length - 20); }

// ----------------------------------------------------------------------------
// FLOW STATE (SMS booking flow stages)
// ----------------------------------------------------------------------------
const flowState = {};

// ----------------------------------------------------------------------------
// MAYA SYSTEM PROMPT
// ----------------------------------------------------------------------------
function buildSystemPrompt(state) {
  const base = `You are Maya, the AI receptionist for Therapeutic Massage & Wellness (TMW) in Newtown and Danbury, CT.

TONE — non-negotiable:
- No exclamation points. Ever.
- No filler: no "Absolutely", "Of course", "Great", "Sure thing", "Certainly", "Happy to", "Sounds good".
- Warm, composed, brief. Like a trusted front desk person who respects the client's time.
- 1–3 sentences per reply unless listing options.
- Never mention Boulevard. Never send Boulevard links.

BUSINESS INFO:
- Address: 32 Church Hill Road, Newtown CT 06470 (also Danbury location)
- Phone: 203-304-1313
- Hours: Mon–Thu 9am–8pm, Fri–Sat 9am–4pm, Sun 10am–4pm
- Website: tmwmassage.net

SERVICES & PRICING:
Massage: 25-min $65, 55-min $110, 85-min $160, 110-min $200
Enhancements: Hot Stone $20, Aromatherapy $15, CBD Oil $15, Cupping $20, Scalp Treatment $15
Facials: Express $75, TMW Glow $110, Ultra Radiance $140, Gentlemen's $95, Teen $65, Back Facial $85
Recovery: Infrared Sauna 30min $35/45min $45, Cold Plunge $25, Float 60min $75/90min $95, Red Light $35, Compression $35, Contrast Therapy $50
Couples: same pricing plus $20–30 room fee
Brow & Lash: redirect to phone 203-304-1313

CANCELLATION POLICY:
- Under $250: 24-hour notice
- $250–$499: 48-hour notice, 50% deposit at booking
- $500+: full payment 7 days prior, non-refundable
- No-show: 100% charge

FACIALS (performed by Julia & Rebecca):
Active Clearing $150/55min $225/85min | Anti-Aging $150/55min $225/85min | Lymphatic $160/55min $225/85min | Gentleman's $150/55min $220/85min | Ultra Radiance $130/55min | Back Facial $80/25min $160/55min $225/85min

REDIRECT: Brow/Lash, Couples booking, medical questions → phone 203-304-1313.

FAQ:
- Hours: Mon–Thu 9am–8pm, Fri–Sat 9am–4pm, Sun 10am–4pm
- Location: 32 Church Hill Road, Newtown CT 06470
- Unknown: "Give us a call at 203-304-1313 — the team can help directly."`;

  if (!state) return base;

  return `${base}

CURRENT FLOW STAGE: ${state.stage}
SERVICE: ${state.service || 'not yet determined'}
DURATION: ${state.duration || 'not yet determined'}
ADD-ON: ${state.addOnChosen || 'none yet'}
CONTEXT: ${state.context || 'first contact'}

FLOW INSTRUCTIONS:
reason  → Recommend a specific session based on their goal. Soft-downsell if appropriate. End with a confirming question.
addon   → Offer ONE add-on: pain/tension → Hot Stone ($20), relaxation/stress → Aromatherapy ($15).
sauna   → Only if they said YES to add-on. Briefly offer infrared sauna.
booking → One warm closing sentence only. Do NOT include a URL — server sends it.
done    → Answer follow-up questions helpfully. Do not restart booking flow unless client explicitly asks.
facial  → Recommend a facial based on skin concern. Do not include URL — server sends it.

CANCELLATION: Acknowledge warmly, immediately offer to rebook. "Before you go, can I help you find another time?"

Respond ONLY with Maya's next SMS. No labels, no quotes, no preamble.`;
}

// ----------------------------------------------------------------------------
// GPT-4.1 CALL
// ----------------------------------------------------------------------------
async function getMayaResponse(clientPhone, incomingMessage, state) {
  addToHistory(clientPhone, 'user', incomingMessage);
  const history = getHistory(clientPhone);
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CONFIG.openAiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4.1', max_tokens: 300, messages: [{ role: 'system', content: buildSystemPrompt(state || null) }, ...history] }),
  });
  if (!response.ok) { const err = await response.text(); throw new Error(`OpenAI error: ${response.status} — ${err}`); }
  const data  = await response.json();
  const reply = data.choices[0].message.content.trim();
  addToHistory(clientPhone, 'assistant', reply);
  return reply;
}

// ----------------------------------------------------------------------------
// GHL HELPERS
// ----------------------------------------------------------------------------
function ghlHeaders(version) {
  return { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: version || '2021-04-15' };
}

async function sendSMS(toPhone, message) {
  try {
    const res = await axios.post(
      'https://services.leadconnectorhq.com/conversations/messages',
      { type: 'SMS', message, contactPhone: toPhone, fromNumber: CONFIG.ghlFromNumber, locationId: CONFIG.ghlLocationId },
      { headers: ghlHeaders() }
    );
    console.log(`[SMS SENT] to=${toPhone} status=${res.status}`);
    return res.data;
  } catch (err) { console.error('[SMS ERROR]', err?.response?.data || err.message); throw err; }
}

async function getContactByPhone(phone) {
  const digits     = phone.replace(/\D/g, '');
  const normalized = digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
  try {
    const res = await axios.get(
      `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${CONFIG.ghlLocationId}&phone=${encodeURIComponent(normalized)}`,
      { headers: ghlHeaders() }
    );
    return res.data?.contact || null;
  } catch (err) { console.error('[CONTACT LOOKUP]', err?.response?.data || err.message); return null; }
}

async function writeAddonField(contactId, value) {
  try {
    await axios.put(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      { customFields: [{ id: ADDON_FIELD_ID, field_value: value }] },
      { headers: ghlHeaders() }
    );
    console.log(`[ADDON WRITTEN] contactId=${contactId} value="${value}"`);
  } catch (err) { console.error('[ADDON WRITE]', err?.response?.data || err.message); }
}

async function slackAlert(msg) {
  if (!SLACK_HOOK) return;
  try { await axios.post(SLACK_HOOK, { text: msg }); } catch (_) {}
}

async function carolynAlert(msg) {
  try { await sendSMS(CONFIG.carolynCell, msg); } catch (_) {}
}

// ----------------------------------------------------------------------------
// FLOW HELPERS
// ----------------------------------------------------------------------------
function resolveBookingLink(duration, serviceStr) {
  const d = parseInt(duration, 10);
  if ([25, 55, 85, 110].includes(d)) return BOOKING_LINKS[d];
  const s = (serviceStr || '').toLowerCase();
  if (s.includes('110')) return BOOKING_LINKS[110];
  if (s.includes('85'))  return BOOKING_LINKS[85];
  if (s.includes('25'))  return BOOKING_LINKS[25];
  return BOOKING_LINKS[55];
}

function extractDuration(text) {
  const m = text.match(/\b(25|55|85|110)\s*[-–]?\s*min/i) || text.match(/\b(25|55|85|110)\b/);
  if (m) return parseInt(m[1], 10);
  if (/\bhour\b|60\s*min/i.test(text)) return 55;
  if (/hour\s*and\s*a?\s*half|90\s*min/i.test(text)) return 85;
  return null;
}

function isCancellation(text) {
  return /cancel|cancell|reschedule|can't make it|cant make it|wont be able|won't be able|want to cancel|need to cancel|have to cancel|unable to make|can't come|need to move|move my appointment|change my appointment/i.test(text);
}

function isRebookAcceptance(text) {
  return /\byes\b|yeah|sure|ok\b|okay|sounds good|please|let's do|book|rebook|find a time|new time|different time/i.test(text);
}

function isFacialInquiry(text) {
  return /facial|skin care|esthetician|peel|glow|clearing|anti.aging|radiance|gentleman.s facial|back facial/i.test(text);
}

function advanceStage(stage, text) {
  const yes = /\byes\b|yeah|sure|definitely|sounds good|ok\b|okay|please|add that|let's do|do it|go ahead|why not/i.test(text);
  const no  = /\bno\b|not (right now|today|yet)|pass|skip|just the|without|no thanks|nah/i.test(text);
  switch (stage) {
    case 'reason': return 'addon';
    case 'addon':  return yes ? 'sauna' : no ? 'booking' : 'addon';
    case 'sauna':  return 'booking';
    default:       return 'done';
  }
}

// ----------------------------------------------------------------------------
// ROUTE: POST /create-ghl-booking  (Retell voice agent)
// ----------------------------------------------------------------------------
app.post('/create-ghl-booking', async (req, res) => {
  console.log('\n[BOOKING REQUEST]', JSON.stringify(req.body, null, 2));
  const { calendarId, locationId, startTime, endTime, firstName, lastName, email, phone, title } = req.body;
  const missing = [];
  if (!calendarId) missing.push('calendarId');
  if (!startTime)  missing.push('startTime');
  if (!endTime)    missing.push('endTime');
  if (missing.length) return res.status(400).json({ success: false, error: `Missing: ${missing.join(', ')}` });

  const resolvedLocation = locationId || CONFIG.ghlLocationId;
  let contactId = null;

  // Find or create contact
  try {
    if (phone) {
      const sr = await fetch(
        `https://services.leadconnectorhq.com/contacts/search/phone?phone=${encodeURIComponent(phone)}&locationId=${resolvedLocation}`,
        { headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, Version: '2021-04-15' } }
      );
      if (sr.ok) { const d = await sr.json(); contactId = d?.contacts?.[0]?.id || null; }
    }
    if (!contactId) {
      const cr = await fetch('https://services.leadconnectorhq.com/contacts/', {
        method: 'POST',
        headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-07-28' },
        body: JSON.stringify({ locationId: resolvedLocation, firstName: firstName||'', lastName: lastName||'', email: email||'', phone: phone||'' }),
      });
      if (!cr.ok) { const e = await cr.text(); throw new Error(`Contact create failed: ${cr.status} — ${e}`); }
      const cd = await cr.json(); contactId = cd?.contact?.id || null;
    }
  } catch (err) { console.error('[BOOKING] Contact error:', err.message); }

  // Create appointment
  try {
    const ar = await fetch('https://services.leadconnectorhq.com/calendars/events/appointments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
      body: JSON.stringify({ calendarId, locationId: resolvedLocation, contactId, startTime, endTime, title: title || `${firstName} ${lastName} - Massage`, appointmentStatus: 'confirmed', ignoreDateRange: false, toNotify: true }),
    });
    if (!ar.ok) { const e = await ar.text(); throw new Error(`Appointment create failed: ${ar.status} — ${e}`); }
    const result        = await ar.json();
    const appointmentId = result?.id || result?.appointment?.id || 'unknown';
    console.log(`[BOOKING SUCCESS] ID: ${appointmentId}`);

    // Post-booking SMS
    if (phone) {
      try {
        let timeStr = '';
        try { timeStr = new Date(startTime).toLocaleString('en-US', { weekday: 'short', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); } catch (_) { timeStr = startTime; }
        const intakeUrl = `https://sova-deploy-production.up.railway.app/intake${contactId ? `?contactId=${contactId}&firstName=${encodeURIComponent(firstName||'')}&phone=${encodeURIComponent(phone)}` : ''}`;
        await sendSMS(phone, `${firstName}, you're all set on ${timeStr}. Before you come in, please fill out your intake form — it helps your therapist prepare: ${intakeUrl}`);
        await new Promise(r => setTimeout(r, 1500));
        await sendSMS(phone, `A quick note on our cancellation policy: 24 hours notice is required for any cancellations or changes. Less than 24 hours incurs a 50% charge. 6 hours or less incurs a 100% charge. Couples and parties of 2–4 require 48 hours notice. To cancel or reschedule, call 203-304-1313. We look forward to seeing you.`);
        await slackAlert(`[Maya] :phone: Voice booking\n${firstName} ${lastName} (${phone})\n${timeStr}\nAppt ID: ${appointmentId}`);
      } catch (smsErr) { console.error('[BOOKING] Post-SMS error:', smsErr.message); }
    }

    return res.status(200).json({ success: true, appointmentId, message: `Confirmed for ${firstName} ${lastName}` });
  } catch (err) {
    console.error('[BOOKING ERROR]', err.message);
    await slackAlert(`[Maya] :x: Voice booking FAILED\n${firstName} ${lastName} (${phone})\nError: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// ROUTE: POST /sms/inbound + /sms-inbound  (GHL workflow webhook)
// ----------------------------------------------------------------------------
async function handleInboundSMS(req, res) {
  res.sendStatus(200);
  const body         = req.body;
  const clientPhone  = body.phone || body.From || body.clientPhone || body.contact?.phone;
  const incomingText = (body.message || body.Body || body.text || '').trim();
  let contactId      = body.contactId || body.contact?.id || null;

  if (!clientPhone || !incomingText) return;
  if (!contactId) { const c = await getContactByPhone(clientPhone); contactId = c?.id || null; }

  const key = contactId || clientPhone;

  // Cancellation
  if (isCancellation(incomingText)) {
    await carolynAlert(`[Maya] Cancellation from ${clientPhone}: "${incomingText}"`);
    await slackAlert(`[Maya] :warning: Cancellation\nFrom: ${clientPhone}\nMsg: "${incomingText}"`);
    if (contactId) {
      try { await axios.post(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, { tags: ['Cancelled - Needs Rebook'] }, { headers: ghlHeaders() }); } catch (_) {}
    }
    await sendSMS(clientPhone, "Got it — I've let the team know. Before you go, can I help you find another time that works? A lot of clients find it easier to rebook now so you don't lose your spot.");
    flowState[key] = { stage: 'rebook', service: null, duration: null, addOnChosen: null, context: 'cancelled', contactId };
    return;
  }

  // Rebook stage
  const existing = flowState[key];
  if (existing?.stage === 'rebook') {
    if (isRebookAcceptance(incomingText)) {
      await sendSMS(clientPhone, "Here is the link to grab a new time that works for you.");
      await new Promise(r => setTimeout(r, 800));
      await sendSMS(clientPhone, BOOKING_LINKS[55]);
      existing.stage = 'done';
      await slackAlert(`[Maya] :recycle: Cancel → rebook ${clientPhone}`);
    } else {
      await sendSMS(clientPhone, "No problem — whenever you're ready, book at tmwmassage.net or text us here.");
      existing.stage = 'done';
    }
    return;
  }

  // Facial inquiry
  if (isFacialInquiry(incomingText) && (!flowState[key] || flowState[key].stage === 'reason')) {
    try {
      const facialReply = await getMayaResponse(clientPhone, incomingText, { stage: 'facial', service: 'facial', duration: null, context: incomingText });
      if (facialReply) await sendSMS(clientPhone, facialReply);
    } catch (_) {}
    await new Promise(r => setTimeout(r, 900));
    await sendSMS(clientPhone, FACIAL_BOOKING_LINKS[55]);
    flowState[key] = { stage: 'done', service: 'facial', duration: null, contactId, context: incomingText };
    await slackAlert(`[Maya] :sparkles: Facial → booking link ${clientPhone}`);
    return;
  }

  // Init flow state
  if (!flowState[key]) {
    flowState[key] = { stage: 'reason', service: null, duration: null, addOnChosen: null, context: 'first contact', contactId };
  } else if (!flowState[key].contactId && contactId) {
    flowState[key].contactId = contactId;
  }

  const state = flowState[key];

  // Done — open Q&A
  if (state.stage === 'done') {
    try { const r = await getMayaResponse(clientPhone, incomingText, state); if (r) await sendSMS(clientPhone, r); } catch (err) { console.error('[MAYA]', err.message); }
    return;
  }

  // Extract duration
  const detected = extractDuration(incomingText);
  if (detected) state.duration = detected;

  // Get Maya reply
  let mayaReply = '';
  try { mayaReply = await getMayaResponse(clientPhone, incomingText, state); } catch (err) { console.error('[MAYA]', err.message); }

  const nextStage = advanceStage(state.stage, incomingText);

  // Add-on logic
  if (state.stage === 'addon') {
    const yes = /\byes\b|yeah|sure|sounds good|ok\b|okay|please|add that|let's do|go ahead/i.test(incomingText);
    const no  = /\bno\b|not (right now|today)|pass|skip|without|no thanks|nah/i.test(incomingText);
    if (yes && contactId) {
      const isRelax     = /relax|aroma|stress|calm|anxiety/i.test(state.service || incomingText);
      const label       = isRelax ? 'Aromatherapy ($15)' : 'Hot Stone Upgrade ($20)';
      state.addOnChosen = label;
      await writeAddonField(contactId, label);
    } else if (no) {
      state.addOnChosen = 'declined';
    }
  }

  if (mayaReply) await sendSMS(clientPhone, mayaReply);
  state.stage = nextStage;

  // Send booking link
  if (state.stage === 'booking') {
    await new Promise(r => setTimeout(r, 900));
    await sendSMS(clientPhone, resolveBookingLink(state.duration, state.service));
    state.stage = 'done';
    await slackAlert(`[Maya] :calendar: Booking link sent\n${clientPhone}\nDuration: ${state.duration || 'unknown'}\nAdd-on: ${state.addOnChosen || 'none'}`);
  }

  state.context = incomingText.substring(0, 100);
}

app.post('/sms/inbound', handleInboundSMS);  // primary
app.post('/sms-inbound', handleInboundSMS);  // backwards compat

// ----------------------------------------------------------------------------
// ROUTE: POST /sms/post-booking  (GHL: Appointment Created → webhook)
// ----------------------------------------------------------------------------
app.post('/sms/post-booking', async (req, res) => {
  res.sendStatus(200);
  const body        = req.body;
  const clientPhone = body.phone || body.contact?.phone;
  const firstName   = body.firstName || body.contact?.firstName || '';
  const contactId   = body.contactId || body.contact?.id || null;
  const apptTime    = body.appointmentTime || body.startTime || '';
  if (!clientPhone) return;
  let timeStr = '';
  if (apptTime) { try { timeStr = new Date(apptTime).toLocaleString('en-US', { weekday: 'short', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); } catch (_) { timeStr = apptTime; } }
  const intakeUrl = `https://sova-deploy-production.up.railway.app/intake${contactId ? `?contactId=${contactId}&firstName=${encodeURIComponent(firstName)}&phone=${encodeURIComponent(clientPhone)}` : ''}`;
  await sendSMS(clientPhone, `${firstName ? firstName + ', ' : ''}you're all set${timeStr ? ' on ' + timeStr : ''}. Before you come in, please fill out your intake form — it helps your therapist prepare: ${intakeUrl}`);
  await new Promise(r => setTimeout(r, 1500));
  await sendSMS(clientPhone, `A quick note on our cancellation policy: 24 hours notice is required for any cancellations or changes. Less than 24 hours incurs a 50% charge. 6 hours or less incurs a 100% charge. Couples and parties of 2–4 require 48 hours notice. To cancel or reschedule, call 203-304-1313. We look forward to seeing you.`);
  await slackAlert(`[Maya] :white_check_mark: Post-booking SMS → ${clientPhone}${timeStr ? ' on ' + timeStr : ''}`);
});

// ----------------------------------------------------------------------------
// ROUTE: /intake
// ----------------------------------------------------------------------------
app.get('/intake', (req, res) => { res.sendFile(path.join(__dirname, 'intake-form.html')); });

app.post('/intake/submit', async (req, res) => {
  res.sendStatus(200);
  const d = req.body;
  let contactId = d.contactId || null;
  if (!contactId && d.phone) { const c = await getContactByPhone(d.phone); contactId = c?.id || null; }
  if (!contactId) { await slackAlert(`[Intake] No contact match\nPhone: ${d.phone}\nName: ${d.firstName} ${d.lastName}`); return; }
  const notes = [
    'MASSAGE INTAKE FORM',
    `Submitted: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
    '',
    `DOB: ${d.dob || 'n/a'}`,
    `Address: ${[d.address, d.city, d.state, d.zip].filter(Boolean).join(', ')}`,
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
    'AGREED TO POLICIES: Yes',
  ].filter(l => l !== null).join('\n');
  try { await axios.post(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, { body: notes, userId: contactId }, { headers: ghlHeaders() }); }
  catch (err) { console.error('[INTAKE NOTE]', err?.response?.data || err.message); }
  try {
    await axios.put(`https://services.leadconnectorhq.com/contacts/${contactId}`,
      { firstName: d.firstName, lastName: d.lastName, email: d.email, phone: d.phone, address1: d.address, city: d.city, state: d.state, postalCode: d.zip, dateOfBirth: d.dob, tags: ['Intake Form Completed'] },
      { headers: ghlHeaders() });
  } catch (err) { console.error('[INTAKE UPDATE]', err?.response?.data || err.message); }
  await slackAlert(`[Maya] :clipboard: Intake submitted\n${d.firstName} ${d.lastName} (${d.phone})\nConditions: ${d.conditions || 'none'}`);
});

// ----------------------------------------------------------------------------
// ROUTE: /preferences
// ----------------------------------------------------------------------------
app.get('/preferences', (req, res) => { res.sendFile(path.join(__dirname, 'preferences-form.html')); });

app.post('/preferences/submit', async (req, res) => {
  res.sendStatus(200);
  const d = req.body;
  let contactId = d.contactId || null;
  if (!contactId && d.phone) { const c = await getContactByPhone(d.phone); contactId = c?.id || null; }
  if (!contactId) { await slackAlert(`[Prefs] No contact match\nPhone: ${d.phone}\nName: ${d.firstName} ${d.lastName}`); return; }
  const notes = ['MASSAGE PREFERENCES', `Submitted: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`, '', `STANDARDS: ${d.standards || 'not selected'}`, `CONVERSATION: ${d.conversation || 'not answered'}`, `RELAXATION EXPERIENCE: ${d.relaxation || 'not answered'}`].join('\n');
  try { await axios.post(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, { body: notes, userId: contactId }, { headers: ghlHeaders() }); }
  catch (err) { console.error('[PREFS NOTE]', err?.response?.data || err.message); }
  await slackAlert(`[Maya] :memo: Preferences submitted\n${d.firstName} ${d.lastName}\nStandards: ${d.standards || 'none'}\nConversation: ${d.conversation}`);
});

// ----------------------------------------------------------------------------
// ROUTE: /upgrade
// ----------------------------------------------------------------------------
app.get('/upgrade', (req, res) => { res.sendFile(path.join(__dirname, 'upgrade-form.html')); });

app.post('/upgrade/submit', async (req, res) => {
  res.sendStatus(200);
  const d = req.body;
  let contactId = d.contactId || null;
  if (!contactId && d.phone) { const c = await getContactByPhone(d.phone); contactId = c?.id || null; }
  if (!contactId) { await slackAlert(`[Upgrade] No contact match\nPhone: ${d.phone}\nName: ${d.firstName} ${d.lastName}`); return; }
  const notes = ['SESSION UPGRADES', `Submitted: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`, '', `ADD-ONS: ${d.addons || 'none selected'}`, `RELAXATION EXPERIENCE: ${d.relaxation || 'not answered'}`].join('\n');
  try {
    await axios.post(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, { body: notes, userId: contactId }, { headers: ghlHeaders() });
    if (d.addons && d.addons !== 'No Thank You') await writeAddonField(contactId, d.addons);
  } catch (err) { console.error('[UPGRADE NOTE]', err?.response?.data || err.message); }
  await slackAlert(`[Maya] :sparkles: Upgrade submitted\n${d.firstName} ${d.lastName}\nAdd-ons: ${d.addons || 'none'}`);
});

// ----------------------------------------------------------------------------
// HEALTH CHECK
// ----------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'maya-sms-tmw',
    endpoints: ['/sms/inbound', '/sms-inbound', '/sms/post-booking', '/create-ghl-booking', '/intake', '/preferences', '/upgrade'],
    openai: CONFIG.openAiApiKey   ? 'loaded' : 'MISSING',
    ghl:    CONFIG.ghlBearerToken ? 'loaded' : 'MISSING',
    ts:     new Date().toISOString(),
  });
});

// ----------------------------------------------------------------------------
// START
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓ Maya SMS Server running on port ${PORT}`);
  console.log(`  OpenAI:    ${CONFIG.openAiApiKey   ? '✓ loaded' : '✗ MISSING'}`);
  console.log(`  GHL Token: ${CONFIG.ghlBearerToken ? '✓ loaded' : '✗ MISSING'}`);
  console.log(`  Slack:     ${SLACK_HOOK             ? '✓ loaded' : 'not set'}\n`);
});