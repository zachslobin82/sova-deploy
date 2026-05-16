// ============================================================================
// Sova SMS Server — Maya AI Text Receptionist
// TMW (Therapeutic Massage & Wellness, Newtown CT)
// ============================================================================

const express = require('express');
const path    = require('path');
const app     = express();
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
    mainPhone:      '203-304-1313',
};

if (!CONFIG.openAiApiKey)   console.warn('[WARN] OPENAI_API_KEY not set');
if (!CONFIG.ghlBearerToken) console.warn('[WARN] GHL_BEARER_TOKEN not set');

const SLACK_HOOK = process.env.SLACK_WEBHOOK_URL || '';
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
const conversations = new Map();
function getHistory(phone) { if (!conversations.has(phone)) conversations.set(phone, []); return conversations.get(phone); }
function addToHistory(phone, role, content) { const h = getHistory(phone); h.push({ role, content }); if (h.length > 20) h.splice(0, h.length - 20); }

function buildSystemPrompt(state) {
    const base = `You are Maya, the AI receptionist for Therapeutic Massage & Wellness (TMW) in Newtown and Danbury, CT.

    TONE:
    - No exclamation points. Ever.
    - No filler words: no Absolutely, Of course, Great, Sure thing, Certainly, Happy to, Sounds good.
    - Warm, composed, brief. 1-3 sentences per reply.
    - Never mention Boulevard. Never send a URL — the server sends booking links automatically.

    BUSINESS INFO:
    - Address: 32 Church Hill Road, Newtown CT 06470
    - Phone: 203-304-1313
    - Hours: Mon-Thu 9am-8pm, Fri-Sat 9am-4pm, Sun 10am-4pm
    - Website: tmwmassage.net

    SERVICES & PRICING:
    Massage: 25-min $65, 55-min $110, 85-min $160, 110-min $200
    Enhancements: Hot Stone $20, Aromatherapy $15, CBD Oil $15, Cupping $20, Scalp Treatment $15
    Facials: Express $75, TMW Glow $110, Ultra Radiance $140, Gentlemens $95, Teen $65, Back Facial $85
    Recovery: Infrared Sauna 30min $35/45min $45, Cold Plunge $25, Float 60min $75/90min $95, Red Light $35, Compression $35
    Couples: same pricing plus $20-30 room fee
    Brow and Lash: redirect to phone 203-304-1313

    CANCELLATION POLICY:
    - Under $250: 24-hour notice
    - $250-$499: 48-hour notice, 50% deposit at booking
    - $500+: full payment 7 days prior, non-refundable
    - No-show: 100% charge

    FACIALS (by Julia and Rebecca):
    Active Clearing $150/55min $225/85min | Anti-Aging $150/55min $225/85min | Lymphatic $160/55min $225/85min | Ultra Radiance $130/55min | Back Facial $80/25min $160/55min

    REDIRECT: Brow/Lash, Couples, medical questions -> call 203-304-1313.
    FAQ unknown: Give us a call at 203-304-1313 - the team can help directly.`;

  if (!state) return base;
    return `${base}

    CURRENT FLOW STAGE: ${state.stage}
    DURATION: ${state.duration || 'not yet determined'}
    ADD-ON: ${state.addOnChosen || 'none yet'}
    CONTEXT: ${state.context || 'first contact'}

    FLOW:
    reason  -> Recommend a session based on their goal. End with a confirming question.
    addon   -> Offer ONE add-on: pain/tension -> Hot Stone $20, relaxation -> Aromatherapy $15.
    sauna   -> Only if YES to add-on. Briefly offer infrared sauna 30min $35.
    booking -> One warm closing sentence. No URL — server sends the booking link.
    done    -> Answer questions. Do not restart booking flow unless asked.
    facial  -> Recommend based on skin concern. No URL — server sends link.

    CANCELLATION: Acknowledge warmly, offer to rebook immediately.

    Respond ONLY with Maya's next SMS. No labels, no quotes, no URLs.`;
}

async function getMayaResponse(clientPhone, incomingMessage, state) {
    addToHistory(clientPhone, 'user', incomingMessage);
    const history = getHistory(clientPhone);
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${CONFIG.openAiApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4.1', max_tokens: 300, messages: [{ role: 'system', content: buildSystemPrompt(state || null) }, ...history] }),
    });
    if (!response.ok) { const err = await response.text(); throw new Error(`OpenAI error: ${response.status} - ${err}`); }
    const data  = await response.json();
    const reply = data.choices[0].message.content.trim();
    addToHistory(clientPhone, 'assistant', reply);
    return reply;
}

async function sendGhlSms(toPhone, message) {
    const digits     = toPhone.replace(/\D/g, '');
    const normalized = digits.startsWith('1') ? '+' + digits : '+1' + digits;
    let contactId = null;
    try {
          const r = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${CONFIG.ghlLocationId}&query=${encodeURIComponent(normalized)}`, {
                  headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, Version: '2021-04-15' }
          });
          if (r.ok) { const d = await r.json(); contactId = d?.contacts?.[0]?.id || null; }
    } catch(e) { console.error('[SMS] contact lookup:', e.message); }
    const smsRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
          method: 'POST',
          headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
          body: JSON.stringify({ type: 'SMS', message, contactId, fromNumber: CONFIG.ghlFromNumber, toNumber: normalized, locationId: CONFIG.ghlLocationId })
    });
    if (!smsRes.ok) { const e = await smsRes.text(); throw new Error(`GHL SMS failed: ${smsRes.status} - ${e}`); }
    return await smsRes.json();
}

async function alertCarolyn(clientPhone, msg) {
    try { await sendGhlSms(CONFIG.carolynCell, `Maya Alert: Client (${clientPhone}) cancelled.\nMessage: "${msg}"\nPlease cancel and free the slot.`); } catch(e) { console.error('[CAROLYN]', e.message); }
}
async function slackAlert(msg) {
    if (!SLACK_HOOK) return;
    try { await fetch(SLACK_HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: msg }) }); } catch(_) {}
}

function isCancellation(text) { return /cancel|reschedule|can't make it|cant make it|won't be able|wont be able|need to cancel|want to cancel|have to cancel|unable to make|can't come|need to move|move my appointment|change my appointment/i.test(text); }
function isRebookAcceptance(text) { return /\byes\b|yeah|sure|ok\b|okay|sounds good|please|let's do|book|rebook|find a time|new time|different time/i.test(text); }
function isFacialInquiry(text) { return /facial|skin care|esthetician|peel|glow|clearing|anti.aging|radiance|back facial/i.test(text); }
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
function extractDuration(text) {
    const m = text.match(/\b(25|55|85|110)\s*[-]?\s*min/i) || text.match(/\b(25|55|85|110)\b/);
    if (m) return parseInt(m[1], 10);
    if (/\bhour\b|60\s*min/i.test(text)) return 55;
    if (/hour\s*and\s*a?\s*half|90\s*min/i.test(text)) return 85;
    return null;
}
function resolveBookingLink(duration, service) {
    const d = parseInt(duration, 10);
    if ([25, 55, 85, 110].includes(d)) return BOOKING_LINKS[d];
    const s = (service || '').toLowerCase();
    if (s.includes('110')) return BOOKING_LINKS[110];
    if (s.includes('85'))  return BOOKING_LINKS[85];
    if (s.includes('25'))  return BOOKING_LINKS[25];
    return BOOKING_LINKS[55];
}

async function handleInboundSMS(req, res) {
    res.status(200).json({ received: true });
    try {
          const body         = req.body;
          const clientPhone  = body.phone || body.contact?.phone || body.fromPhone || body.from || null;
          const incomingText = (body.message || body.messageBody || body.smsBody || body.body || '').trim();
          if (!clientPhone || !incomingText) return;
          console.log(`[SMS] From: ${clientPhone} | "${incomingText}"`);
          const key = clientPhone;

      if (isCancellation(incomingText)) {
              await alertCarolyn(clientPhone, incomingText);
              await slackAlert(`[Maya] Cancellation from ${clientPhone}: "${incomingText}"`);
              await sendGhlSms(clientPhone, "Got it - I've let the team know. Before you go, can I help you find another time that works? A lot of clients find it easier to rebook now so you don't lose your spot.");
              flowState[key] = { stage: 'rebook', duration: null, addOnChosen: null, context: 'cancelled' };
              return;
      }

      const existing = flowState[key];
          if (existing?.stage === 'rebook') {
                  if (isRebookAcceptance(incomingText)) {
                            await sendGhlSms(clientPhone, "Here is the link to grab a new time that works for you.");
                            await new Promise(r => setTimeout(r, 800));
                            await sendGhlSms(clientPhone, BOOKING_LINKS[55]);
                            existing.stage = 'done';
                            await slackAlert(`[Maya] Cancel -> rebook ${clientPhone}`);
                  } else {
                            await sendGhlSms(clientPhone, "No problem - whenever you're ready, book at tmwmassage.net or text us here.");
                            existing.stage = 'done';
                  }
                  return;
          }

      if (isFacialInquiry(incomingText) && (!flowState[key] || flowState[key].stage === 'reason')) {
              try { const r = await getMayaResponse(clientPhone, incomingText, { stage: 'facial', duration: null, context: incomingText }); if (r) await sendGhlSms(clientPhone, r); } catch(_) {}
              await new Promise(r => setTimeout(r, 900));
              await sendGhlSms(clientPhone, FACIAL_BOOKING_LINKS[55]);
              flowState[key] = { stage: 'done', duration: null, context: incomingText };
              return;
      }

      if (!flowState[key]) flowState[key] = { stage: 'reason', service: null, duration: null, addOnChosen: null, context: 'first contact' };
          const state = flowState[key];

      if (state.stage === 'done') {
              try { const r = await getMayaResponse(clientPhone, incomingText, state); if (r) await sendGhlSms(clientPhone, r); } catch(e) { console.error('[MAYA]', e.message); }
              return;
      }

      const detected = extractDuration(incomingText);
          if (detected) state.duration = detected;

      let mayaReply = '';
          try { mayaReply = await getMayaResponse(clientPhone, incomingText, state); }
          catch(e) { mayaReply = "Give us a call at 203-304-1313 and we'll get you taken care of."; }

      const nextStage = advanceStage(state.stage, incomingText);

      if (state.stage === 'addon') {
              const yes = /\byes\b|yeah|sure|sounds good|ok\b|okay|please|add that|let's do|go ahead/i.test(incomingText);
              const no  = /\bno\b|not (right now|today)|pass|skip|without|no thanks|nah/i.test(incomingText);
              if (yes) { state.addOnChosen = /relax|aroma|stress|calm|anxiety/i.test(incomingText) ? 'Aromatherapy ($15)' : 'Hot Stone Upgrade ($20)'; }
              else if (no) { state.addOnChosen = 'declined'; }
      }

      if (mayaReply) await sendGhlSms(clientPhone, mayaReply);
          state.stage = nextStage;

      if (state.stage === 'booking') {
              await new Promise(r => setTimeout(r, 900));
              await sendGhlSms(clientPhone, resolveBookingLink(state.duration, state.service));
              state.stage = 'done';
              await slackAlert(`[Maya] Booking link sent\n${clientPhone}\nDuration: ${state.duration || 'unknown'}\nAdd-on: ${state.addOnChosen || 'none'}`);
      }
          state.context = incomingText.substring(0, 100);
    } catch(err) { console.error('[ERROR]', err.message); }
}

app.post('/sms-inbound', handleInboundSMS);
app.post('/sms/inbound', handleInboundSMS);

app.post('/sms/post-booking', async (req, res) => {
    res.sendStatus(200);
    const { phone, firstName, appointmentTime, startTime } = req.body;
    if (!phone) return;
    let timeStr = '';
    const t = appointmentTime || startTime;
    if (t) { try { timeStr = new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); } catch(_) { timeStr = t; } }
    const INTAKE_URL = 'https://sova-deploy-production.up.railway.app/intake';
    await sendGhlSms(phone, `${firstName ? firstName + ', ' : ''}you're all set${timeStr ? ' on ' + timeStr : ''}. Before you come in, please fill out your intake form: ${INTAKE_URL}`);
    await new Promise(r => setTimeout(r, 1500));
    await sendGhlSms(phone, `Cancellation policy: 24 hours notice required for changes. Less than 24 hours is a 50% charge. 6 hours or less is 100%. To cancel, call 203-304-1313. We look forward to seeing you.`);
});

app.post('/create-ghl-booking', async (req, res) => {
    const { calendarId, locationId, startTime, endTime, firstName, lastName, email, phone, title } = req.body;
    const missing = [];
    if (!calendarId) missing.push('calendarId');
    if (!startTime)  missing.push('startTime');
    if (!endTime)    missing.push('endTime');
    if (missing.length) return res.status(400).json({ success: false, error: `Missing: ${missing.join(', ')}` });
    const loc = locationId || CONFIG.ghlLocationId;
    let contactId = null;
    try {
          if (phone) {
                  const digits = phone.replace(/\D/g, '');
                  const norm   = digits.startsWith('1') ? '+' + digits : '+1' + digits;
                  const sr = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${loc}&query=${encodeURIComponent(norm)}`, { headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, Version: '2021-04-15' } });
                  if (sr.ok) { const d = await sr.json(); contactId = d?.contacts?.[0]?.id || null; }
          }
          if (!contactId) {
                  const cr = await fetch('https://services.leadconnectorhq.com/contacts/', { method: 'POST', headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-07-28' }, body: JSON.stringify({ locationId: loc, firstName: firstName||'', lastName: lastName||'', email: email||'', phone: phone||'' }) });
                  if (cr.ok) { const cd = await cr.json(); contactId = cd?.contact?.id || null; }
          }
    } catch(e) { console.error('[BOOKING] contact:', e.message); }
    try {
          const ar = await fetch('https://services.leadconnectorhq.com/calendars/events/appointments', { method: 'POST', headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-04-15' }, body: JSON.stringify({ calendarId, locationId: loc, contactId, startTime, endTime, title: title || `${firstName} ${lastName} - Massage`, appointmentStatus: 'confirmed', toNotify: true }) });
          if (!ar.ok) { const e = await ar.text(); throw new Error(`Appt failed: ${ar.status} - ${e}`); }
          const result = await ar.json();
          const appointmentId = result?.id || result?.appointment?.id || 'unknown';
          if (phone) {
                  try {
                            let timeStr = '';
                            try { timeStr = new Date(startTime).toLocaleString('en-US', { weekday: 'short', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); } catch(_) { timeStr = startTime; }
                            await sendGhlSms(phone, `${firstName}, you're all set on ${timeStr}. Please fill out your intake form before coming in: https://sova-deploy-production.up.railway.app/intake`);
                            await new Promise(r => setTimeout(r, 1500));
                            await sendGhlSms(phone, `Cancellation policy: 24 hours notice required. Less than 24 hours is a 50% charge. 6 hours or less is 100%. To cancel, call 203-304-1313.`);
                            await slackAlert(`[Maya] Voice booking\n${firstName} ${lastName} (${phone})\n${timeStr}\nAppt: ${appointmentId}`);
                  } catch(smsErr) { console.error('[BOOKING] SMS:', smsErr.message); }
          }
          return res.status(200).json({ success: true, appointmentId, message: `Confirmed for ${firstName} ${lastName}` });
    } catch(err) {
          await slackAlert(`[Maya] Voice booking FAILED\n${firstName} ${lastName} (${phone})\n${err.message}`);
          return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/intake',      (req, res) => { res.sendFile(path.join(__dirname, 'intake-form.html')); });
app.get('/preferences', (req, res) => { res.sendFile(path.join(__dirname, 'preferences-form.html')); });
app.get('/upgrade',     (req, res) => { res.sendFile(path.join(__dirname, 'upgrade-form.html')); });
app.post('/intake/submit',      async (req, res) => { res.sendStatus(200); await slackAlert(`[Intake] ${req.body.firstName} ${req.body.lastName} (${req.body.phone})`); });
app.post('/preferences/submit', async (req, res) => { res.sendStatus(200); await slackAlert(`[Prefs] ${req.body.firstName} ${req.body.lastName}`); });
app.post('/upgrade/submit',     async (req, res) => { res.sendStatus(200); await slackAlert(`[Upgrade] ${req.body.firstName} ${req.body.lastName} - ${req.body.addons}`); });

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'maya-sms-tmw', endpoints: ['/sms-inbound', '/sms/inbound', '/sms/post-booking', '/create-ghl-booking', '/intake', '/preferences', '/upgrade'], openai: CONFIG.openAiApiKey ? 'loaded' : 'MISSING', ghl: CONFIG.ghlBearerToken ? 'loaded' : 'MISSING', ts: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✓ Maya SMS Server on port ${PORT}`);
    console.log(`  OpenAI: ${CONFIG.openAiApiKey ? '✓' : '✗ MISSING'}`);
    console.log(`  GHL:    ${CONFIG.ghlBearerToken ? '✓' : '✗ MISSING'}\n`);
});
