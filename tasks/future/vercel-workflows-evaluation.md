# Architectural option: Vercel Workflows (and Queues)

> **Cross-cutting reference, not a feature plan.** Saved 2026-05-03
> after evaluating https://vercel.com/docs/workflows AND
> https://vercel.com/docs/queues against our current flows. Use this
> doc when designing ANY new feature that has orchestration,
> durability, or "wait for time/event" needs — not just e-tickets,
> not just KBF, not just race packs. The "Decision rule" section
> near the bottom is the quick check.
>
> **Queue vs Workflow:** Workflows are built on top of Queues. Queue
> = stateless event reactor (cheap, portable, simple). Workflow =
> Queue + state across time (sleeps, hooks, replay-determinism).
> Pick the smaller primitive when the state can live externally.
> The "Per-flow primitive choice" table below has the breakdown.

## What it is

A managed engine for **durable, pausable functions** on Vercel. The
`'use workflow'` and `'use step'` directives turn ordinary async
functions into durable orchestrations:

- **Suspend/resume across minutes/months** — `await sleep('7 days')`
  with zero compute cost while paused.
- **Automatic step retries** on transient failure (network errors,
  Lambda crashes).
- **Survives deploys** — replays deterministically from the event log.
- **Hooks** — pause and wait for an external webhook to wake the
  workflow up (`approvalHook.create()` then `approvalHook.resume()`).
- Built-in observability per run in the Vercel dashboard.

```ts
// Workflow shape — async/await, no YAML, no state machine.
export async function exampleWorkflow(input: string) {
  'use workflow';
  const a = await stepOne(input);   // built-in retries
  await sleep('24 hours');           // zero compute while paused
  const b = await stepTwo(a);        // resumes here next day
  return { a, b };
}

async function stepOne(input: string) {
  'use step';
  // any external API call — auto-retried on transient failure
}
```

Pricing is **usage-based** (Events + Data Written + Data Retained).
Not free — replaces some compute but adds platform cost.

## Why we're NOT migrating existing flows

| Current flow | Why workflow doesn't help |
|---|---|
| POV deposit retry sweep (Neon table + 5-min cron) | Works, observable in SQL, costs $0 per retry. Migrating adds platform billing without solving a problem. |
| Race pack sale → BMI deposit | Sync charge is customer-blocking; the retry queue (Neon) is already durable and audit-friendly. |
| KBF reservation (4 QAMF calls) | Customer-blocking; pause/resume superpower doesn't apply. |
| Pre-race-tickets / check-in-alerts crons | Cron's "every N min, do as much as possible in 60s" model is the right shape — workflow would over-engineer it. |
| `/api/pov-codes` claim | Request-bounded; customer is waiting. The 2026-05-03 502 incident was solved by removing self-fetches, not by adding orchestration. |

**Existing flows: leave alone.** They work, cost ~$0 per execution, and
all failure modes are well-understood. Don't migrate for migration's
sake.

## Where to reach for it (future work — any feature area)

These are all genuine workflow-shaped problems spanning different
feature areas. Build them WITH workflows instead of reinventing
durable orchestration with cron + ad-hoc state tables. The list
below is illustrative — the decision rule applies to anything new
we build.

### 1. KBF self-registration (in-app account creation)

Cross-references `tasks/future/hp-arena-etickets.md` open item.

```
chargeAttempt → submitToKbfDotCom → sleep('24 hours') →
  pollNextCsvSync → if found: emailCustomer; if not: alertAdmin
```

The 24-hour wait is the killer feature — today we'd need a daily cron
that scans pending registrations. Workflow: `sleep('24 hours')` and
the runtime handles it.

### 2. Race-credit expiration reminders

For race packs sold via `/api/square/pay` with `viaDeposit: true`. One
workflow per purchase:

```
sleep('60 days') → checkBalance → if unused>=1: emailNudge →
  sleep('29 days') → checkBalance → if unused>=1: emailFinalWarning →
  sleep('2 days') → if unused>=1: markExpired + adminReport
```

Today this would be a cron that scans every deposit row daily. Brutal
to write, easy to mess up. Workflow per pack is elegant.

### 3. HP Arena bookings with waiver gating

When the HP Arena e-ticket plan ships (`tasks/future/hp-arena-etickets.md`):

```
onBooking → if waiverOnFile: confirm; else:
  waiverHook.create({token: bookingId})
  → on hook: sendConfirmation
  → sleep('1 hour before booking time')
  → if no hook fired: smsReminder + alertStaff
```

Hook = waiver-signed webhook from BMI. Multi-step + external event +
deadline = workflow's sweet spot.

### 4. Referral / loyalty multi-touch (if we ever build it)

Any "send touchpoint X days after Y" sequence. Welcome series, rookie
follow-ups, lapsed-customer re-engagement. All trivially expressible
as workflow + sleep.

### 5. POV code expiration / cleanup (low priority)

Each POV code in the pool has no expiration today. A workflow per
code with `sleep('1 year')` could clean up unused codes. Probably not
worth it — pool is small enough that staff can manage manually.

### 6. Wallet pass generation (Apple + Google)

Existing TODO from MEMORY.md. When we build this, it should be a
workflow fired from booking-confirmation:

```
generatePass → uploadToAppleWalletService (retry on transient) →
  uploadToGoogleWalletService (retry) → emailLinks → sleep(until raceTime+1h) →
  if pass not added: smsReminder
```

Async, retryable, customer-not-blocking — textbook workflow.

### 7. Booking cancellation cleanup

When a customer cancels (or we auto-cancel a stale hold):

```
markCancelled → refundSquare (if charged) → reverseDepositIfPack →
  invalidateTicketRecords → emailCustomer → adminNotify
```

Multi-step, each can fail independently, no customer waiting on the
synchronous response (cancel UI returns immediately).

### 8. Pre-arrival reminder series (multi-touch)

Today the `pre-race-tickets` cron handles a single 2h-before window.
If we ever want multi-touch (24h before / 1h before / 15min before),
that's a workflow per heat:

```
sleep(raceTime - 24h) → send24hReminder →
  sleep(raceTime - 1h)  → send1hReminder →
  sleep(raceTime - 15m) → send15mReminder
```

vs. building three separate cron windows + dedup logic for each.

### 9. Post-visit feedback / NPS

```
sleep(raceTime + 1h) → if customer arrived: sendFeedbackAsk →
  hook.wait('7 days') → if responded: routeToFeedbackTable; else: skip
```

One workflow per booking. No daily-scan cron needed.

## Existing booking + e-ticket pipeline analysis

When evaluated specifically against the booking + e-ticket process
(`/book/race`, `/book/race-packs`, `/hp/book/*`, the post-confirm
crons, the customer e-ticket pages), nothing should be MIGRATED.

Reasoning:
- **Booking-confirmation route** (the SMS/email/sales_log fan-out) is
  inline today. Could be a workflow but it's the highest-traffic
  revenue path; migration risk outweighs the cleanup win.
- **Pre-race-tickets / checkin-alerts / video-match crons** are
  polling-shaped because Pandora doesn't expose webhooks for
  "heat called" / "video ready" events. Workflows' superpower
  (`sleep` + `hook`) requires push events to be useful. Without
  Pandora push, polling is the right tool.
- **POV deposit retry sweep** is already durable in Neon with a
  cron-driven retry. Migrating to workflows trades a $0/event Neon
  table for per-event workflow billing without changing failure
  semantics.
- **Customer e-ticket page** (`/t/[id]`, `/g/[id]`) is browser-side
  polling — out of scope for server-side workflows entirely.
- **Sync booking flows** (Square charge, BMI book-for-later, QAMF
  reservation) are customer-blocking. Workflow's pause/resume can't
  help when there's a human waiting on the response.

The one architectural shape worth keeping in mind: **per-booking
lifecycle workflow**. Instead of polling crons that scan every
booking every N minutes, fire one workflow per booking at confirm
time that handles every downstream touchpoint via `sleep`. This
becomes obviously correct the moment Pandora exposes any kind of
push event (heat called, video ready, etc.) — because then the
polling cron's reason-for-existing evaporates and the workflow's
hook + sleep model is strictly cleaner. Until then, leave it.

## Trigger condition met for VT3 / video-match (2026-05-03)

The user captured a HAR of the VT3 control panel that revealed VT3
**already exposes an SSE event stream** at:

```
GET  https://sys.vt3.io/videos/events
POST https://sys.vt3.io/sse/{sessionId}/ack
```

Same host (`sys.vt3.io`) and presumably same JWT auth we already use
for the polling cron at `app/api/cron/video-match` (which hits
`sys.vt3.io/videos` every 2 minutes). The control panel keeps the
SSE connection open and ACKs each event the server pushes — video
created, sample uploaded, processed, etc.

**This is the push-event source the rest of this doc was waiting for.**
The decision-rule criterion "spans hours/days OR needs to wait for
external event" is now satisfied for the video-match flow.

### Recommended adoption path (NOT a build plan yet — capture first)

1. **Capture a longer HAR** of the VT3 control panel during a busy
   race window so we can see the actual event schemas — what events
   fire, what the payload shape is, when ACKs are required.

2. **Ask VT3 if they offer webhooks** as an alternative to SSE.
   Webhook delivery removes the long-lived-connection problem
   entirely; we expose `/api/webhooks/vt3-video-event` and they POST
   each event to us. **This is the cleanest solution if available.**

3. **If no webhook offered, run a small external SSE bridge worker.**
   Vercel serverless can't hold a 60s+ SSE connection (60s function
   ceiling). A tiny Railway/Fly.io worker (~$5/mo) opens the SSE
   stream 24/7 and forwards each event to our webhook endpoint.
   Adds one external service to ops surface but solves the runtime
   gap.

4. **Wire the webhook to existing `lib/video-match.ts` logic.** Same
   matching code, just triggered by push instead of pulled by cron.
   Delete `/api/cron/video-match` from `vercel.json` once the
   webhook path is proven.

5. **Then build the per-booking workflow.** With "video ready" as a
   hook, the workflow shape becomes:

```ts
async function videoLifecycle(bookingId: string) {
  'use workflow';
  const booking = await loadBooking(bookingId);
  for (const heat of booking.heats) {
    await sleep(until(heat.scheduledStart, '+5m'));
    const event = await Promise.race([
      videoReadyHook.create({ token: heat.sessionId, timeout: '4h' }),
      sleep('4h').then(() => null),
    ]);
    if (event) await sendVideoReadySms(heat, event);
    else await markVideoMissing(heat);
  }
}
```

### Wins

- **Polling deleted.** Today: 720 hits/day to `sys.vt3.io/videos`
  (every 2 min × 24h). With push: 1 connection open, zero polling.
- **Latency drops to ~real-time.** Today: 5-30 min upload + up to 2
  min poll latency. With push: 5-30 min upload + ~1s. The cron
  latency disappears entirely.
- **Workflows justify themselves.** With a real push event, the
  per-booking lifecycle workflow described above becomes the
  obviously-correct architecture — exactly the trigger condition
  this doc has been waiting for.

### Open items before adoption

- HAR with longer capture to enumerate event types + payloads.
- Confirm with VT3 whether webhooks are an option.
- Decide on bridge-worker host (Railway / Fly / Cloudflare Worker
  with Durable Objects) if SSE-only.
- Auth model for our SSE consumer — JWT presumably, but confirm.
- Reconnect / replay semantics — what does VT3 do if our consumer
  disconnects? Do they replay missed events on reconnect, or do we
  fall back to the cron as a backstop?

## Per-flow primitive choice

When you have a flow that's a candidate for queue-or-workflow, ask:
**where does the state live?** If it's already external (Redis, Neon,
Pandora records), Queue. If the state is "where am I in this
sequence and how long until the next thing," Workflow.

| Flow (current or future) | Queue or Workflow? | Why |
|---|---|---|
| **VT3 video-match** (existing cron migration) | **Queue** | State already in Redis match records. Each event is a stateless reactor: load record by code, switch on innerType, update overlay or notify. No sleep needed. |
| **Race-pack deposit retry** (current Neon table + sweep) | **Queue** (already this) | Existing implementation IS a queue + cron consumer. Works fine. |
| **Wallet pass generation** (future) | **Queue** | Stateless: receive booking → generate Apple + Google → email links. |
| **POV deposit-deduct retry** (current Neon table) | **Queue** (already this) | Same — table-driven retry with cron consumer. |
| **Race-credit expiration reminders** (future) | **Workflow** | The 60d / 89d / 91d sleep cascade IS the logic. Queue version would need a delayed-message scheduler + state table. |
| **KBF self-registration** (future) | **Workflow** | 24h sleep waiting for next CSV sync is the core of the flow. |
| **HP Arena waiver gating** (future) | **Workflow** | Hook with deadline (`Promise.race(hook, sleep)`) is the whole pattern. |
| **Post-visit NPS / feedback** (future) | **Workflow** | One sleep, one send. Trivially expressed. |
| **SMS retry sweep** (current cron) | **Queue** (already this) | Stateless retry pattern — current `lib/sms-retry.ts` is essentially a hand-rolled queue consumer. |
| **Booking cancellation cleanup** (future) | **Workflow** | Multi-step + each step retryable + would otherwise be cron+state. |

The pattern: **stateless event reactors → Queue. State-across-time
orchestration → Workflow.**

## Decision rule (consult this before designing any new feature)

Reach for Vercel Workflows when ALL of these are true, regardless of
whether the feature is racing, KBF, HP Arena, attractions, or
something we haven't dreamed up yet:

1. The flow is **NOT customer-blocking** (no one is waiting on a
   synchronous response).
2. The flow **spans hours, days, or longer** OR needs to wait for an
   external event (webhook, third-party API callback).
3. **Each step is independently retryable** — failure of one step
   shouldn't undo the whole flow.
4. You'd otherwise build a cron + state table to coordinate it.

If any of those is false, regular Lambda + Redis/Neon is the right
tool. Don't reach for workflows just because they're shiny.

## Open questions before adoption

1. **Cost ceiling.** Pricing is per-event. For ~10k race-credit
   purchases/year × 4 events per workflow = 40k events. Need to model
   what that costs vs. cron-based polling.
2. **Lock-in.** Workflows are a Vercel-managed primitive; migrating
   away later would mean rewriting orchestration. Acceptable for
   non-critical flows; revisit if we ever explore platform diversity.
3. **Testing locally.** Need to confirm dev-time replay / observability
   works without a Vercel deployment. (Probably fine via the
   workflow-sdk.dev open-source SDK.)
4. **Skew Protection** is on by default — existing runs stay on the
   deployment they started on. Worth understanding the implications
   before shipping breaking workflow changes.

## When this becomes a real plan

This doc is the cross-cutting architectural option. When ANY future
feature plan (`tasks/future/<name>.md`) needs orchestration, link
back to this doc instead of re-deriving the trade-offs. Examples of
plans that should reference this:

- `tasks/future/hp-arena-etickets.md` (waiver gating step #3 above)
- Any future race-credit expiration plan
- Any future KBF in-app registration plan
- Any future loyalty / referral / multi-touch outreach plan
- Any future feature where step (1) of the decision rule is "no
  customer is waiting for a synchronous response"

If a plan triggers all four conditions in the Decision Rule, the
default architecture should be Vercel Workflows. Deviate only with
a documented reason.
