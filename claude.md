# CLAUDE.md — sova-deploy (TMW)

> This file is the authoritative briefing for every Claude Code session in this repo.
> Read it fully before taking any action. Update it when architecture changes.

---

## What this repo is

This is Sova's AI receptionist deployment for **Therapeutic Massage & Wellness (TMW)**, located in Newtown, CT. The AI agent is named **Maya**. Maya operates across two channels: voice (via Retell AI) and SMS (via GHL automation).

This is **client zero** — the live reference case for Sova's product.

---

## People

| Person | Role | Contact |
|---|---|---|
| Jenna Dallinga | Owner, TMW | — |
| Carolyn Hunt | Front desk manager | +18456121174 (personal cell) |

**Never push changes that affect Carolyn's workflows without explicit flagging.** She manages day-to-day scheduling and is the human fallback when Maya can't close a booking.

---

## Tech stack

| Layer | Tool |
|---|---|
| CRM | GoHighLevel (GHL) |
| Voice agent | Retell AI (18-node flow) |
| LLM | GPT-4.1 |
| Hosting | Railway |
| Version control | GitHub (zachslobin82/sova-deploy) |
| SMS automation | GHL workflows |

---

## GHL configuration

**Location ID:** `i354kGTSmTlt3zeEVsCG`

**Booking calendars — Round Robin:**
- 25 min massage
- 55 min massage
- 85 min massage
- 110 min massage

All booking links must point to GHL calendars. **Never generate or reference Boulevard booking links** — TMW is fully migrated off Boulevard. Any Boulevard reference in code or prompts is a bug.

**Custom field — Maya Add-Ons:**
- Field ID: `8EOok3x105CyQIIJyMtx`
- Written to GHL contact record when client selects add-ons during SMS flow

---

## Railway deployment

**Production URL:** `sova-deploy-production.up.railway.app`

When deploying:
1. Push to GitHub main branch
2. Railway auto-deploys on push
3. Verify production URL responds after deploy
4. Check Railway logs if deploy fails — do not assume success

**Never force-push to main.** Always verify tests pass before pushing.

---

## Maya — SMS flow

Maya's SMS flow fires on missed call. The sequence is:

1. **Opening** — warm acknowledgment of missed call
2. **Reason** — ask what they're coming in for
3. **Assumptive recommendation** — suggest a service with a downsell option
4. **Add-on upsell** — one add-on offer
5. **Sauna upsell** — only if client said yes to add-on
6. **Booking link** — GHL Round Robin calendar link, matched to session length

**Flow state injection** is active to prevent loops. Do not remove or modify flow state logic without explicit instruction — this is a known fragile point.

If a step is unclear or the client goes off-script, Maya routes to Carolyn rather than hallucinating a response.

---

## Maya — Voice flow

18-node Retell AI flow. Voice and SMS are separate systems but share the same GHL contact record and booking calendars.

Do not modify Retell node structure without a full review — changes to node routing can break the entire voice flow.

---

## ⚠️ Hard rules — never violate these

1. **No Boulevard references** — anywhere in code, prompts, or responses. TMW is off Boulevard entirely.
2. **No flow state removal** — the loop-prevention logic must stay intact.
3. **No hardcoded booking links** — always use GHL calendar IDs dynamically.
4. **No changes to Carolyn's notification workflows** without flagging first.
5. **No deploy without verifying Railway logs.**

---

## Current status and known context

- TMW is migrating its full CRM from Boulevard to GHL — this migration is ongoing
- Maya SMS agent is live and operational
- Next priorities: GHL post-booking workflow (intake form + cancellation policy), therapist schedule setup with Carolyn
- A2P 10DLC compliance is in progress — SMS campaign pending approval

---

## Architecture note — pending simplification

TMW's service offerings are being simplified. When Jenna confirms the new structure (target: ~4 massage categories, ~2 membership tiers), this file will be updated and the booking flow, Maya prompts, and calendar structure will be revised accordingly.

**Do not build new features that depend on the current service complexity** without checking whether they'll survive the simplification. When in doubt, ask before building.

---

## Pass 2 — to be completed

The following will be added once Jenna confirms:

- [ ] Finalized massage categories (target: 4)
- [ ] Membership tier names and details (target: 2 tiers)
- [ ] Services being deprecated — Maya must never mention these
- [ ] Updated session lengths if 25/55/85/110 changes
- [ ] New booking flow logic if calendar structure changes
