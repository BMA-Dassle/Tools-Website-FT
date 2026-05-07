# Lessons Learned

## "No deploy impact" PRs can still change deploy tooling (2026-05-06)

PR1 of the monorepo restructure ([commit b1bdd0a](../package.json)) added a
workspace-root `pnpm-lock.yaml` while leaving Vercel's project root at
`fasttrax-web/`. The plan asserted "Vercel impact: none." That was wrong —
**Vercel walks UP from the configured project root looking for any lockfile**.
Finding `pnpm-lock.yaml` at the repo root caused Vercel to switch from
`npm install` to `pnpm install` in `fasttrax-web/` even though nothing inside
that directory changed. Build then failed with `ERR_PNPM_META_FETCH_FAIL` and a
cascade of `ERR_INVALID_THIS` registry errors.

Two stacked bugs:

1. **pnpm 9.x has a `URLSearchParams` bug with Node 22.13+** (Vercel's current
   Node 22.x runtime). pnpm's registry fetcher uses an old undici code path
   that throws `Value of "this" must be of type URLSearchParams` on every
   `GET https://registry.npmjs.org/...`. Local Windows install with the same
   pnpm + Node combo worked because the exact undici version differed.
   Fixed in pnpm 10.x.

2. **pnpm 10 changed two defaults** that bit us right after the version bump:
   - **`onlyBuiltDependencies`** — pnpm 10 no longer auto-runs install scripts
     for native packages (sharp, esbuild, tree-sitter, unrs-resolver, etc.).
     Without explicit allowlist in root `package.json` `pnpm.onlyBuiltDependencies`,
     Vercel's fresh install would skip building sharp's native binary →
     Next.js image optimization breaks at build time.
   - **Strict isolated `node_modules`** — transitive deps no longer hoisted.
     `fasttrax-web/eslint.config.mjs` imported `eslint-plugin-jsx-a11y`
     directly while only declaring `eslint-config-next` (which pulls jsx-a11y
     transitively). pnpm 9's hoisting hid this; pnpm 10 errored on `next build`.

**Rule 1:** When a workspace-level lockfile (`pnpm-lock.yaml`, `yarn.lock`,
`package-lock.json`) appears at the repo root for the first time, treat it as a
deploy-tooling change *regardless* of where the deploy provider's project root
points. Verify with a Vercel preview deploy on the same branch BEFORE asserting
"no deploy impact" in any PR description or plan.

**Rule 2:** Use a recent pnpm 10.x — we use `pnpm@10.33.4`. Early 10.x patches
(10.0.x through 10.5.x) STILL hit the URLSearchParams bug; the fix didn't fully
land until later 10.x patches. Pinning `engines.node` is a poor backstop because
**Vercel ignores narrow `engines.node` pins and uses its current default Node
LTS** (Node 24.x as of 2026-05). Don't fight Vercel's Node default — match it
in `.nvmrc` (`24`) and keep `engines.node` as a permissive floor (`">=22.11.0"`)
so local contributors on Node 22.x still pass the engine check.

**Rule 2a:** When debugging "works locally, fails on Vercel" issues, the FIRST
thing to confirm is the build log header: actual Node version, actual pnpm
version, actual install command. Vercel's defaults shift over time and
silently override file-based pins more often than the docs suggest.

**Rule 3:** When migrating from npm/pnpm 9 to pnpm 10, audit every `import` in
config files (`eslint.config.mjs`, `next.config.ts`, scripts) for transitive
deps that need explicit declaration. Common culprits: `eslint-plugin-jsx-a11y`,
`eslint-plugin-react-hooks`, anything imported via `eslint-config-*` subpaths.
Run a clean `rm -rf node_modules && pnpm install && pnpm turbo run build` after
the version bump — local cache hides this class of bug.

**Rule 4:** Add native-binary packages explicitly to root `package.json`
`pnpm.onlyBuiltDependencies` array. Minimum required for this stack: `sharp`,
`esbuild`, `tree-sitter`, `tree-sitter-json`, `unrs-resolver`,
`@tree-sitter-grammars/tree-sitter-yaml`. (`@scarf/scarf` and `core-js-pure`
are noisy postinstall donation messages, safe to skip but harmless to allow.)

**Test rule:** Before merging any change to the workspace root that adds or
modifies a lockfile or `packageManager` field, deploy to a Vercel preview
URL and confirm: (a) build log shows `pnpm install` not `npm install`,
(b) sharp/esbuild install scripts run without warning, (c) the deployed app
serves images via Next's optimizer (i.e. `/_next/image?...` returns 200 with
WebP).

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
