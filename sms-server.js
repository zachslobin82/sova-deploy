// Sova SMS Server - Maya AI Text Receptionist - TMW
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CONFIG = {
    openAiApiKey: process.env.OPENAI_API_KEY,
    ghlBearerToken: process.env.GHL_BEARER_TOKEN,
    ghlLocationId: 'i354kGTSmTlt3zeEVsCG',
    ghlFromNumber: '+18605904699',
    carolynCell: '+18456121174',
    businessName: 'Therapeutic Massage & Wellness',
    agentName: 'Maya',
    mainPhone: '203-304-1313',
};

const BOOKING_LINKS = {
    25: 'https://api.gohighlevel.com/widget/booking/uBLikuiy9gCI2MDItdz5',
    55: 'https://api.gohighlevel.com/widget/booking/HFlTUh76tUn01FHsf9Hi',
    85: 'https://api.gohighlevel.com/widget/booking/GDhkZy8h9CtjAOPPKlgR',
    110: 'https://api.gohighlevel.com/widget/booking/tFKqGwFxE5Ka5626we5X',
};

const FACIAL_BOOKING_LINKS = {
    55: 'https://api.gohighlevel.com/widget/booking/CKyiFGAukBqYL4DH7hoi',
    85: 'https://api.gohighlevel.com/widget/booking/WU8aIw5r3MjedkLd9BB8',
};

const SLACK_HOOK = process.env.SLACK_WEBHOOK_URL || '';
const flowState = {};
const conversations = new Map();

function getHistory(phone) { if (!conversations.has(phone)) conversations.set(phone, []); return conversations.get(phone); }
function addToHistory(phone, role, content) { const h = getHistory(phone); h.push({ role, content }); if (h.length > 20) h.splice(0, h.length - 20); }

const SYSTEM_PROMPT = `You are Maya, the AI receptionist for Therapeutic Massage & Wellness (TMW) in Newtown and Danbury, CT.

TONE: No exclamation points. No filler words. Warm, brief, composed. 1-3 sentences. Never mention Boulevard. Never send URLs - the server sends booking links automatically.

BUSINESS: 32 Church Hill Road Newtown CT 06470. Phone 203-304-1313. Hours Mon-Thu 9am-8pm Fri-Sat 9am-4pm Sun 10am-4pm. Website tmwmassage.net.

SERVICES: Massage 25min $65 / 55min $110 / 85min $160 / 110min $200. Enhancements Hot Stone $20 Aromatherapy $15. Facials Express $75 Glow $110 Ultra Radiance $140. Recovery Infrared Sauna 30min $35 Cold Plunge $25 Float 60min $75.

CANCELLATION: Under $250 24hr notice. $250-499 48hr notice. $500+ full payment 7 days prior. No-show 100% charge.

FLOW STAGE: {{STAGE}}
CONTEXT: {{CONTEXT}}

INSTRUCTIONS:
- reason: Ask what brings them in. Recommend a session based on their goal. End with confirming question.
- addon: Offer ONE add-on. Pain/tension = Hot Stone $20. Relaxation = Aromatherapy $15.
- sauna: Only if YES to addon. Briefly offer infrared sauna $35.
- booking: One warm closing sentence. No URL - server sends it.
- done: Answer questions helpfully.

Respond ONLY with Maya's next SMS. No labels, no quotes, no URLs.`;

async function getMayaResponse(clientPhone, message, stage, context) {
    addToHistory(clientPhone, 'user', message);
    const history = getHistory(clientPhone);
    const prompt = SYSTEM_PROMPT.replace('{{STAGE}}', stage || 'reason').replace('{{CONTEXT}}', context || 'first contact');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${CONFIG.openAiApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4.1', max_tokens: 300, messages: [{ role: 'system', content: prompt }, ...history] }),
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
    const reply = (await response.json()).choices[0].message.content.trim();
    addToHistory(clientPhone, 'assistant', reply);
    return reply;
}

async function sendSms(toPhone, message) {
    const digits = toPhone.replace(/\D/g, '');
    const normalized = digits.startsWith('1') ? '+' + digits : '+1' + digits;
    let contactId = null;
    try {
        const r = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${CONFIG.ghlLocationId}&query=${encodeURIComponent(normalized)}`, {
            headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, Version: '2021-04-15' }
        });
        if (r.ok) { const d = await r.json(); contactId = d?.contacts?.[0]?.id || null; }
    } catch(e) { console.error('[SMS] lookup failed:', e.message); }
    const smsRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
        method: 'POST',
        headers: { Authorization: `Bearer ${CONFIG.ghlBearerToken}`, 'Content-Type': 'application/json', Version: '2021-04-15' },
        body: JSON.stringify({ type: 'SMS', message, contactId, fromNumber: CONFIG.ghlFromNumber, toNumber: normalized, locationId: CONFIG.ghlLocationId })
    });
    if (!smsRes.ok) throw new Error(`GHL SMS ${smsRes.status}: ${await smsRes.text()}`);
    return await smsRes.json();
}

async function slackAlert(msg) {
    if (!SLACK_HOOK) return;
    try { await fetch(SLACK_HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: msg }) }); } catch(_) {}
}

function isCancellation(t) { return /cancel|reschedule|can't make it|cant make it|won't be able|wont be able|need to cancel|want to cancel|unable to make|can't come|move my appointment/i.test(t); }
function isYes(t) { return /\byes\b|yeah|sure|definitely|ok\b|okay|please|add that|go ahead|why not/i.test(t); }
function isNo(t) { return /\bno\b|not (right now|today|yet)|pass|skip|without|no thanks|nah/i.test(t); }
function isFacial(t) { return /facial|skin care|peel|glow|clearing|anti.aging|radiance|back facial/i.test(t); }

function getDuration(t) {
    const m = t.match(/\b(25|55|85|110)\b/);
    if (m) return parseInt(m[1]);
    if (/\bhour\b|60\s*min/i.test(t)) return 55;
    if (/hour and|90\s*min/i.test(t)) return 85;
    return null;
}

app.post('/sms-inbound', async (req, res) => {
    res.status(200).json({ received: true });
    try {
        const body = req.body;
        const phone = body.phone || body.contact?.phone || body.fromPhone || body.from || null;
        const text = (body.message || body.messageBody || body.smsBody || body.body || '').trim();
        if (!phone || !text) return;
        console.log(`[SMS] From: ${phone} | "${text}"`);

    if (isCancellation(text)) {
        try { await sendSms(CONFIG.carolynCell, `Maya Alert: ${phone} cancelled: "${text}". Please cancel and free the slot.`); } catch(_) {}
        await sendSms(phone, "Got it - I've let the team know. Before you go, can I help you find another time that works?");
        flowState[phone] = { stage: 'rebook', context: 'cancelled' };
        await slackAlert(`[Maya] Cancellation from ${phone}: "${text}"`);
        return;
    }

    const state = flowState[phone] || {};

    if (state.stage === 'rebook') {
        if (isYes(text)) {
            await sendSms(phone, "Here is the link to grab a new time.");
            await new Promise(r => setTimeout(r, 800));
            await sendSms(phone, BOOKING_LINKS[55]);
        } else {
            await sendSms(phone, "No problem - whenever you're ready, text us here.");
        }
        flowState[phone] = { stage: 'done', context: text };
        return;
    }

    if (isFacial(text) && (!state.stage || state.stage === 'reason')) {
        const reply = await getMayaResponse(phone, text, 'facial', text);
        if (reply) await sendSms(phone, reply);
        await new Promise(r => setTimeout(r, 900));
        await sendSms(phone, FACIAL_BOOKING_LINKS[55]);
        flowState[phone] = { stage: 'done', context: text };
        return;
    }

    if (!state.stage) flowState[phone] = { stage: 'reason', context: 'first contact', duration: null, addon: null };
        const s = flowState[phone];

    if (s.stage === 'done') {
        const reply = await getMayaResponse(phone, text, 'done', s.context || text);
        if (reply) await sendSms(phone, reply);
        return;
    }

    const dur = getDuration(text);
        if (dur) s.duration = dur;

    const reply = await getMayaResponse(phone, text, s.stage, s.context || text);

    if (s.stage === 'addon') {
        if (isYes(text)) { s.addon = /relax|aroma|stress|calm/i.test(text) ? 'Aromatherapy' : 'Hot Stone'; }
        else if (isNo(text)) { s.addon = 'declined'; }
    }

    const next = s.stage === 'reason' ? 'addon'
        : s.stage === 'addon' ? (isYes(text) ? 'sauna' : isNo(text) ? 'booking' : 'addon')
        : s.stage === 'sauna' ? 'booking'
        : 'done';

    if (reply) await sendSms(phone, reply);
        s.stage = next;

    if (s.stage === 'booking') {
        await new Promise(r => setTimeout(r, 900));
        const link = BOOKING_LINKS[s.duration] || BOOKING_LINKS[55];
        await sendSms(phone, link);
        s.stage = 'done';
        await slackAlert(`[Maya] Booking link sent to ${phone} | Duration: ${s.duration || 'unknown'} | Addon: ${s.addon || 'none'}`);
    }

    s.context = text.substring(0, 100);
    } catch(err) { console.error('[ERROR]', err.message); }
});

app.post('/sms/inbound', async (req, res) => { req.url = '/sms-inbound'; app._router.handle(req, res, () => {}); });

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'maya-sms-tmw', openai: CONFIG.openAiApiKey ? 'loaded' : 'MISSING', ghl: CONFIG.ghlBearerToken ? 'loaded' : 'MISSING', ts: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Maya SMS Server on port ${PORT}`);
    console.log(`OpenAI: ${CONFIG.openAiApiKey ? 'loaded' : 'MISSING'}`);
    console.log(`GHL: ${CONFIG.ghlBearerToken ? 'loaded' : 'MISSING'}`);
});
