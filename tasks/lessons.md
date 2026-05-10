# Lessons Learned

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
   project root at `fasttrax-web/`. The plan said "Vercel impact: none." Wrong.
   **Vercel walks UP from the configured project root looking for any lockfile.**
   Finding `pnpm-lock.yaml` at the repo root caused Vercel to switch from
   `npm install` to `pnpm install` in `fasttrax-web/` even though nothing inside
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

- Deleted `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`, `fasttrax-web/package-lock.json`.
- Root `package.json` now has `"workspaces": [...]`, `"packageManager": "npm@11.6.4"`,
  no pnpm-specific fields.
- Vercel install command override turned OFF (Vercel auto-detects npm from
  the root `package-lock.json`).
- Local + Vercel build green in one push.

### What we lost vs what we kept

**Lost:** pnpm's strict isolated `node_modules`. Transitive deps now hoist —
`fasttrax-web/eslint.config.mjs` can import `eslint-plugin-jsx-a11y` without
declaring it in `fasttrax-web/package.json` (it's pulled transitively via
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

## CRITICAL: Shared top-level routes need middleware update for HeadPinz (2026-04-30)

**ALWAYS add new shared routes to `isSharedTopLevelRoute` in `fasttrax-web/middleware.ts`.**

The middleware rewrites every HeadPinz request to `/hp{pathname}`, so `headpinz.com/foo` becomes
`/hp/foo` internally. If `app/hp/foo/page.tsx` doesn't exist, HeadPinz visitors get a 404 even
though `app/foo/page.tsx` exists and renders correctly on fasttraxent.com.

The fix is to add the route to the `isSharedTopLevelRoute` allow-list so it bypasses the `/hp`
rewrite and serves the brand-aware page directly on both domains.

**Whenever you create a new top-level page that must work on BOTH domains, do this in the SAME
commit:**

```ts
// fasttrax-web/middleware.ts
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
