# Lessons Learned

## Full-prepay group events never paid out day-of — two coupled bugs (2026-06-03)

"Hayes Birthday Party" should have auto-paid on the event day, but `/api/cron/group-dayof-pay`
reported `checked=0`. Real-DB inspection found two independent root causes in the group-function
payment pipeline:

**1. The status machine didn't model "fully funded at deposit."** Events booked within 96h
require full payment upfront (`fullPaymentRequired` in `group-quote-dispatch`:
`deposit_due_cents = total_cents` ⇒ `balance_cents = 0`). The ONLY code that advances
`deposit_paid → balance_charged` is the balance-charge cron's `processBalanceCharge`, which
opened with `if (quote.balance_cents <= 0) return "auto_charged";` — returning WITHOUT setting
status. So prepaid events stayed `deposit_paid` forever, and BOTH `group-dayof-pay` and
`group-dayof-close` (which gate on `status='balance_charged'`) silently skipped them. Once the
event time passed, balance-charge stopped selecting them too (its `event_date > NOW()` guard) ⇒
permanently orphaned: gift card fully funded, day-of order OPEN and never paid. Fix:
`updateGfBalancePrepaid()` advances $0-balance deposits to `balance_charged`.

**2. Day-of order catalog creation always failed; the lone ad-hoc fallback had no retry.**
`buildSquareLineItem` sent `catalog_object_id` + `quantity` but no `base_price_money`. Group
catalog variations are *variably priced*, so Square hard-rejected every catalog attempt:
`"variably priced and requires a value for base_price_money"`. The system limped on the ad-hoc
fallback, but a single transient failure of that one attempt at deposit time orphaned the
day-of order with no retry (10 events had accumulated a NULL `square_dayof_order_id`). Fixes:
(a) include `base_price_money` on catalog line items; (b) self-heal — `group-quote-sync` now
backfills any deposit-paid event missing its day-of order, via a shared `createDayofOrder` in
`lib/group-function-dayof.ts` (single source of truth; was previously duplicated 3×).

**Guardrails:**
- A payment state machine MUST handle the $0 / already-funded edge explicitly. A short-circuit
  `return` that skips the state transition is a silent trap — the "nothing to do" branch still
  has to advance state.
- Best-effort creation of an external resource on a hot path must be retried/self-healed, never
  fire-once-or-orphan. Sweep or surface the failures.
- When two crons gate on the same status, one missed transition breaks BOTH — trace every
  consumer of a status before assuming a quote will progress.
- Verify against real data: `node --env-file=apps/web/.env.local -e "<neon SELECT>"` pinpointed
  the exact failing column far faster than reasoning from code alone.

## Google ignores schema.org `eventSchedule` — Events need an explicit `startDate` (2026-06-02)

Google Search Console flagged our recurring-event JSON-LD (Mega Track Tuesday,
HeadPinz Trivia Tuesday, Midnight Madness) as ineligible. Root cause: the shared
`recurringEventSchema` (`apps/web/components/seo/JsonLd.tsx`) described recurrence
**only** via `eventSchedule` → `Schedule` (`byDay`/`repeatFrequency`/`scheduleTimezone`)
and had **no `startDate`**.

**Google's Event rich results do NOT read `eventSchedule`/`Schedule` at all.** It's
valid schema.org (fine for other consumers) but Google-blind. Google requires an
explicit ISO-8601 **`startDate` on the Event itself** — one of only three required
fields (`name`, `startDate`, `location`). No `startDate` ⇒ "Missing field 'startDate'"
⇒ ineligible. (`performer`/`offers`/`endDate` are recommended-only — yellow warnings,
never the hard error.)

Fix pattern for recurring events: compute the **next occurrence at render time** and
emit a concrete `startDate`/`endDate` (ISO-8601 **with the DST-aware ET offset** —
derive it via `Intl.DateTimeFormat(..., { timeZone, timeZoneName: "longOffset" })`,
never hardcode `-05:00`). Emit **one Event per recurring day**. Anchor day math at
**noon UTC** so adding days never trips the 2 AM DST boundary.

Coupled gotcha: a computed "next occurrence" **freezes at build time** on statically
rendered pages. Pages that render these schemas must set `export const revalidate`
(we use daily) so the dates roll forward. Don't assume deploy cadence will refresh them.

## Pandora product `tax` is a RATE, not a dollar amount (2026-05-30)

Each product in the Pandora `/v2/bmi/reservation` response carries `tax` as a
**per-line tax RATE** (e.g. `0.065` = 6.5%), NOT a dollar amount. Verified live on
reservation `49220090`: every product had `tax: 0.065`.

**Line tax = `rate × line-total`.** The old formula was:

```ts
taxTotal = products.reduce((s, p) => s + ((p.tax || 0) * p.total) / (p.price || 1), 0);
```

`(tax * total) / price` reduces to `rate × qty`, which under-counted tax by the unit
price. On 49220090 it produced **$0.65** instead of **$63.76** (`0.065 × 980.95`). The
bug was duplicated in two places, so it was extracted into one helper:
[apps/web/lib/group-function-pricing.ts](apps/web/lib/group-function-pricing.ts)
(`subtotalCents`, `taxCents`) — used by `bmi-scan`, both group-quote crons, and the backfill.

Two coupled gotchas the tax bug had masked (tax was ≈$0, so nobody noticed):
- **`total_cents` is the tax-INCLUSIVE grand total** everywhere (contract page, signed PDF,
  Square deposit/day-of orders: deposit = total/2, balance = total − deposit). The dispatch
  cron's normal path stored a tax-EXCLUSIVE total; now `+ taxCents`.
- The sync cron recomputed tax **without** honoring `isTaxExempt(...)` (dispatch did) — fixed.

Existing rows don't self-heal (dispatch only re-scans "Send Contract"; sync only recomputes
tax on product change). One-time fix:
[apps/web/app/api/cron/group-quote-tax-backfill/route.ts](apps/web/app/api/cron/group-quote-tax-backfill/route.ts)
— recomputes unpaid quotes, reports (read-only) on already-paid quotes that under-collected.
Run dry-run first: `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/group-quote-tax-backfill?dryRun=1`,
then `?dryRun=0`.

## Post-paid approval requests must LEAVE "Send Contract" or they loop forever (2026-06-01)

The group-quote-dispatch cron (`* * * * *`, every minute) scans BMI for projects in
**"Send Contract"** state and processes each one. The normal (deposit) path transitions
BMI **"Send Contract" → "Pending Signed Contract"** after sending, so the next scan skips it.
The post-paid hold-for-approval branch did **not** — it set `status='pending_approval'`,
fired `notifyApprovalNeeded()`, and returned, leaving the project in "Send Contract." Result:
**an approval email to management every minute, forever — even after a decline.**

Two coupled bugs:

1. **The trigger is the BMI state, not the DB status.** Nothing can "wait for another Send
   Contract" if the item never leaves Send Contract. Fix: the moment we hold for approval,
   move BMI out of "Send Contract" (→ Pending Signed Contract), mirroring the sent path.
   Then a decline sits dormant, and sales re-flipping to "Send Contract" is the deliberate
   signal to re-request approval.

2. **The reset block re-inserted and would hit the unique index.** When a `cancelled`/`denied`/
   `expired` quote reappears, the reset block set `existing = null` then the create path called
   `insertGfQuote` — which has **no `ON CONFLICT`** against the UNIQUE index on
   `bmi_reservation_id` (`group-function-db.ts`). So "clear the denial and ask again" would have
   thrown on the duplicate insert. Fix: reset the row **in place** (`UPDATE ... RETURNING *`),
   keep `existing` pointing at it, and clear the approval/denial columns too
   (`approved_at`, `denied_at`, `denial_reason`, `approval_memo`, …). Don't stamp
   `hermes_last_processed_at` in the reset, or the 60s debounce skips the same-run reprocess.

Lesson: any cron that consumes a BMI workflow state must transition the project OUT of that
state on **every** terminal branch (sent, held-for-approval, error-park) — not just the happy
path — or the scan re-triggers it indefinitely.
[apps/web/app/api/cron/group-quote-dispatch/route.ts](apps/web/app/api/cron/group-quote-dispatch/route.ts)

## Neon sql template tag consumes `::type` as parameter type hints (2026-05-09)

The `@neondatabase/serverless` `sql` tagged template treats `${value}::type`
specially — it consumes `::type` as a parameter type hint (setting the OID)
and strips it from the SQL text sent to Postgres. This means:

```typescript
q`WHERE col >= ${date}::date AT TIME ZONE 'America/New_York'`
```

Does NOT produce `$1::date AT TIME ZONE 'America/New_York'`. Instead the
driver strips `::date`, and Postgres sees `$1 AT TIME ZONE 'America/New_York'`
where `$1` is a text parameter. The result is silently wrong — no error,
just incorrect boundaries.

**Fix:** Apply `AT TIME ZONE` on the column side instead:
```typescript
q`WHERE (col AT TIME ZONE 'America/New_York')::date >= ${date}::date`
```

This is unambiguous: Postgres casts the column to ET, extracts the date,
and compares against the parameter's date value. The `::date` on the
parameter still works fine as a type hint (date vs text doesn't matter
for a simple `>=` comparison).

**Rule:** Never put `AT TIME ZONE` after a template-tag parameter cast.
Always apply timezone conversion on the column or a literal expression.

## QAMF probe times MUST be multiples of 5 minutes (2026-05-09)

QAMF's `searchAvailability` API rejects any `BookedAtRange` where minutes
aren't divisible by 5. Error: `400 "The minutes must be multiples of 5."`

**What happened:** We added a "don't probe the past" guard that computes
`earliestMin = currentETTime + 15`. When the current time was e.g. 6:36 PM,
`earliestMin = 1131` (18h 51m). Every 15-min probe from there — 18:51, 19:06,
19:21 — had non-5-divisible minutes. QAMF rejected ALL of them, `.catch()`
swallowed the 400s, and the API returned `{Availabilities: []}`. This looked
like "sold out" to customers on a busy Saturday night.

**Why it was intermittent:** Only fails when `currentMinute + 15` isn't already
on a 5-min boundary. Test at 6:00 PM → fine. Test at 6:36 PM → total failure.
Future dates never hit this because `openHour * 60` is always clean.

**Why it was hard to find:** Three compounding issues:
1. `.catch(() => ({ Availabilities: [] }))` silently swallowed every 400 error
2. Vercel was serving stale serverless functions — console.log statements from
   new deployments weren't appearing in runtime logs
3. The experiences API worked fine (different code path), so DB filtering was
   ruled out as the cause

**Fix:** `earliestMin = Math.ceil(earliestMin / 15) * 15` snaps to the next
clean quarter-hour.

### Rules for future QAMF integration:
- **ALWAYS snap probe times to 15-min boundaries** (or at minimum 5-min)
- **NEVER silently swallow QAMF errors** — log the first few, include error
  count in the summary line
- **When Vercel logs don't show your console.log, suspect stale functions** —
  force a new deployment or check the build logs for cache hits
- **When debugging "no availability," check probe error count FIRST** — if
  `errors === probes`, the issue is probe construction, not QAMF capacity

## pnpm + Vercel = quagmire — switched to npm workspaces (2026-05-06)

The monorepo restructure (PR1) originally chose pnpm + Turborepo. After three
failed Vercel deploys and ~6 hours of debugging, we abandoned pnpm in favor of
npm workspaces + Turborepo. The architecture (workspaces, `apps/`, `packages/`,
Turbo orchestration) is unchanged — only the package manager flipped.

### What went wrong, in sequence

1. **PR1 added a workspace-root `pnpm-lock.yaml`** while leaving Vercel's
   project root at `apps/web/`. The plan said "Vercel impact: none." Wrong.
   **Vercel walks UP from the configured project root looking for any lockfile.**
   Finding `pnpm-lock.yaml` at the repo root caused Vercel to switch from
   `npm install` to `pnpm install` in `apps/web/` even though nothing inside
   that directory changed. Build failed with `ERR_PNPM_META_FETCH_FAIL` and a
   cascade of `ERR_INVALID_THIS` registry errors on every package fetch.

2. **First fix (pnpm@9.15.4 → 10.4.1):** thinking the URLSearchParams bug was
   pnpm 9-specific. Wrong — early pnpm 10.x patches (10.0–10.5) still had the bug.

3. **Second fix (pnpm@10.4.1 → 10.33.4 + Node 22.11.0 pin):** thinking Node 22.13+
   was the trigger. Vercel ignored the Node pin and ran Node 24 anyway.

4. **Third fix (Vercel Install Command override: `npm install -g pnpm@10.33.4 && pnpm install`):**
   `npm install -g` succeeded but Vercel's bundled pnpm at a higher PATH priority
   kept being invoked. Build log still showed "Ignoring not compatible lockfile"
   — proof the new pnpm wasn't actually running.

5. **Fourth attempt (corepack):** still same error pattern. Time burned vs
   value gained had crossed the line. Pulled the plug.

### Resolution

Switched to **npm workspaces + Turborepo** on 2026-05-06:

- Deleted `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `apps/web/package-lock.json`.
- Root `package.json` now has `"workspaces": [...]`, `"packageManager": "npm@11.6.4"`,
  no pnpm-specific fields.
- Vercel install command override turned OFF (Vercel auto-detects npm from
  the root `package-lock.json`).
- Local + Vercel build green in one push.

### What we lost vs what we kept

**Lost:** pnpm's strict isolated `node_modules`. Transitive deps now hoist —
`apps/web/eslint.config.mjs` can import `eslint-plugin-jsx-a11y` without
declaring it in `apps/web/package.json` (it's pulled transitively via
`eslint-config-next`). We're not catching that class of bug at install time
anymore. Acceptable trade-off; we can add `depcheck` or `knip` to CI later if
it becomes a real problem.

**Kept:** the entire monorepo architecture, Turbo orchestration, all v2
conventions, deploy targets — everything in `tasks/restructure-plan.md` is
package-manager-agnostic.

### Lessons that survive

**Rule 1:** When a workspace-level lockfile appears at the repo root for the
first time, treat it as a deploy-tooling change *regardless* of where the deploy
provider's project root points. Vercel walks up; so does most CI. Verify with a
preview deploy BEFORE asserting "no deploy impact" in any PR description or plan.

**Rule 2:** When debugging "works locally, fails on Vercel" issues, the FIRST
thing to confirm is the build log header: actual Node version, actual package
manager version, actual install command. Vercel's defaults shift over time and
silently override file-based pins (`engines.node`, `.nvmrc`) more often than the
docs suggest. Don't propose fixes until you've seen the log header.

**Rule 3:** Boring tooling for production deploys. pnpm has real benefits but
its tighter coupling to specific Node/undici versions makes it fragile on managed
build platforms whose runtime drifts. npm is slow and inelegant but it's what
Vercel/Netlify/Render/etc. test against, so it's what works. **For a small team
on a managed platform, pick the package manager the platform considers default,
not the one with the best ergonomics.**

**Rule 4:** Time-box exotic fixes. We pushed three commits (`51194bf`,
`f0e3e5b`, `ea3704a`) chasing pnpm before pulling the ripcord. The signal "I've
made three commits and the same error class is still firing" is a strong cue to
abandon the current approach and try something fundamentally different.

**Rule 5:** If you ever consider switching back to pnpm, read this lesson first.
Do not assume the URLSearchParams + Vercel-bundled-pnpm + Node-default-LTS issues
are resolved — verify on a preview deploy with no install command override
before any merge. The ergonomic upside is real but the deploy risk is too.

## Multi-source data — read BOTH live AND cached, cascade (2026-05-02)

**The confirmation page kept biting us when one source was stale or
missing.** Twice in the same week:

1. POV claim only checked `parsedOverviews` (the OrderSummary
   pre-payment snapshot) — never the live `overview` from BMI.
   Fast-confirming bookings sometimes had an empty snapshot at
   page-load time but a fully-populated live overview. Claim path
   silently found no POV line → no codes claimed → empty SMS, empty
   email, empty BMI memo. Customer paid for video, got nothing.
   Reported by ops on W33861 / W33835 after a customer noticed.

2. Earlier same day: line names were rendering "Intermediate Race
   Mega" on confirmation pages because BMI's `bill/overview` returned
   that as the public name on a package-only Blue Track SKU. The
   single-source code trusted BMI; the fix cascaded through our own
   PACKAGES + RACE_PRODUCTS registries.

**Rule:** Whenever a feature reads a piece of state from one source
on the confirmation page, ask "what's the OTHER source for this same
data, and what happens when they disagree?" The pattern across the
file is `liveSource?.field || cachedSource?.field || fallback` —
follow it consistently. Specifically:

- Bill lines → `overview?.lines || parsedOverviews.flatMap(...)`
- Race names → cascade through `productDisplayNameFromPackages` →
  `getRaceProductById` → BMI `line.name`
- Booking record → `bookingRecord?.field` (from /api/booking-record
  Redis) is the post-checkout authoritative source; falls back to
  `details?.field` (booking-store) for in-flight values.

**Test rule:** Any customer-impacting confirmation flow needs at
least one test that simulates an empty `parsedOverviews` (fast
checkout where the snapshot wasn't written yet) and confirms the
feature still works via the live overview path.

## Idempotency on resource-consuming endpoints (2026-05-02)

`/api/pov-codes?action=claim` was popping new codes from the pool on
every call, no billId-level dedup. When staff backfilled codes for an
affected booking, a customer revisit would have popped a SECOND set
of codes — different from what's in the BMI memo — and silently
consumed pool inventory. Made the claim path scan `pov:used` for
existing billId entries and return them when found, with
`cached: true` in the response. Cost: one HSCAN per call (1-2 round
trips for the current pool size). **Rule:** any endpoint that
*consumes* shared inventory (codes, lane-holds, vouchers) must dedup
by the request's owning resource id (billId, sessionId, personId)
before allocating new resources from the pool.

## CRITICAL: BMI ID Precision Loss (2026-04-04)

**NEVER use `Number()` or `JSON.stringify()` on BMI person IDs or order/bill IDs.**

BMI IDs like `63000000000021716` exceed JavaScript's `Number.MAX_SAFE_INTEGER` (9007199254740991).
`Number("63000000000021716")` silently becomes `63000000000021720` — losing precision and causing
FK constraint violations or wrong person lookups in BMI.

**Rule:** Always inject BMI IDs as raw text in JSON payloads using string concatenation:
```ts
// BAD — precision loss
const body = JSON.stringify({ personId: Number(pid), orderId: Number(billId) });

// GOOD — raw injection
const body = `{"personId":${pid},"orderId":${billId},` + JSON.stringify(otherFields).slice(1);
// or append:
body = body.slice(0, -1) + `,"personId":${pid}}`;
```

**Affected endpoints:**
- `booking/book` — orderId and personId
- `person/registerContactPerson` — orderId and personId
- `person/registerProjectPerson` — orderId and personId
- `payment/confirm` — orderId
- `bill/cancel` — orderId in URL path (string, safe)
- `bill/overview` — billId as query param (string, safe)

**Pattern to follow:** See `bookRaceHeat()` in `data.ts` for the canonical example of raw JSON injection.

### INBOUND is the other half — `res.json()` corrupts ids BEFORE outbound protection runs (2026-06-03)

`stringifyWithRawIds` only protects the OUTBOUND direction. The dual bug bit us in production
(v1 booking off-by-one): the instant a BMI/Pandora **response** is read with `res.json()` or
`JSON.parse`, any 17-digit id that comes back as a bare JSON **number** is rounded to the nearest
multiple of 8 — `63000000003675359` → `63000000003675360` (+1). In the 2⁵⁵–2⁵⁶ band, **7 of 8**
ids corrupt, so this silently worsens as BMI's id counters climb / volume grows. A later raw
outbound injection can't help — the value was already destroyed on the way in.

**The TypeScript trap:** a field typed `personId: string` does NOT make it a string at runtime.
`JSON.parse` returns a `number` for `"personID": 633…`; the `as string` cast is a compile-time
lie. Don't trust the type — control the parse.

**What the 2026-06-03 audit actually found — MAGNITUDE matters, check it before "fixing":**
The instinct was to point at the obvious id sites, but live prod probing refuted every one. Don't
repeat these dead ends — each id space has a different width:

| Path | 17-digit `63…`? | Wire form | How we read it | Verdict |
| --- | --- | --- | --- | --- |
| Race/attraction booking `orderId`/`billId`/`orderItemId` (public-booking API) | **yes** | unquoted number | `res.text()` + regex (`extractRawOrderId`) | **safe** |
| BMI **Office** project entity `id`/`personId`/`number` (`office-api22…`) | no — 7–8 digit | **quoted string** (`"id":"8031234"`) | `JSON.parse` | **safe** |
| **Pandora** person `personID` (`docs/pandora-api.md`) | no — 6-digit Firebird | quoted string (`"id":"713365"`) | `res.json()` | **safe** |
| QAMF bowling reservation ids / both Node bridges | no | string / n/a | — | **safe** |

So in OUR code, the 17-digit numbers exist only in the **public-booking** API, and that path
already reads them as raw text + regex. **A `: string` TS annotation doesn't guarantee runtime
safety — but neither does a 17-digit-looking field guarantee danger. Probe the real bytes before
assuming a precision bug.**

**ROOT CAUSE OF THE 2026-06-03 INCIDENT = BMI's `payment/confirm`, server-side (NOT our code).**
Confirmed by repro on W38433/W38445/W38446: we send the booking's correct raw `orderId`
(e.g. `…675359`) at `payment/confirm` ([OrderSummary.tsx](apps/web/app/book/race/components/OrderSummary.tsx)
injects `"orderId":${bill.billId}` as a raw token, `bill.billId` = the regex `rawOrderId`), yet
BMI creates/links the **project at `…675360` = `Number(orderId)`** (GET `project/…359`→404,
`project/…360`→200). Since we never send `…360`, BMI is rounding the orderId through `JSON.parse`
on **their** end. It "started recently" because older orderIds were coincidentally multiples of 8
(e.g. `…670152`, offset 0); as the counter climbed, `Number()` now lands `+1`. Compounded by a
**known BMI bug** — `payment/confirm` auto-cancels paid online reservations (`stateId -4`,
`userUpdatedId -1`) — which we already document and work around in
[`bmi-cancel-sweep`](apps/web/app/api/cron/bmi-cancel-sweep/route.ts) ("remove when BMI fixes
payment/confirm"). **Fix belongs to BMI; our mitigation is the recovery cron.** `parseWithRawIds`
does NOT fix this — our parse was never the problem.

**Our durable mitigation = the recovery cron, hardened** (BMI must still fix the parse at source).
Since we can't stop BMI's auto-cancel, [`bmi-cancel-sweep`](apps/web/app/api/cron/bmi-cancel-sweep/route.ts)
resets BMI-auto-cancelled paid reservations `-4 → -3`. A prod audit found it was leaving paid
reservations dead: hardcoded to **ftmyers only** (Naples never recovered), gated on **stale payment
markers** (`payMethodId=42603617` matched 0/73), and **hard-skipping** name="Online"/`personId=-6`.
Reworked to: run **both centers**; recover on a **hybrid gate** — match to a confirmed
booking-record (`bookingrecord:res:{number}`, [booking-record/route.ts](apps/web/app/api/booking-record/route.ts))
OR (`userUpdatedId === "-1"` [BMI's auto-cancel signature] + has-payment + not intentionally
cancelled); parse responses with `parseWithRawIds`; `?dryRun=1` for safe inspection.
**Key discriminator:** BMI's auto-cancel stamps `userUpdatedId = -1`; our intentional cancels go via
the Office API as user `API2`, so they carry a different id — that's how recovery avoids re-activating
refunds. `parseWithRawIds`/`serializeWithRawIds` remain in `@ft/db` as the documented inbound tools
(the cron uses `parseWithRawIds`); the speculative `bmi-office-actions`/`bmi-attraction-cancel` edits
were reverted (those Office ids are small quoted strings — no precision loss there).

**Rule:** never `res.json()` / `JSON.parse` a BMI or Pandora response that carries ids. Use one of:
- `parseWithRawIds(await res.text())` (`@ft/db`) — quotes id fields before parsing so they come
  back as full-precision strings. The inbound counterpart to `stringifyWithRawIds`.
- For GET→mutate→PUT round-trips, pair it with `serializeWithRawIds(obj)` — re-emits ids as the
  raw numeric tokens BMI expects (handles nested ids like `persons[].id`, which
  `stringifyWithRawIds`'s top-level injection can't).
- Or the original `res.text()` + regex extraction (`extractRawOrderId` in `data.ts`).

**Don't `JSON.stringify` an id ARRAY either** (e.g. `personsByIds`): a `string[]` quotes the ids,
a `number[]` rounds them. Build the body as raw tokens: `'[' + ids.join(',') + ']'` (digit-validated).

## CRITICAL: Shared top-level routes need middleware update for HeadPinz (2026-04-30)

**ALWAYS add new shared routes to `isSharedTopLevelRoute` in `apps/web/middleware.ts`.**

The middleware rewrites every HeadPinz request to `/hp{pathname}`, so `headpinz.com/foo` becomes
`/hp/foo` internally. If `app/hp/foo/page.tsx` doesn't exist, HeadPinz visitors get a 404 even
though `app/foo/page.tsx` exists and renders correctly on fasttraxent.com.

The fix is to add the route to the `isSharedTopLevelRoute` allow-list so it bypasses the `/hp`
rewrite and serves the brand-aware page directly on both domains.

**Whenever you create a new top-level page that must work on BOTH domains, do this in the SAME
commit:**

```ts
// apps/web/middleware.ts
const isSharedTopLevelRoute =
  pathname === "/accessibility" || pathname.startsWith("/accessibility/") ||
  pathname === "/cancellation-policy" || pathname.startsWith("/cancellation-policy/") ||
  pathname === "/your-new-route" || pathname.startsWith("/your-new-route/");
```

**Required pairing for any new shared page:**
1. `app/<route>/page.tsx` — uses `headers()` to detect `host` and renders the brand-aware version
2. `middleware.ts` — add `<route>` to `isSharedTopLevelRoute`
3. Test on BOTH domains before committing — fasttraxent.com AND headpinz.com

**Smell test:** if a new page uses `headers()` to switch on `host.includes("headpinz")`, the
middleware update is mandatory. There is no scenario where one without the other is correct.

## Square gift card mint pitfalls — read these before touching the survey/comp gift card path (2026-05-20)

Spent the better part of a day chasing "card invalid or not activated" + 502s before
getting an end-to-end merchant-comp gift card flow working. Four traps, none of them
in Square's docs as a single page.

### 1. ACTIVATE-by-order is the ONLY path that works for a merchant-comp card

For a customer-purchase card you can `POST /gift-cards/activities` with
`amount_money` + `buyer_payment_instrument_ids`. For a merchant-comp (no buyer),
you MUST go through an Order:

```
1. POST /v2/orders                — eGiftCard line + catalog discount → $0 total
2. POST /v2/orders/{id}/pay       — empty payment_ids (discount covered it)
3. POST /v2/gift-cards            — { type: "DIGITAL" }
4. POST /v2/gift-cards/activities — ACTIVATE with order_id + line_item_uid
```

Trying to pass `amount_money` alongside `order_id + line_item_uid` returns
`"Provide either order_id and line_item_uid OR provide amount and
buyer_payment_instrument_id"`. The two pairs are mutually exclusive.

Square reads the load amount from the line item's `gross_sales_money`
(base_price × qty), NOT `total_money`. So a $5 line with a 100% discount still
activates the card with $5.

### 2. FIXED_PERCENTAGE catalog discounts: omit `amount_money`

Our `"Gift Card - Guest Survey (500.088)"` (`37C3SN4245TUCN3RF7XMNKPU`) is
configured as FIXED_PERCENTAGE 100%. Including `amount_money` on the discount
object is a 400: `"Do not provide a value for amount_money if you provide a
catalog_object_id that references a fixed-percentage discount."`

```ts
discounts: [{ catalog_object_id: discountCatalogObjectId }]  // ✅
discounts: [{ catalog_object_id: ..., amount_money: { ... } }]  // ❌ for FIXED_PERCENTAGE
```

Pandora_API passes `amountMoney` because its discount is FIXED_AMOUNT — don't
copy-paste their pattern without checking the discount's `discount_type` first.

### 3. `actRes.ok` is not enough — Square returns 200 with `errors[]` on idempotency replay

The bowling-orders flow already accounts for this:

```ts
const data = await actRes.json();
if (!actRes.ok || data.errors) { /* surface the error */ }
```

Our reward path was only checking `!actRes.ok` and silently passing through
200-with-errors. Result: code returned a "success" with a GAN, but Square
never recorded the ACTIVATE activity. The card stayed PENDING $0. Every
survey-reward gift card minted today before `bda710b` ended up unusable.

**Belt-and-suspenders:** after activate, GET `/gift-cards/{id}` and assert
`state === "ACTIVE"` and `balance_money.amount > 0`. The extra round-trip is
cheap insurance against any future silent-failure mode.

### 4. Customer-facing URLs need the `gftc:` prefix STRIPPED

Square's API returns the gift card id as `gftc:<hex>`. But the customer-facing
balance and Apple Wallet URLs expect the hex only:

```ts
const giftCardIdShort = giftCardId.replace(/^gftc:/, "");
const balanceUrl = `https://squareup.com/gift/balance/${giftCardIdShort}`;
const walletUrl  = `https://squareup.com/apass/gc/download/personalized/${giftCardIdShort}?source=egift`;
```

Verified by curl on a known-ACTIVE $5 card:
- `/apass/.../{stripped}`     → `HTTP 200 application/vnd.apple.pkpass` ✅
- `/apass/.../gftc:{full}`    → `HTTP 404` ❌
- `/gift/balance/{stripped}`  → real balance page (SPA-rendered) ✅
- `/gift/balance/gftc:{full}` → Square's generic eGift landing page (looks like "invalid") ❌

Same convention Pandora_API uses (`cardID.split(":")[1]` before building URLs).
Both `app.squareup.com` and `squareup.com` work for `/gift/balance/`; Apple
Wallet uses `squareup.com` only.

### 5. The `state=ACTIVE` gift-cards LIST filter lags

`GET /gift-cards?state=ACTIVE` is indexed and can lag minutes behind. A card
that just activated may not appear in the list filter even though
`GET /gift-cards/{id}` returns `state: "ACTIVE"` immediately. Always verify
state by direct retrieve, never by absence from the LIST filter.

### Where to look
- [apps/web/lib/square-gift-card.ts](apps/web/lib/square-gift-card.ts) `mintDigitalGiftCard()` — canonical mint flow with defensive checks
- [apps/web/app/api/square/bowling-orders/route.ts](apps/web/app/api/square/bowling-orders/route.ts) — pre-existing working flow that already had the `data.errors` check
- `Pandora_API/src/utils/square.utils.ts` / `controllers/squareV2.controllers.ts.ts` — reference implementation for both mint and URL construction
