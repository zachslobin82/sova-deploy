// ============================================================
// MAYA SMS SERVER — TMW (Therapeutic Massage & Wellness)
// Sova Deploy | Railway: brave-charisma 
// ============================================================

const express = require('express');
const axios   = require('axios');
const path    = require('path');
const app     = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const GHL_BEARER   = process.env.GHL_BEARER_TOKEN || 'pit-fb285c5d-a16c-45be-adce-f35d0722bd52';
const GHL_LOCATION = process.env.GHL_LOCATION_ID  || 'i354kGTSmTlt3zeEVsCG';
const FROM_NUMBER  = process.env.GHL_FROM_NUMBER  || '+18605904699';
const SLACK_HOOK   = process.env.SLACK_WEBHOOK_URL || '';
const CAROLYN_CELL = '+18456121174';

const ADDON_FIELD_ID = '8EOok3x105CyQIIJyMtx';

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

const flowState = {};

function ghlHeaders() {
  return { Authorization: `Bearer ${GHL_BEARER}`, 'Content-Type': 'application/json', Version: '2021-04-15' };
}

async function sendSMS(toPhone, message) {
  try {
    const res = await axios.post('https://services.leadconnectorhq.com/conversations/messages',
      { type: 'SMS', message, contactPhone: toPhone, fromNumber: FROM_NUMBER, locationId: GHL_LOCATION },
      { headers: ghlHeaders() });
    console.log(`[SMS SENT] to=${toPhone} status=${res.status}`);
    return res.data;
  } catch (err) { console.error('[SMS ERROR]', err?.response?.data || err.message); throw err; }
}

async function getContactByPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  const normalized = digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
  try {
    const res = await axios.get(
      `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${GHL_LOCATION}&phone=${encodeURIComponent(normalized)}`,
      { headers: ghlHeaders() });
    return res.data?.contact || null;
  } catch (err) { console.error('[CONTACT LOOKUP ERROR]', err?.response?.data || err.message); return null; }
}

async function writeAddonField(contactId, value) {
  try {
    await axios.put(`https://services.leadconnectorhq.com/contacts/${contactId}`,
      { customFields: [{ id: ADDON_FIELD_ID, field_value: value }] },
      { headers: ghlHeaders() });
    console.log(`[ADDON WRITTEN] contactId=${contactId} value="${value}"`);
  } catch (err) { console.error('[ADDON WRITE ERROR]', err?.response?.data || err.message); }
}

async function slackAlert(msg) {
  if (!SLACK_HOOK) return;
  try { await axios.post(SLACK_HOOK, { text: msg }); } catch (_) {}
}

async function carolynAlert(msg) {
  try { await sendSMS(CAROLYN_CELL, msg); } catch (_) {}
}

function resolveBookingLink(service) {
  const s = (service || '').toLowerCase();
  if (s.includes('110')) return BOOKING_LINKS[110];
  if (s.includes('85'))  return BOOKING_LINKS[85];
  if (s.includes('25'))  return BOOKING_LINKS[25];
  return BOOKING_LINKS[55];
}

function buildSystemPrompt(state) {
  return `You are Maya, the AI receptionist for Therapeutic Massage & Wellness (TMW) in Newtown and Danbury, CT.

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

CURRENT FLOW STAGE: ${state.stage}
SERVICE: ${state.service || 'not yet determined'}
ADD-ON: ${state.addOnChosen || 'none yet'}
CONTEXT: ${state.context || 'first contact'}

FLOW:
reason → Recommend specific session + soft downsell. Tailor to goal.
addon  → ONE add-on: pain → Hot Stone $20, relaxation → Aromatherapy $15.
sauna  → Only if YES to add-on. Offer infrared sauna briefly.
booking → Warm closing line only. No URL — server sends it.
done   → Answer follow-up questions helpfully. Never restart booking flow unless explicitly asked.

FACIALS (performed by Julia & Rebecca):
Active Clearing $150/55min $225/85min | Anti-Aging $150/55min $225/85min | Lymphatic $160/55min $225/85min | Gentleman's $150/55min $220/85min | Ultra Radiance $130/55min | Back Facial $80/25min $160/55min $225/85min
For facial inquiries, recommend based on skin concern. Server sends booking link.

CANCELLATION: Acknowledge warmly, immediately offer to rebook. "Before you go, can I help you find another time?"

FAQ:
- Hours: Mon–Thu 9am–8pm, Fri–Sat 9am–4pm, Sun 10am–4pm
- Location: 32 Church Hill Road, Newtown CT 06470
- Phone: 203-304-1313
- Unknown: "Give us a call at 203-304-1313 — the team can help directly."

REDIRECT: Brow/Lash, Couples booking, medical questions → phone.

Respond ONLY with Maya's next SMS. No labels, no quotes.`;
}

function advanceStage(stage, text) {
  const yes = /\byes\b|yeah|sure|definitely|sounds good|ok\b|okay|please|add that|let's do|do it|go ahead|why not/i.test(text);
  const no  = /\bno\b|not (right now|today|yet)|pass|skip|just the|without|no thanks|nah/i.test(text);
  switch (stage) {
    case 'reason': return 'addon';
    case 'addon': return yes ? 'sauna' : no ? 'booking' : 'addon';
    case 'sauna': return 'booking';
    default: return 'done';
  }
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

async function getMayaReply(text, state) {
  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages',
      { model: 'claude-opus-4-5', max_tokens: 300, system: buildSystemPrompt(state), messages: [{ role: 'user', content: text }] },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' } });
    return res.data?.content?.[0]?.text?.trim() || '';
  } catch (err) {
    console.error('[MAYA AI ERROR]', err?.response?.data || err.message);
    return "I'm running into a small issue. Give us a call at 203-304-1313 and we'll get you taken care of.";
  }
}

// Serve intake form
app.get('/intake', (req, res) => { res.sendFile(path.join(__dirname, 'intake-form.html')); });

// Intake form submission
app.post('/intake/submit', async (req, res) => {
  res.sendStatus(200);
  const d = req.body;
  console.log('[INTAKE]', JSON.stringify(d));
  let contactId = d.contactId || null;
  if (!contactId && d.phone) { const c = await getContactByPhone(d.phone); contactId = c?.id || null; }
  if (!contactId) { await slackAlert(`[Intake] No match\nPhone: ${d.phone}\nName: ${d.firstName} ${d.lastName}`); return; }
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
  try {
    await axios.post(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`,
      { body: notes, userId: contactId }, { headers: ghlHeaders() });
  } catch (err) { console.error('[INTAKE NOTE]', err?.response?.data || err.message); }
  try {
    await axios.put(`https://services.leadconnectorhq.com/contacts/${contactId}`,
      { firstName: d.firstName, lastName: d.lastName, email: d.email, phone: d.phone,
        address1: d.address, city: d.city, state: d.state, postalCode: d.zip,
        dateOfBirth: d.dob, tags: ['Intake Form Completed'] },
      { headers: ghlHeaders() });
  } catch (err) { console.error('[INTAKE UPDATE]', err?.response?.data || err.message); }
  await slackAlert(`[Maya] :clipboard: Intake submitted\n${d.firstName} ${d.lastName} (${d.phone})\nConditions: ${d.conditions || 'none'}`);
});

// Inbound SMS
app.post('/sms/inbound', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  const clientPhone  = body.phone || body.From || body.clientPhone || body.contact?.phone;
  const incomingText = (body.message || body.Body || body.text || '').trim();
  let contactId = body.contactId || body.contact?.id || null;
  if (!clientPhone || !incomingText) return;
  if (!contactId) { const c = await getContactByPhone(clientPhone); contactId = c?.id || null; }
  const key = contactId || clientPhone;
  if (isCancellation(incomingText)) {
    await carolynAlert(`[Maya] Cancellation from ${clientPhone}: "${incomingText}"`);
    await slackAlert(`[Maya] :warning: Cancellation\nFrom: ${clientPhone}\nMsg: "${incomingText}"`);
    if (contactId) { try { await axios.post(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, { tags: ['Cancelled - Needs Rebook'] }, { headers: ghlHeaders() }); } catch (_) {} }
    await sendSMS(clientPhone, "Got it — I've let the team know. Before you go, can I help you find another time that works? A lot of clients find it easier to rebook now so you don't lose your spot.");
    flowState[contactId || clientPhone] = { stage: 'rebook', service: null, addOnChosen: null, saunaOffered: false, context: 'cancelled' };
    return;
  }

  // Rebook stage
  const _rs = flowState[contactId || clientPhone];
  if (_rs?.stage === 'rebook') {
    if (isRebookAcceptance(incomingText)) {
      await sendSMS(clientPhone, "Here is the link to grab a new time that works for you.");
      await new Promise(r => setTimeout(r, 800));
      await sendSMS(clientPhone, BOOKING_LINKS[55]);
      _rs.stage = 'done';
      await slackAlert(`[Maya] :recycle: Cancel → rebook ${clientPhone}`);
    } else {
      await sendSMS(clientPhone, "No problem — whenever you're ready, book at tmwmassage.net or text us here.");
      _rs.stage = 'done';
    }
    return;
  }

  // Facial inquiry
  if (isFacialInquiry(incomingText) && (!flowState[contactId || clientPhone] || flowState[contactId || clientPhone].stage === 'reason')) {
    const facialReply = await getMayaReply(incomingText, { stage: 'facial', service: 'facial', context: incomingText });
    if (facialReply) await sendSMS(clientPhone, facialReply);
    await new Promise(r => setTimeout(r, 900));
    await sendSMS(clientPhone, FACIAL_BOOKING_LINKS[55]);
    flowState[contactId || clientPhone] = { stage: 'done', service: 'facial', context: incomingText };
    await slackAlert(`[Maya] :sparkles: Facial inquiry → booking link ${clientPhone}`);
    return;
  }
  if (!flowState[key]) flowState[key] = { stage: 'reason', service: null, addOnChosen: null, saunaOffered: false, context: 'first contact' };
  const state = flowState[key];
  if (state.stage === 'done') { const r = await getMayaReply(incomingText, state); if (r) await sendSMS(clientPhone, r); return; }
  const mayaReply = await getMayaReply(incomingText, state);
  const nextStage = advanceStage(state.stage, incomingText);
  if (state.stage === 'addon') {
    const yes = /\byes\b|yeah|sure|sounds good|ok\b|okay|please|add that|let's do|go ahead/i.test(incomingText);
    const no  = /\bno\b|not (right now|today)|pass|skip|without|no thanks|nah/i.test(incomingText);
    if (yes && contactId) {
      const isRelax = /relax|aroma|stress|calm|anxiety/i.test(state.service || incomingText);
      const label = isRelax ? 'Aromatherapy ($15)' : 'Hot Stone Upgrade ($20)';
      state.addOnChosen = label;
      await writeAddonField(contactId, label);
    } else if (no) state.addOnChosen = 'declined';
  }
  if (mayaReply) await sendSMS(clientPhone, mayaReply);
  state.stage = nextStage;
  if (state.stage === 'booking') {
    await new Promise(r => setTimeout(r, 900));
    await sendSMS(clientPhone, resolveBookingLink(state.service));
    state.stage = 'done';
    await slackAlert(`[Maya] :calendar: Booking link sent\n${clientPhone}\nService: ${state.service || 'unknown'}\nAdd-on: ${state.addOnChosen || 'none'}`);
  }
  state.context = incomingText.substring(0, 100);
});

// Post-booking: confirmation + cancellation policy
app.post('/sms/post-booking', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  const clientPhone = body.phone || body.contact?.phone;
  const firstName = body.firstName || body.contact?.firstName || '';
  const apptTime = body.appointmentTime || body.startTime || '';
  if (!clientPhone) return;
  let timeStr = '';
  if (apptTime) { try { timeStr = new Date(apptTime).toLocaleString('en-US', { weekday: 'short', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); } catch (_) { timeStr = apptTime; } }
  const namePart = firstName ? `${firstName}, ` : '';
  const timePart = timeStr ? ` on ${timeStr}` : '';
  const INTAKE_URL = 'https://sova-deploy-production.up.railway.app/intake';
  await sendSMS(clientPhone, `${namePart}you're all set${timePart}. Before you come in, please fill out your intake form — it helps your therapist prepare: ${INTAKE_URL}`);
  await new Promise(r => setTimeout(r, 1500));
  await sendSMS(clientPhone, `A quick note on our cancellation policy: 24 hours notice is required for any cancellations or changes. Less than 24 hours incurs a 50% charge. 6 hours or less incurs a 100% charge. Couples and parties of 2–4 require 48 hours notice. To cancel or reschedule, call 203-304-1313. We look forward to seeing you.`);
  await slackAlert(`[Maya] Post-booking SMS sent → ${clientPhone}${timePart}`);
});


// Serve preferences form
app.get('/preferences', (req, res) => { res.sendFile(path.join(__dirname, 'preferences-form.html')); });

// Preferences form submission
app.post('/preferences/submit', async (req, res) => {
  res.sendStatus(200);
  const d = req.body;
  let contactId = d.contactId || null;
  if (!contactId && d.phone) { const c = await getContactByPhone(d.phone); contactId = c?.id || null; }
  if (!contactId) { await slackAlert(`[Prefs] No match\nPhone: ${d.phone}\nName: ${d.firstName} ${d.lastName}`); return; }
  const notes = [
    'MASSAGE PREFERENCES',
    `Submitted: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
    '',
    `STANDARDS: ${d.standards || 'not selected'}`,
    `CONVERSATION: ${d.conversation || 'not answered'}`,
    `RELAXATION EXPERIENCE: ${d.relaxation || 'not answered'}`,
  ].join('\n');
  try {
    await axios.post(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`,
      { body: notes, userId: contactId }, { headers: ghlHeaders() });
  } catch (err) { console.error('[PREFS NOTE]', err?.response?.data || err.message); }
  await slackAlert(`[Maya] :memo: Preferences submitted\n${d.firstName} ${d.lastName}\nStandards: ${d.standards || 'none'}\nConversation: ${d.conversation}`);
});

// Serve upgrade/add-ons form
app.get('/upgrade', (req, res) => { res.sendFile(path.join(__dirname, 'upgrade-form.html')); });

// Upgrade form submission
app.post('/upgrade/submit', async (req, res) => {
  res.sendStatus(200);
  const d = req.body;
  let contactId = d.contactId || null;
  if (!contactId && d.phone) { const c = await getContactByPhone(d.phone); contactId = c?.id || null; }
  if (!contactId) { await slackAlert(`[Upgrade] No match\nPhone: ${d.phone}\nName: ${d.firstName} ${d.lastName}`); return; }
  const notes = [
    'SESSION UPGRADES',
    `Submitted: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`,
    '',
    `ADD-ONS: ${d.addons || 'none selected'}`,
    `RELAXATION EXPERIENCE: ${d.relaxation || 'not answered'}`,
  ].join('\n');
  try {
    await axios.post(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`,
      { body: notes, userId: contactId }, { headers: ghlHeaders() });
    // Also write add-ons to the Maya Add-Ons custom field
    if (d.addons && d.addons !== 'No Thank You') {
      await writeAddonField(contactId, d.addons);
    }
  } catch (err) { console.error('[UPGRADE NOTE]', err?.response?.data || err.message); }
  await slackAlert(`[Maya] :sparkles: Upgrade submitted\n${d.firstName} ${d.lastName}\nAdd-ons: ${d.addons || 'none'}`);
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'maya-sms-tmw', endpoints: ['/sms/inbound', '/sms/post-booking', '/intake', '/preferences', '/upgrade'], ts: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Maya SMS] Listening on port ${PORT}`);
});
