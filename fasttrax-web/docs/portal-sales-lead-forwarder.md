# Portal PR — Sales-Lead Invoke Forwarder

**Target repo:** `C:\GIT\Tools-Team-Member-Portal`
**Target file:** `api/bot/messages.ts`
**Paired feature:** `fasttrax-web` Sales-Leads Flow (see [`okay-we-need-to-harmonic-gem.md`](../../../..\Users\eric.osborn.CORP\.claude\plans\okay-we-need-to-harmonic-gem.md))

---

## Context

We built a sales-leads flow in `fasttrax-web` that posts Teams Adaptive Cards with **Acknowledged** and **Contacted** action buttons into planner chats. The bot app that sends these cards is **the portal's existing bot** (`BOT_APP_ID = ecb2f15a-ff53-479b-836f-c3bf3d8a562f`), so sending works out-of-the-box — the OAuth2 client-credentials flow uses the same `BOT_APP_ID` + `BOT_APP_SECRET` from either app's env.

**Problem:** when a planner *clicks* a button on one of those cards, Teams POSTs the invoke activity to the bot's registered Azure messaging endpoint — which currently points at `portal.headpinz.com/api/bot/messages`. fasttrax-web never sees the click, so the card never updates, Redis state never transitions, and the audit trail never logs the action.

**Solution:** the portal forwards any `sales_lead_*` verb to fasttrax-web via HTTP, fasttrax handles the state transition + card update, returns the new card to portal, and portal passes that back to Teams as the invoke response. No Azure changes, no new Teams app install.

---

## What this PR does

1. Adds a `SALES_LEAD_VERBS` set covering the two verbs fasttrax emits
2. Adds a `forwardSalesLeadAction` function that POSTs the full invoke activity envelope to `fasttrax-web/api/teams/bot-action` with a shared-secret header
3. In the main `invoke` dispatch block (just after the verb is extracted, before the `ACTION_HANDLERS` lookup that would otherwise return "Unknown action"), intercepts sales-lead verbs and forwards them
4. Adds two env vars: `FASTTRAX_BOT_ACTION_URL` and `PORTAL_FORWARD_SECRET`

The portal does **not** need to know anything about sales-lead state, render any cards, talk to Pandora, or store anything. It's a pure transparent pipe for verbs matching `sales_lead_*`.

---

## Changes

### 1. Edit `api/bot/messages.ts`

**Add these constants near the top of the file** (after the existing imports, before `ACTION_HANDLERS`). The current file structure (verified against `api/bot/messages.ts:210-251`) already has the invoke dispatch we'll hook into.

```ts
// ── Sales-lead forwarder (fasttrax-web handles state + card updates) ───────
//
// fasttrax-web owns the sales-leads feature end-to-end, but sends its
// Adaptive Cards using our shared bot identity. When a planner clicks
// Acknowledged / Contacted, Teams sends the invoke to THIS endpoint (the
// registered Azure messagingEndpoint). We forward `sales_lead_*` verbs to
// fasttrax-web over HTTPS + a shared secret; fasttrax returns the updated
// card, we pass it back to Teams as the invoke response.
//
// Portal keeps zero state about sales leads — this is a transparent pipe.

const SALES_LEAD_VERBS = new Set(['sales_lead_ack', 'sales_lead_contacted']);

const FASTTRAX_BOT_ACTION_URL =
  process.env.FASTTRAX_BOT_ACTION_URL || 'https://headpinz.com/api/teams/bot-action';
const PORTAL_FORWARD_SECRET = process.env.PORTAL_FORWARD_SECRET || '';

async function forwardSalesLeadAction(activity: any): Promise<any> {
  if (!PORTAL_FORWARD_SECRET) {
    throw new Error('PORTAL_FORWARD_SECRET is not configured');
  }
  const resp = await fetch(FASTTRAX_BOT_ACTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-portal-forward-secret': PORTAL_FORWARD_SECRET,
    },
    body: JSON.stringify(activity),
    // Teams invoke budget is ~15s. Keep fasttrax under 10s, leaving us buffer.
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    throw new Error(`fasttrax forward failed: ${resp.status} ${resp.statusText}`);
  }
  // Pass through whatever fasttrax returns — success card-replace OR
  // error-toast. Full shape is validated by Bot Framework on the way out.
  return await resp.json();
}
```

**Then, in the existing `invoke` handler** (currently lines 210-251 of `messages.ts`), insert the forwarder **before** the `ACTION_HANDLERS` lookup. Here's the relevant before/after — just the changed region inside `case 'invoke':`:

**Before** (current code, `messages.ts:217-235`):
```ts
          const actionVerb = activity.value?.action?.verb;
          const actionData = activity.value?.action?.data || activity.value?.data;
          const actionType = actionVerb || actionData?.action;

          if (!actionType) {
            return res.status(200).json({
              status: 400,
              body: 'Missing action type in card data',
            });
          }

          const actionHandler = ACTION_HANDLERS[actionType];
          if (!actionHandler) {
            console.warn(`Unknown bot action: ${actionType}`);
            return res.status(200).json({
              status: 400,
              body: `Unknown action: ${actionType}`,
            });
          }
```

**After**:
```ts
          const actionVerb = activity.value?.action?.verb;
          const actionData = activity.value?.action?.data || activity.value?.data;
          const actionType = actionVerb || actionData?.action;

          if (!actionType) {
            return res.status(200).json({
              status: 400,
              body: 'Missing action type in card data',
            });
          }

          // ── Sales-lead verbs → forward to fasttrax-web ──
          if (SALES_LEAD_VERBS.has(actionType)) {
            try {
              const result = await forwardSalesLeadAction(activity);
              // fasttrax can return EITHER a success card-replace shape OR
              // an error-toast shape (`application/vnd.microsoft.error`).
              // Pass its full response through verbatim — do not reconstruct.
              return res.status(200).json(result);
            } catch (err: any) {
              console.error('[SalesLead forward]', err?.message);
              // CRITICAL: on local failure (fetch error, timeout) we return
              // an ERROR-TOAST response, NOT a replacement card. Teams shows
              // the clicker a small error popup; the original card stays
              // intact for everyone else. Replacing the card on every forward
              // hiccup would destroy the chat history.
              return res.status(200).json({
                statusCode: 502,
                type: 'application/vnd.microsoft.error',
                value: {
                  code: 'BadGateway',
                  message: `Sales lead update failed: ${err?.message || 'forward error'}`,
                },
              });
            }
          }

          const actionHandler = ACTION_HANDLERS[actionType];
          if (!actionHandler) {
            console.warn(`Unknown bot action: ${actionType}`);
            return res.status(200).json({
              status: 400,
              body: `Unknown action: ${actionType}`,
            });
          }
```

The forwarder block goes **between** the `if (!actionType)` early-return and the `ACTION_HANDLERS[actionType]` lookup. No existing handlers are affected — the `SALES_LEAD_VERBS` set is tight and won't conflict with portal verbs (`acknowledge_break_alert`, `acknowledge_work_order`, `close_work_order`, `submit_close_work_order`, `select_location`).

### 2. Env vars

Add in Vercel (production + preview) AND in local `.env.local`:

```
FASTTRAX_BOT_ACTION_URL=https://headpinz.com/api/teams/bot-action
PORTAL_FORWARD_SECRET=<same value as in fasttrax-web/.env.local>
```

The same `PORTAL_FORWARD_SECRET` value lives in both repos' envs — that's how fasttrax-web authenticates the incoming invoke as coming from the portal (header: `x-portal-forward-secret`). When rotating, update both at the same time.

Current value already chosen and in `fasttrax-web/.env.local`:
```
PORTAL_FORWARD_SECRET=c7f3b21e9d4a58b6e0f17c9d3a42b85e6f981c0b2d4e7a5c8f9b0d1e2f3a4b5c
```

### 3. No other changes

- **Do not** import anything from fasttrax-web. The forwarder is fetch-over-HTTPS only.
- **Do not** add handlers to `ACTION_HANDLERS` for sales-lead verbs — they're intercepted before that lookup.
- **Do not** change the bot manifest or Azure registration. Same bot app, same messaging endpoint.

---

## Why this flow?

Three options were considered (see plan §3c):

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Portal forwards sales-lead invokes to fasttrax** | No Azure changes, no new Teams install, portal stays primary handler | Small cross-repo coupling | **Chosen** |
| B. Register a second Azure bot for fasttrax | Clean separation | New Teams app install, planners add new bot to each chat, more ops surface | Rejected — too much friction |
| C. Move messaging endpoint to fasttrax, forward non-sales to portal | Inverse of A | Portal traffic is higher, worse coupling | Rejected |

---

## Testing the portal change in isolation

Before fasttrax-web is fully live you can verify the forwarder works:

1. Deploy the portal with the changes.
2. Set `FASTTRAX_BOT_ACTION_URL` temporarily to a webhook.site URL.
3. From any Teams chat the bot is installed in, send yourself a test Adaptive Card with an `Action.Execute` using verb `sales_lead_ack` and data `{ projectID: 999 }`.
4. Click the button.
5. Portal logs: `[SalesLead forward]` — confirms interception path.
6. webhook.site should receive the full invoke envelope with the `x-portal-forward-secret` header.

When pointed at the real fasttrax URL, Teams will show the updated card back from fasttrax's response within ~1-2s.

---

## Troubleshooting

### Symptom: clicker sees `⚠ Sales lead update failed: fetch failed`

Portal's `forwardSalesLeadAction` caught a network error reaching fasttrax. Root causes:

1. **fasttrax is only running locally** (`localhost:3000`) but `FASTTRAX_BOT_ACTION_URL` points at a production URL that doesn't have the `/api/teams/bot-action` route shipped yet.
   - Short-term: point `FASTTRAX_BOT_ACTION_URL` at an ngrok tunnel during local development:
     ```
     ngrok http 3000
     # copy the https URL, e.g. https://abc123.ngrok-free.app
     # set in Portal's Vercel env:
     FASTTRAX_BOT_ACTION_URL=https://abc123.ngrok-free.app/api/teams/bot-action
     ```
   - Long-term: deploy fasttrax-web to `headpinz.com` (or wherever) so the URL resolves in prod.
2. **DNS / network** — verify from a serverless context (not your laptop) that the URL is reachable: `curl -I $FASTTRAX_BOT_ACTION_URL` from a Vercel function.
3. **fasttrax returning non-200 at the HTTP layer** — check fasttrax logs. Route-level errors should come back as proper invoke-response JSON, but a 500 before that layer would trigger this error branch.

The error shows a **toast** now (not a card replacement), so the original card stays intact in the chat and users can retry.

### Symptom: clicker sees `⚠ Action failed: …` but the card IS replaced

That's the OLD behavior from before this spec was updated. Pull latest — the forwarder now returns `application/vnd.microsoft.error` responses instead of adaptive-card replacements on failure paths.

## Rollback

Single-file change. Revert the edits to `api/bot/messages.ts` and remove the two env vars. No data migrations, no manifest changes.

---

## Checklist for the agent running this PR

- [ ] Pull latest `main` in `C:\GIT\Tools-Team-Member-Portal`
- [ ] Create branch (e.g. `sales-lead-forwarder`)
- [ ] Edit `api/bot/messages.ts` per § 1 above
- [ ] Run existing portal test suite / type-check (`npm run build` if that's the pattern)
- [ ] Commit with message: `feat(bot): forward sales_lead_* invokes to fasttrax-web`
- [ ] Push + open PR
- [ ] After merge, set `FASTTRAX_BOT_ACTION_URL` + `PORTAL_FORWARD_SECRET` in Vercel env for portal
- [ ] Verify locally with the webhook.site test above, then with the real fasttrax endpoint

Nothing else in the portal repo should change. If anything else comes up, flag it — don't guess.
