# Plan: Branded Contract-Signing Experience (Pandora → PandaDoc → Guest)

> **Status:** Future work — stashed from a plan-mode session. Not implemented yet.
> When picked up, re-confirm file paths / line numbers (the portal repo and this
> repo have moved since this was written).

## Context

Event planners currently send PandaDoc contracts to guests out-of-band — PandaDoc's
default email lands in the guest's inbox with a bare "Review & Sign" link. The
experience is generic, off-brand, and detached from the rest of the booking
journey the guest has been on. Meanwhile the sales-lead → Pandora project pipeline
we already ship (`salescard:{projectID}` state in Redis, planner routing, Teams
Adaptive Cards, BMI Office private-note audit trail) has all the data we'd need to
wrap contract signing in a first-class, branded flow.

User ask:
- Trigger the contract automatically based on the Pandora **event status state**
  (no planner button — the project moving to a "ready for contract" state is the
  signal). **No Pandora webhook exists today** — we'll poll.
- Pull project data from BMI-Office, merge into a PandaDoc template, send.
- Deliver a **fun, branded** guest experience — not a raw PandaDoc embed.
- First contract type in scope: **group / party event contract** (birthdays,
  corporate, team building). Generic enough to add more types later (same engine,
  different template ID + field map).

Outcome: when a Pandora project hits the contract-send state, the guest gets a
branded SMS + email with a link to `/contract/{shortId}` on the right brand host
(fasttraxent.com or headpinz.com). That page greets them by name, shows their
event summary, introduces their planner (face + direct line), explains what's
included, and hands off to an embedded PandaDoc signing session. After signing,
they hit a celebration page with countdown + calendar add + wallet pass + share.
The planner sees live status in their existing Teams chat via the same adaptive-
card pattern, and every state change is mirrored to the Pandora project's
private notes as an audit trail.

Portal already does the PandaDoc **read** path (search + download) and has a
hardened **webhook receiver** at `Tools-Team-Member-Portal/api/webhooks/pandadoc.ts`
with HMAC-SHA256 verification and per-workspace shared keys (ships to the
`contract_snapshots` table). That receiver is adjacent to our use case but not
reusable directly — it lives in the portal, persists to portal Postgres, and has
no concept of the `salescard:*` Redis world. The new webhook handler in
fasttrax-web mirrors its verification pattern and its per-workspace keys.

---

## Approach

### High-level flow

```
[Pandora project status becomes "ready-for-contract"]
          │
          ▼  (cron every 5 min scans salescard:* + polls BMI-Office project)
[fasttrax-web /api/contracts/create  (internal, called by cron)]
          │
          ├─ Pull SalesLeadState from Redis + full project from BMI-Office
          ├─ Build merge fields (guest, event, planner, package, price)
          ├─ Create PandaDoc doc from template (POST /public/v1/documents)
          ├─ Persist contract:{shortId} + reverse index contract:doc:{documentId}
          ├─ Send branded SMS + email to guest (link → /contract/{shortId})
          ├─ Post Teams adaptive card to planner ("Contract sent")
          ├─ Append private note to Pandora project ("Contract sent at …")
          ▼
[Guest taps link → fasttrax-web /contract/{shortId}]
          │  (branded landing; host-aware brand via existing middleware)
          ├─ Animated hero: "{firstName}, let's lock this in!"
          ├─ Event summary card: date/time/guests/package/activities/total
          ├─ Planner block: photo, name, direct phone (text + call buttons)
          ├─ Timeline / What's included / 30-sec walkthrough video
          ├─ [REVIEW & SIGN] primary CTA
          ▼
[Inline PandaDoc signing (embedded session URL from API)]
          │
          ▼
[PandaDoc webhook → fasttrax-web /api/webhooks/pandadoc]
          │
          ├─ Verify HMAC (per-workspace shared key, query-param signature)
          ├─ Load contract by contract:doc:{documentId} reverse index
          ├─ Update contract state (status + signedAt)
          ├─ Update Teams adaptive card in place ("Signed by {guest}")
          ├─ Append private note to Pandora project
          ├─ Send celebration SMS + email to guest
          ▼
[Guest auto-redirects to /contract/{shortId}/signed]
          ├─ Confetti + "YOU'RE OFFICIALLY IN" hero
          ├─ Countdown-to-event
          ├─ Add to calendar (.ics)
          ├─ [Phase 2] Apple/Google Wallet pass
          ├─ [Phase 2] Pre-event upsell module (add cake, arcade card)
          └─ Share buttons ("We booked HeadPinz!")
```

### 1. Pandora status-polling cron

**New file:** `fasttrax-web/app/api/cron/contract-dispatch/route.ts`

Runs every 5 min via `vercel.json` cron (or existing cron infra). Logic:

1. `SCAN salescard:*` with cursor loop to enumerate all sales-lead projects.
2. For each, call BMI-Office `GET ?action=project&id={projectID}` via the
   existing proxy at `app/api/bmi-office/route.ts` to fetch current project state.
3. Inspect a status field (exact field name TBD — see § "Open questions" — likely
   `projectStatus`, `stage`, or a named state). If it equals the
   **contract-ready** sentinel (e.g. `"Quote Accepted"`), and the
   `salescard:{projectID}` state does NOT yet have `contractCreatedAt`, fire
   `/api/contracts/create` internally for that project.
4. Short-circuit projects that already have a contract (idempotency — cron can run
   safely on overlap).

Rate-limiting: the cron is light (just N Redis scans + N BMI-Office GETs every
5 min). BMI-Office already has token caching. If we hit the `SalesLeadState`
ceiling (hundreds of open projects), we'll shard by planner later.

**Backup / override:** add a minimal admin POST to `/api/contracts/create` gated
on `x-admin-key` (so a planner can also trigger manually via a portal button if
the cron misses one — not exposed in UI yet, but available as a fallback).

### 2. PandaDoc helper module

**New file:** `fasttrax-web/lib/pandadoc.ts`

Mirrors the patterns from `Tools-Team-Member-Portal/api/integrations/pandadoc-search.ts`
and `pandadoc-download.ts`, but standalone (no axios — uses `fetch`):

```ts
// Location → API key map (ported from portal, keyed by Pandora alphanumeric
// locationID, NOT BMI numeric like portal uses).
const PANDADOC_API_KEY: Record<string, string> = {
  "LAB52GY480CJF": process.env.PANDA_FT!,         // FastTrax Fort Myers
  "TXBSQN0FEKQ11": process.env.PANDA_FTMYERS!,    // HeadPinz Fort Myers
  "PPTR5G2N0QXF7": process.env.PANDA_NAPLES!,     // HeadPinz Naples
};

export function authHeader(locationId: string): string {
  return `API-Key ${PANDADOC_API_KEY[locationId]}`;
}

// Build merge-field tokens from SalesLeadState + project details.
export function buildTokens(state: SalesLeadState, project: PandoraProject): Record<string, string>;

// POST /public/v1/documents — create from template, return documentId.
export async function createDocumentFromTemplate(args: {
  locationId: string;
  templateId: string;
  guest: { email: string; firstName: string; lastName: string; };
  tokens: Record<string, string>;
}): Promise<{ documentId: string; status: string }>;

// POST /public/v1/documents/{id}/send — put it in sent state so the embed URL works.
export async function sendDocument(locationId: string, documentId: string): Promise<void>;

// POST /public/v1/documents/{id}/session — get signing URL for the embed.
export async function createSigningSession(locationId: string, documentId: string, recipientEmail: string): Promise<{ id: string; expires_at: string }>;

// HMAC-SHA256 verification (copy portal pattern: ?signature={hex} query-param,
// raw body bytes hashed with the per-workspace shared key, constant-time compare).
export function verifyWebhookSignature(rawBody: Buffer, signatureHex: string, locationId: string): boolean;
```

Template IDs configured via env: `PANDADOC_TEMPLATE_PARTY_FT`,
`PANDADOC_TEMPLATE_PARTY_HPFM`, `PANDADOC_TEMPLATE_PARTY_NAPLES`. Merge field
names mirror Pandora's `packageType` / `specialRequests` convention so they
round-trip cleanly.

### 3. Contract state (Redis)

**New file:** `fasttrax-web/lib/contract-state.ts`

```ts
type ContractStatus = "draft" | "sent" | "viewed" | "signed" | "declined" | "voided";

export type ContractState = {
  shortId: string;                 // 8-char nanoid, path segment
  documentId: string;              // PandaDoc document ID
  projectID: string;               // Pandora project ID (= salescard key)
  projectNumber: string;           // H#### display
  templateId: string;
  createdAt: string;
  sentAt?: string;
  viewedAt?: string;
  signedAt?: string;
  voidedAt?: string;
  status: ContractStatus;
  guest: { firstName: string; lastName: string; email: string; phone: string; };
  planner: { displayName: string; phone: string; email: string; teamsChatId: string; };
  center: { centerKey: string; displayName: string; brand: "ft" | "hp"; locationId: string; };
  event: { date: string; time?: string; guestCount: number; packageName?: string; activities: string[]; totalCents?: number; };
  teamsCardActivityId?: string;    // for in-place update on signed
};
```

Keys:
- `contract:{shortId}` — primary, 90d TTL
- `contract:doc:{documentId}` → `{shortId}` reverse index (for webhook lookup), 90d TTL

Also bump `salescard:{projectID}`:
- `contractShortId?: string`
- `contractCreatedAt?: string`
- `contractStatus?: ContractStatus`

So planners can see contract linkage on the existing sales-lead card without a
join.

### 4. Guest landing page

**New files:**
- `fasttrax-web/app/contract/[shortId]/page.tsx` — server component, reads
  `contract:{shortId}`, picks brand tokens from `contract.center.brand`, renders
  branded hero + summary + planner block + embedded PandaDoc signing session.
- `fasttrax-web/app/contract/[shortId]/signed/page.tsx` — celebration page.
- `fasttrax-web/app/contract/[shortId]/layout.tsx` — brand-aware wrapper (HP nav
  vs. FT nav) chosen from contract state.

Host-aware middleware rewrite:
- `headpinz.com/contract/{shortId}` → `/contract/{shortId}` (shared; contract
  state itself carries the brand, so we don't need a brand-prefixed path)
- `fasttraxent.com/contract/{shortId}` → same

Middleware change: add `/contract/*` to the existing shared-top-level-routes
exemption list in `fasttrax-web/middleware.ts` (alongside `/accessibility`) so
both hosts serve the same physical page path with brand determined per-contract.

Landing-page content (matches existing branded patterns from `components/home/Hero.tsx`
and `app/book/checkout/confirmation/page.tsx`):
- **Hero band**: `{firstName}, let's lock this in!` + event-date pill, brand
  palette (coral on HP, cyan on FT)
- **Event summary**: 4-col grid — date, time, guests, package — with activity
  chips underneath
- **Planner block**: headshot (new field in PLANNER_REGISTRY — see § 7), name,
  title, direct phone (tel: + sms: buttons), direct email
- **Timeline / "what to expect"**: 3 steps (arrive → play → celebrate), each a
  card with an image from `wuce3at4k1appcmf.public.blob.vercel-storage.com`
- **FAQ accordion**: 3-5 common questions (cancellation, late arrivals, what to
  bring) — copy editable in a const
- **REVIEW & SIGN CTA**: loads the PandaDoc signing session inline via their
  embedded iframe pattern; on completion, window posts a message that the page
  catches and redirects to `/contract/{shortId}/signed`.

Signed page:
- Confetti burst (lightweight; `canvas-confetti` or a CSS keyframe — no new dep
  if we can avoid it; look for existing in repo first)
- Countdown clock to `event.date` (T-N days / hours / mins)
- Add-to-calendar `.ics` download (generated server-side in the landing route)
- Share-this buttons (Facebook, X, SMS) with OG meta prefilled
- Contact-your-planner block retained
- Phase 2 stub section: "Pre-event extras" (upsells)

### 5. Webhook receiver

**New file:** `fasttrax-web/app/api/webhooks/pandadoc/route.ts`

Mirrors portal's `api/webhooks/pandadoc.ts` pattern:
- `bodyParser: false` (Next.js 16 app router: read raw bytes via `request.arrayBuffer()`)
- Signature from `?signature={hex}` query param (PandaDoc's non-standard location)
- Per-workspace shared keys: `PANDADOC_WEBHOOK_SHARED_KEY_FT`, `_HPFM`, `_NAPLES`
- Try each key's verification (we don't always know which workspace sent it;
  portal does the same — pick first successful verify)
- Events arrive as an array; loop and handle each

Per-event handler:
1. Resolve `documentId` from event payload, look up `contract:doc:{documentId}` to
   find the `shortId`, then `contract:{shortId}` for the state.
2. Apply state transition based on event type (`document_state_changed` variants:
   `document.sent`, `document.viewed`, `document.completed`, `document.declined`).
3. For `document.completed` (signed):
   - Set `status: "signed"` + `signedAt`.
   - Update Teams adaptive card in place via existing `lib/teams-bot.ts`
     `updateAdaptiveCard` helper. New card builder added to `lib/sales-lead-card.ts`
     (or a sibling `lib/contract-card.ts`) — shows "✓ Contract signed by {guest}
     at {time}" banner, still links to Pandora project.
   - Append private note to Pandora project via existing
     `lib/bmi-office-notes.ts` / the helper from the sales-lead flow.
   - Trigger celebration SMS + email to guest.
4. For `document.declined` / `document.voided`: similar, with different card
   copy + planner alert instead of guest celebration.
5. Respond 200 to PandaDoc immediately after Redis write; all side effects run
   through `Promise.allSettled` fan-out so one failure doesn't break others.

### 6. Adaptive-card integration

**Modify:** `fasttrax-web/lib/sales-lead-card.ts` (add `buildContractCard*` variants)

Extend the existing card with a new state section:
- `buildSalesLeadCardContractSent(state)` — adds "📄 Contract sent to
  {guest.firstName} at {time}" line + link button "View in PandaDoc"
- `buildSalesLeadCardContractSigned(state)` — adds "✅ Contract signed by
  {guest.firstName} at {time}" line; link button becomes "Open signed document"

Called from `/api/contracts/create` (on send) and from the webhook handler (on
signed). Uses `updateAdaptiveCard` from `lib/teams-bot.ts` — keyed by
`state.cardActivityId` already persisted on the sales-lead card.

### 7. Planner registry extension

**Modify:** `fasttrax-web/lib/sales-lead-config.ts`

Add photo URLs to the `PLANNER_REGISTRY` entries for the landing page's planner
block:

```ts
stephanie: { ..., photoUrl: "<blob URL>", title: "Senior Event Planner" },
lori:      { ..., photoUrl: "<blob URL>", title: "Event Planner" },
kelsea:    { ..., photoUrl: "<blob URL>", title: "Event Planner" },
```

Fall back to a generic silhouette if missing (don't block on photo upload —
landing still renders).

### 8. Environment variables

Add to `fasttrax-web/.env.local` (and Vercel prod):

```
# PandaDoc API keys (port from portal env)
PANDA_FT=...
PANDA_FTMYERS=...
PANDA_NAPLES=...

# PandaDoc template IDs (per-center party contract template)
PANDADOC_TEMPLATE_PARTY_FT=...
PANDADOC_TEMPLATE_PARTY_HPFM=...
PANDADOC_TEMPLATE_PARTY_NAPLES=...

# Webhook shared keys (port from portal env; same values, new home)
PANDADOC_WEBHOOK_SHARED_KEY_FT=...
PANDADOC_WEBHOOK_SHARED_KEY_HPFM=...
PANDADOC_WEBHOOK_SHARED_KEY_NAPLES=...

# Admin override for manual contract creation
CONTRACTS_ADMIN_KEY=<32-byte random hex>

# Status-state sentinel for the cron trigger (lets us change without a deploy)
PANDORA_CONTRACT_READY_STATE=Quote Accepted
```

PandaDoc webhook URL in the PandaDoc dashboard per workspace →
`https://fasttraxent.com/api/webhooks/pandadoc?signature={sig}` (and
`https://headpinz.com/...` — same handler, middleware-shared).

---

## Critical files

| Path | Change |
|---|---|
| `fasttrax-web/lib/pandadoc.ts` | **NEW** — helper module (auth, create, send, signing session, webhook verify) |
| `fasttrax-web/lib/contract-state.ts` | **NEW** — Redis schema + accessors (get/set by shortId or documentId) |
| `fasttrax-web/lib/sales-lead-card.ts` | Add `buildSalesLeadCardContractSent` / `…Signed` card variants |
| `fasttrax-web/lib/sales-lead-config.ts` | Extend `PLANNER_REGISTRY` with `photoUrl`, `title` |
| `fasttrax-web/app/api/contracts/create/route.ts` | **NEW** — orchestrator (read state → create PandaDoc doc → persist → SMS/email/Teams/note fan-out) |
| `fasttrax-web/app/api/webhooks/pandadoc/route.ts` | **NEW** — receiver with HMAC verify + state transitions + card update + guest notifications |
| `fasttrax-web/app/api/cron/contract-dispatch/route.ts` | **NEW** — 5-min poll; fires `create` when a project hits contract-ready state |
| `fasttrax-web/app/contract/[shortId]/layout.tsx` | **NEW** — brand-aware layout |
| `fasttrax-web/app/contract/[shortId]/page.tsx` | **NEW** — branded hero + summary + signing-session embed |
| `fasttrax-web/app/contract/[shortId]/signed/page.tsx` | **NEW** — celebration page |
| `fasttrax-web/middleware.ts` | Add `/contract/*` to `isSharedTopLevelRoute` exemption |
| `fasttrax-web/.env.local` | Add 10 env vars (see § 8) |
| `vercel.json` (or cron config) | Register 5-min cron for `/api/cron/contract-dispatch` |

## Reused utilities

- `lib/redis.ts` — Redis client
- `lib/sms-retry.ts` — `voxSend` with `fromOverride` for planner-signed SMS
- `lib/sendgrid.ts` — `sendEmail({ from, replyTo, ... })` for planner-signed email
- `lib/teams-bot.ts` — `sendAdaptiveCardToChannel` + `updateAdaptiveCard`
- `lib/bmi-office-notes.ts` — `appendPrivateNote(projectId, line)` for Pandora
  audit trail
- `app/api/bmi-office/route.ts` — existing proxy for `action=project&id=X`
- `app/api/pandora/route.ts` — existing proxy (if we need person lookups)
- PandaDoc auth pattern from
  `Tools-Team-Member-Portal/api/integrations/pandadoc-search.ts:53-56`
  (ported — `Authorization: API-Key {key}`)
- Webhook HMAC verify pattern from
  `Tools-Team-Member-Portal/api/webhooks/pandadoc.ts:63-83` (ported —
  query-param signature, raw-body HMAC-SHA256)

---

## Phased rollout

**Phase 1 (MVP — this plan):**
- PandaDoc helper module (create + send + signing-session + webhook verify)
- Cron-driven auto-dispatch when project hits contract-ready state
- Redis contract state + reverse index
- Branded landing page + signed celebration page
- Webhook receiver + Teams card update + Pandora private note + guest SMS/email
- Admin override POST (ungatted UI, just a fallback)

**Phase 2 (follow-up):**
- Apple/Google Wallet pass (revive existing
  `project_wallet_passes` TODO)
- Pre-event upsell module on the signed page (add cake, arcade card via BMI
  `booking/sell`)
- T-48h / T-24h / T-2h reminder SMS via new cron
- Portal admin button on `ReservationDetailPage.tsx` to manually trigger / resend

**Phase 3:**
- Additional contract types (facility-rental, corporate season) — same engine,
  new template IDs + field maps
- Teams adaptive-card "Send Contract" action for planner-initiated
- Real BMI webhook (if/when BMI exposes one) replaces the poll

---

## Open questions

1. **Exact Pandora field name for "contract-ready" state.** Need to look at an
   actual `/bmi/project/{id}` response to find the status field. Unblock step: grab
   one HAR from BMI Office of a project in the state we care about; confirm the
   field name and string value. Until then, env var `PANDORA_CONTRACT_READY_STATE`
   lets us configure without a deploy.
2. **PandaDoc signing-session embed.** Their embedded signing API needs a session
   token + the iframe URL pattern. We believe it's `POST /public/v1/documents/{id}/session`
   returning `{id}` to use as `https://app.pandadoc.com/s/{id}`. Verify against
   PandaDoc docs during implementation.
3. **PDF generation from template — do we need to upload the final merged doc
   anywhere?** For the audit trail, after signing we might want to download the
   signed PDF (existing portal `pandadoc-download.ts` shows the pattern) and
   attach it to the Pandora project as a file. Defer to Phase 2 unless required
   for compliance.
4. **Planner photo URLs.** Need three headshots uploaded to Vercel blob before
   launch. Not a blocker for the engine — falls back to silhouette.

---

## Verification

1. **Local end-to-end test with a test PandaDoc workspace (sandbox):**
   - Create a dummy `salescard:{PROJ}` with a test project ID + planner = you.
   - Hit `POST /api/contracts/create` with `x-admin-key` to bypass the cron.
   - Confirm: PandaDoc document created (check dashboard); `contract:{shortId}`
     in Redis; guest SMS + email arrived; Teams card posted to your test chat.
   - Open `/contract/{shortId}` — landing loads, branded to correct center.
   - Click Review & Sign; complete the signing in the embed.
   - Confirm: webhook hits `/api/webhooks/pandadoc`; Redis state updates to
     `signed`; Teams card updates in place; Pandora project has a private note;
     guest gets celebration SMS + email; `/contract/{shortId}/signed` renders
     with confetti + countdown.

2. **Signature rejection test:** POST a forged payload to `/api/webhooks/pandadoc`
   with an invalid `?signature=`. Expect 401; no state change.

3. **Per-workspace key rotation:** Change `PANDADOC_WEBHOOK_SHARED_KEY_FT`; post
   a real FT-workspace webhook. Expect 401 until key restored. HP keys unaffected.

4. **Idempotency:** Run `/api/cron/contract-dispatch` twice within a minute.
   Second run should no-op every already-sent project (check `contractCreatedAt`
   guard).

5. **Brand routing:** Land on `headpinz.com/contract/{shortId}` where the contract
   is an HP-brand one — confirm HP palette + HP nav. Land on the same shortId
   via `fasttraxent.com/contract/{shortId}` — same page content, same brand (the
   page chooses brand from state, not host).

6. **Graceful degradation:** Break the PandaDoc API key temporarily. Cron run
   logs the failure; Redis + Teams + SMS path for OTHER projects still works;
   the one that failed gets retried on the next cron tick (no permanent fail
   flag set).

7. **Regression:** Confirm existing `/api/sales-lead/submit` + Teams card flow
   still works after the `sales-lead-card.ts` additions (non-breaking additions
   to the builder module).
