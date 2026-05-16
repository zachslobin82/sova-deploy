/ MAYA SMS SERVER — TMW (Therapeutic Massage & Wellness)
const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const GHL_BEARER = process.env.GHL_BEARER_TOKEN || 'pit-fb285c5d-a16c-45be-adce-f35d0722bd52';
const GHL_LOCATION = process.env.GHL_LOCATION_ID || 'i354kGTSmTlt3zeEVsCG';
const FROM_NUMBER = process.env.GHL_FROM_NUMBER || '+18605904699';
const SLACK_HOOK = process.env.SLACK_WEBHOOK_URL || '';
const CAROLYN_CELL = '+18456121174';
const ADDON_FIELD_ID = '8EOok3x105CyQIIJyMtx';

const BOOKING_LINKS = {
      25: 'https://api.gohighlevel.com/widget/booking/uBLikuiy9gCI2MDItdz5',
      55: 'https://api.gohighlevel.com/widget/booking/HFlTUh76tUn01FHsf9Hi',
      85: 'https://api.gohighlevel.com/widget/booking/GDhkZy8h9CtjAOPPKlgR',
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
              const digits = toPhone.replace(/\D/g, '');
              const normalized = digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
              let contactId = null;
              try {
                        const r = await axios.get(`https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION}&query=${encodeURIComponent(normalized)}`, { headers: ghlHeaders() });
                        contactId = r.data?.contacts?.[0]?.id || null;
              } catch(_) {}
              const res = await axios.post('https://services.leadconnectorhq.com/conversations/messages',
                                           { type: 'SMS', message, contactId, fromNumber: FROM_NUMBER, toNumber: normalized, locationId: GHL_LOCATION },
                                           { headers: ghlHeaders() });
              console.log(`[SMS SENT] to=${toPhone} status=${res.status}`);
              return res.data;
      } catch (err) { console.error('[SMS ERROR]', err?.response?.data || err.message); throw err; }
}

async function getContactByPhone(phone) {
      const digits = phone.replace(/\D/g, '');
      const normalized = digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
      try {
              const res = await axios.get(`https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION}&query=${encodeURIComponent(normalized)}`, { headers: ghlHeaders() });
              return res.data?.contacts?.[0] || null;
      } catch (err) { console.error('[CONTACT LOOKUP ERROR]', err?.response?.data || err.message); return null; }
}

async function writeAddonField(contactId, value) {
      try {
              await axios.put(`https://services.leadconnectorhq.com/contacts/${contactId}`,
                              { customFields: [{ id: ADDON_FIELD_ID, field_value: value }] }, { headers: ghlHeaders() });
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
      if (s.includes('85')) return BOOKING_LINKS[85];
      if (s.includes('25')) return BOOKING_LINKS[25];
      return BOOKING_LINKS[55];
}

function buildSystemPrompt(state) {
      return `You are Maya, the AI receptionist for Therapeutic Massage & Wellness (TMW) in Newtown and Danbury, CT.

      TONE:
      - No exclamation points. Ever.
      - No filler: no "Absolutely", "Of course", "Great", "Sure thing", "Certainly", "Happy to".
      - Warm, composed, brief. 1-3 sentences per reply.
      - Never mention Boulevard. Never send booking URLs — server sends them.

      BUSINESS INFO:
      - Address: 32 Church Hill Road, Newtown CT 06470
      - Phone: 203-304-1313
      - Hours: Mon-Thu 9am-8pm, Fri-Sat 9am-4pm, Sun 10am-4pm
      - Website: tmwmassage.net

      SERVICES & PRICING:
      Massage: 25-min $65, 55-min $110, 85-min $160, 110-min $200
      Enhancements: Hot Stone $20, Aromatherapy $15, CBD Oil $15, Cupping $20, Scalp Treatment $15
      Facials: Express $75, TMW Glow $110, Ultra Radiance $140, Gentlemen's $95, Teen $65, Back Facial $85
      Recovery: Infrared Sauna 30min $35/45min $45, Cold Plunge $25, Float 60min $75/90min $95, Red Light $35, Compression $35
      Couples: same pricing plus $20-30 room fee
      Brow & Lash: redirect to phone 203-304-1313

      CANCELLATION POLICY:
      - Under $250: 24-hour notice
      - $250-$499: 48-hour notice, 50% deposit at booking
      - $500+: full payment 7 days prior, non-refundable
      - No-show: 100% charge

      CURRENT FLOW STAGE: ${state.stage}
      SERVICE: ${state.service || 'not yet determined'}
      ADD-ON: ${state.addOnChosen || 'none yet'}
      CONTEXT: ${state.context || 'first contact'}

      FLOW:
      reason -> Recommend specific session. Tailor to goal.
      addon -> ONE add-on: pain -> Hot Stone $20, relaxation -> Aromatherapy $15.
      sauna -> Only if YES to add-on. Offer infrared sauna briefly.
      booking -> Warm closing line only. No URL — server sends it.
      done -> Answer follow-up questions helpfully.
      facial -> Recommend based on skin concern. Server sends booking link.

      CANCELLATION: Acknowledge warmly, immediately offer to rebook.

      FAQ:
      - Hours: Mon-Thu 9am-8pm, Fri-Sat 9am-4pm, Sun 10am-4pm
      - Location: 32 Church Hill Road, Newtown CT 06470
      - Unknown: "Give us a call at 203-304-1313 - the team can help directly."

      REDIRECT: Brow/Lash, Couples booking, medical questions -> phone.

      Respond ONLY with Maya's next SMS. No labels, no quotes.`;
}

function advanceStage(stage, text) {
      const yes = /\byes\b|yeah|sure|definitely|sounds good|ok\b|okay|please|add that|let's do|do it|go ahead|why not/i.test(text);
      const no = /\bno\b|not (right now|today|yet)|pass|skip|just the|without|no thanks|nah/i.test(text);
      switch (stage) {
          case 'reason': return 'addon';
          case 'addon': return yes ? 'sauna' : no ? 'booking' : 'addon';
          case 'sauna': return 'booking';
          default: return 'done';
      }
}

function isCancellation(text) {
      return /cancel|reschedule|can't make it|cant make it|wont be able|won't be able|want to cancel|need to cancel|have to cancel|unable to make|can't come|need to move|move my appointment|change my appointment/i.test(text);
}

function isRebookAcceptance(text) {
      return /\byes\b|yeah|sure|ok\b|okay|sounds good|please|let's do|book|rebook|find a time|new time|different time/i.test(text);
}

function isFacialInquiry(text) {
      return /facial|skin care|esthetician|peel|glow|clearing|anti.aging|radiance|gentleman.s facial|back facial/i.test(text);
}

async function getMayaReply(text, state) {
      try {
              const res = await axios.post('https://api.openai.com/v1/chat/completions',
                                           { model: 'gpt-4.1', max_tokens: 300, messages: [{ role: 'system', content: buildSystemPrompt(state) }, { role: 'user', content: text }] },
                                           { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } });
              return res.data?.choices?.[0]?.message?.content?.trim() || '';
      } catch (err) {
              console.error('[MAYA AI ERROR]', err?.response?.data || err.message);
              return "I'm running into a small issue. Give us a call at 203-304-1313 and we'll get you taken care of.";
      }
}

async function handleInbound(req, res) {
      res.sendStatus(200);
      const body = req.body;
      const clientPhone = body.phone || body.From || body.clientPhone || body.contact?.phone;
      const incomingText = (body.message || body.Body || body.text || '').trim();
      let contactId = body.contactId || body.contact?.id || null;
      if (!clientPhone || !incomingText) return;
      console.log(`[INBOUND] from=${clientPhone} msg="${incomingText}"`);
      if (!contactId) { const c = await getContactByPhone(clientPhone); contactId = c?.id || null; }
      const key = contactId || clientPhone;

  if (isCancellation(incomingText)) {
          await carolynAlert(`[Maya] Cancellation from ${clientPhone}: "${incomingText}"`);
          await slackAlert(`[Maya] Cancellation\nFrom: ${clientPhone}\nMsg: "${incomingText}"`);
          await sendSMS(clientPhone, "Got it - I've let the team know. Before you go, can I help you find another time that works? A lot of clients find it easier to rebook now so you don't lose your spot.");
          flowState[key] = { stage: 'rebook', service: null, addOnChosen: null, context: 'cancelled' };
          return;
  }

  const _rs = flowState[key];
      if (_rs?.stage === 'rebook') {
              if (isRebookAcceptance(incomingText)) {
                        await sendSMS(clientPhone, "Here is the link to grab a new time that works for you.");
                        await new Promise(r => setTimeout(r, 800));
                        await sendSMS(clientPhone, BOOKING_LINKS[55]);
                        _rs.stage = 'done';
              } else {
                        await sendSMS(clientPhone, "No problem - whenever you're ready, book at tmwmassage.net or text us here.");
                        _rs.stage = 'done';
              }
              return;
      }

  if (isFacialInquiry(incomingText) && (!flowState[key] || flowState[key].stage === 'reason')) {
          const facialReply = await getMayaReply(incomingText, { stage: 'facial', service: 'facial', context: incomingText });
          if (facialReply) await sendSMS(clientPhone, facialReply);
          await new Promise(r => setTimeout(r, 900));
          await sendSMS(clientPhone, FACIAL_BOOKING_LINKS[55]);
          flowState[key] = { stage: 'done', service: 'facial', context: incomingText };
          return;
  }

  if (!flowState[key]) flowState[key] = { stage: 'reason', service: null, addOnChosen: null, context: 'first contact' };
      const state = flowState[key];

  if (state.stage === 'done') {
          const r = await getMayaReply(incomingText, state);
          if (r) await sendSMS(clientPhone, r);
          return;
  }

  const mayaReply = await getMayaReply(incomingText, state);
      const nextStage = advanceStage(state.stage, incomingText);

  if (state.stage === 'addon') {
          const yes = /\byes\b|yeah|sure|sounds good|ok\b|okay|please|add that|let's do|go ahead/i.test(incomingText);
          const no = /\bno\b|not (right now|today)|pass|skip|without|no thanks|nah/i.test(incomingText);
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
          await slackAlert(`[Maya] Booking link sent\n${clientPhone}\nService: ${state.service || 'unknown'}\nAdd-on: ${state.addOnChosen || 'none'}`);
  }
      state.context = incomingText.substring(0, 100);
}

// Handle both URL patterns GHL might use
app.post('/sms/inbound', handleInbound);
app.post('/sms-inbound', handleInbound);

app.post('/sms/post-booking', async (req, res) => {
      res.sendStatus(200);
      const body = req.body;
      const clientPhone = body.phone || body.contact?.phone;
      const firstName = body.firstName || body.contact?.firstName || '';
      const apptTime = body.appointmentTime || body.startTime || '';
      if (!clientPhone) return;
      let timeStr = '';
      if (apptTime) { try { timeStr = new Date(apptTime).toLocaleString('en-US', { weekday: 'short', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); } catch (_) { timeStr = apptTime; } }
      const INTAKE_URL = 'https://sova-deploy-production.up.railway.app/intake';
      await sendSMS(clientPhone, `${firstName ? firstName + ', ' : ''}you're all set${timeStr ? ' on ' + timeStr : ''}. Before you come in, please fill out your intake form: ${INTAKE_URL}`);
      await new Promise(r => setTimeout(r, 1500));
      await sendSMS(clientPhone, `Cancellation policy: 24 hours notice required. Less than 24 hours is a 50% charge. 6 hours or less is 100%. To cancel, call 203-304-1313. We look forward to seeing you.`);
});

app.get('/intake', (req, res) => { res.sendFile(path.join(__dirname, 'intake-form.html')); });
app.post('/intake/submit', async (req, res) => { res.sendStatus(200); await slackAlert(`[Intake] ${req.body.firstName} ${req.body.lastName} (${req.body.phone})`); });

app.get('/health', (req, res) => {
      res.json({ status: 'ok', service: 'maya-sms-tmw', endpoints: ['/sms/inbound', '/sms-inbound', '/sms/post-booking', '/intake'], ts: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`[Maya SMS] Listening on port ${PORT}`); });
