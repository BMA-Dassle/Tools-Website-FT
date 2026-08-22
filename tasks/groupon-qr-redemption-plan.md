# Groupon QR redemption — implementation plan

Status 2026-08-18: **API rail PROVEN end-to-end in staging.** Two test vouchers
redeemed and verified. The auth blocker recorded in
[groupon-and-attraction-vouchers.md](groupon-and-attraction-vouchers.md) is
RETIRED — that doc's HAR was the reCAPTCHA-gated merchant console; these are
real partner credentials against a different surface.

Contract, error ladder and gotchas: memory `reference_groupon_partner_offer_api`.
Submission evidence: [docs/groupon/pos-certification-transcript.txt](../docs/groupon/pos-certification-transcript.txt).

## 0. What is already proven (not inferred)

| Fact | Evidence |
| --- | --- |
| Auth = `groupon-third-party` HMAC-SHA1 + `x-client-id` | 401 ladder: bearer/x-api-key → `'client_id' is invalid`; `x-client-id` + bad sig → `INVALID_REQUEST_SIGNATURE`; correct sig → 200 |
| Host is prod for BOTH envs; env = config name in path | `offer-api-staging` rejects our client_id |
| Fetch works, one code per request | comma-joined list 401s (breaks their canonicalisation) |
| Redeem body = the WHOLE fetched unit echoed back with `status:"redeemed"` | `{id,status,updatedAt}` (the published OpenAPI shape) → `UNIT_NOT_FOUND` for every identifier |
| Double-redeem is refused server-side | re-PATCH → `INVALID_STATE_TRANSITION`, echoing `redemptionCode` |
| `UNKNOWN_ERROR` 400s are transient; retry required | one code 400'd 3× then 200'd |

Redeemed: `WNDXH4DJ` (18:29:32Z), `XV4PQ5BK` (18:30:33Z). `CCH749Q3` left
AVAILABLE deliberately — it is the only remaining code for the kiosk smoke test.
`JMQRWQNQ` / `E8DZK4K8` are not present in this config (persistent 400).

## 1. Doctrine

Two rules drive every decision below.

1. **Groupon is all-or-nothing; OUR ledger owns the remainder.** Owner
   2026-08-18: partial redemption is never sent to Groupon. One unit → one
   `redeemed` PATCH, ever. What the guest has actually *taken* is our books.
2. **Never burn the Groupon before value has moved.** Redeeming first and
   dispensing second can eat a guest's voucher when the dispenser jams. The
   PATCH fires only after the first item is genuinely delivered, and it goes
   through a durable queue so a failed PATCH is recovered forward, never
   silently lost (same doctrine as the Intercard load).

## 2. The deal

"$25 Worth of Arcade Game Play and Four Laser Tag Entries" — the $25 lands
**whole on ONE card** as bonus tokens (owner 2026-08-18). So one voucher =
**5 independently-claimable items**:

- 1 × `{kind:"gamezone", tokens:0, bonusTokens:250, bonusCashDollars:0}`
- 4 × `{kind:"attraction", slug:"laser-tag", qty:1}`

This maps onto the existing `VoucherItem[]` model with no schema change — items
are already claimed per `(code, item_index)`, which is exactly what "guest took
the card today, brings three friends back Saturday" needs.

250 tokens = $25 at our 10¢/token rate, the same rate that makes the deal packs'
"$15 game card" 150 tokens. **250 was missing from BOTH denomination
allowlists** (`COMP_TOKEN_DENOMINATIONS` and `NATIVE_GRANT_DENOMINATIONS`) and
had to be added to each: the file's own warning is that adding it to only the
mint side lets a voucher mint happily and then credit NOTHING when the card
dispenses — silent, and the guest walks away with an empty card.
`grants.test.ts` pins the two arrays together and passes.

(An earlier reading split the $25 across four cards, which is 62.5 tokens per
card — not an integer. One card avoids inventing a rounding rule.)

`deal.id → items[]` lives in **our own table**, one row per deal. The GET
response carries no deal identifier at all (`attributes` is null on these test
units), so how we recognise WHICH deal a code belongs to is an open item —
see §7.

## 3. Work breakdown

### PR 1 — Groupon adapter (no UI)
`apps/web/src/features/groupon/`
- `sign.ts` — the HMAC-SHA1 signer. Pure, fully unit-tested against the worked
  example in Groupon's spec (fixture must include a query param needing double
  encoding, or the bug hides).
- `client.ts` — `fetchUnit(code)` / `redeemUnit(unit)`, retry on 5xx and
  400+`UNKNOWN_ERROR` **only**. Never retry `UNIT_NOT_FOUND`,
  `MALFORMED_REQUEST`, `INVALID_STATE_TRANSITION`.
- Credentials: `GROUPON_CLIENT_ID`, `GROUPON_API_KEY`, `GROUPON_CONFIG_NAME`.
  `@ft/env` does not exist yet, so read them in this one module and nowhere else
  — that keeps the eventual PR4 migration a one-file change.
- Server-only. The API key must never reach a kiosk bundle; `next build` is the
  gate that catches an accidental client import.

### PR 2 — ledger + issuer
- `VoucherIssuer` gains `'groupon'` (`voucher-claims-db.ts`). Per-item CAS is
  already correct and needs no change.
- New `groupon_units` table: `redemption_code` PK, `unit_id`, `groupon_code`,
  `deal_key`, `items JSONB`, `fetched_at`, `redeemed_at`, `redeem_state`
  (`pending` | `sent` | `failed`), `redeem_attempts`, `last_error`.
- New `groupon_deals` map: `deal_key → items[]`. Explicit rows, never parsed prose.
- **Persist at capture, before the external call** — the ledger row is written
  from the GET response the moment the code validates, so a later PATCH failure
  cannot lose what the guest is owed.

### PR 3 — resolution + classifier
- **Local ledger is consulted FIRST.** After the first scan Groupon reports
  `redeemed` forever; if we ask Groupon first, a returning guest with 6 unspent
  items is told "already used". This is the single biggest correctness trap in
  the feature and deserves its own test.
- Resolution order: known `groupon_units` row → else Groupon GET → else fall
  through to the existing classifier.
- Classifier: the `VS-XXXX-XXXX-XXXX-XXXX` form is unambiguous, add it now. The
  bare 8-char form (`WNDXH4DJ`) **collides with promo codes** — `classifyKioskCode`
  sends 8-char alphanumerics to `promo` today. Resolve by trying promo/voucher
  lookup first and falling back to Groupon, so no existing code changes meaning.

### PR 4 — redeem-on-delivery + retry cron
- First successful delivery (card dispensed, or attraction claim taken at
  charge) triggers `redeemUnit`.
- Failure → row stays `pending`; a cron drains it. Alert if a row is `pending`
  beyond a threshold: that is real money we handed out and did not report.

### PR 5 — kiosk UI: no-dispenser warning + partial redemption
- Trigger already exists: `gameZoneCapability(cfg)` returns `"full"` only when
  `cardReaderEnabled && dispenserId`. Warn whenever it is **not** `"full"`.
- Copy: *"This kiosk can't print new game cards. You can still redeem part of
  your voucher here, and pick up your cards at any kiosk with a card printer."*
- **EN + ES both, in the same commit** — hard rule; `MessageKey` typing fails
  the build if ES is missing. ES per the kiosk glossary (informal *tú*).
- Partial state reuses `pending-cards.ts` as-is — it already does per-leg
  pending, dedupe by code, qty ±, and "clear only what actually dispensed".

## 4. Failure matrix

| Case | Behaviour |
| --- | --- |
| GET `UNKNOWN_ERROR` | retry ×5 with backoff, then "try again" — never mark used |
| Unit `redeemed` but no local row | genuinely spent elsewhere → refuse, show `redeemedAt` |
| Unit `redeemed` WITH local row | normal returning guest → serve remaining items |
| PATCH fails after dispense | ledger `pending`, cron retries, guest already served |
| Dispenser jams mid-voucher | claim stands for the card that moved; rest stay pending |
| Same code, two kiosks at once | existing per-item CAS decides; loser sees "in use" |

## 5. Test plan

- Unit: signer fixtures; retry classifier; resolution order (ledger before API).
- Integration against staging with `CCH749Q3` — the one live code left.
- Live kiosk smoke on a **Game One** kiosk (owner request), covering both the
  dispenser and the no-dispenser warning path.

## 6. Open questions for the owner

1. **Tokens per card** (§2) — blocking the grant value.
2. What does the **QR actually encode**? Needs one live scan. Groupon's printed
   barcode was `ean-13` in the 2026-07-30 capture, which would collide with the
   game-card rule (`^\d{8,}$`). Manual entry of the 8-char and `VS-` forms works
   regardless, so this does not block PR 1–4.
3. **Which laser tag product/slug**, and does redemption need a booked session
   or is it walk-up?
4. More staging codes from Groupon — only one unredeemed code remains.

## 7. Known gap

The GET response carries **no deal identifier** (`attributes: null`), so
`deal_key` cannot yet be derived from the API. Either Groupon populates
`attributes` for real deals, or we key the map on something else. This must be
settled against a REAL deal code before the deal→items map can be trusted —
these test units are all value 100 / price 1 placeholders and tell us nothing
about the production shape.

---

## 2026-08-20 — production read proven, redeem path repaired

Owner supplied production credentials and a real purchased voucher
(`89895632` / `VS-GCMV-VNXS-4YN4-2V4X`). A GET-only probe against the
`headpinz` config returned **HTTP 200 on the first attempt**, unit
`23cc45c6-…`, `status: available`, value $65.00, price paid $30.60.
**No PATCH has ever been sent to production.**

### Newly proven (not inferred)

| Fact | Evidence |
| --- | --- |
| The shipped signer is correct against PROD | `headpinz` GET 200, first try, no retry |
| The signing KEY is per-env; the CLIENT ID is shared | same key on `headpinz-preprod` → 401 `INVALID_REQUEST_SIGNATURE`, **not** `'client_id' is invalid` |
| `attributes` is null in PRODUCTION too | the deal-key gap does not close via the API, in either env |
| `value`/`price` are REAL in prod | staging's 100/1 were placeholders; 6500/3060 here |
| An 8-digit Groupon code collides with the game-card rule | `89895632` matches `CARD_DIGITS_RE` (`^\d{8,}$`) |

**Trap now documented:** `GROUPON_API_KEY` and `GROUPON_CONFIG_NAME` are a
matched pair. Mixing them fails as `INVALID_REQUEST_SIGNATURE`, which is
indistinguishable from a base-string bug — expect someone to hunt a signing bug
that does not exist. The env shape holds only one key, so setting prod also
stops preprod probes working.

### Bug found and fixed: the redeem path had never run

`redeemAfterDelivery` RECONSTRUCTED the unit from ledger columns instead of
re-fetching it. The PATCH only works by echoing the whole unit back, and the
ledger has no `price` column — so it sent `price: 0` against the real 3060.
Groupon answers a mutated echo with `UNIT_NOT_FOUND` / `MALFORMED_REQUEST`,
both of which that function treats as **terminal**, so one bad echo would have
permanently stranded a row the cron then never retries. Staging never caught it
because the staging proof was a hand-run GET-then-PATCH script; this function
had never executed once.

Now: re-fetch, echo the fetched unit, and only `UNIT_NOT_FOUND` **on the
re-fetch** is terminal. A unit already `redeemed` upstream discharges the debt
without sending anything; an unrecognised status refuses instead of guessing.

### Landed on the worktree

- `groupon/codes.ts` — code shapes extracted to a PURE module so the kiosk
  classifier (a client module) can match them without importing
  `resolve.server.ts` and dragging the signing key toward the browser bundle.
  `resolve.server.ts` re-exports them, so existing importers are unaffected.
- Classifier: new `groupon` kind for the unambiguous `VS-` long form (which used
  to land in the promo fallback), plus an additive `grouponCandidate` HINT.
  **No existing input changes `kind`** — `89895632` stays `game-card`,
  `WNDXH4DJ` stays `promo` — because an 8-character code is genuinely ambiguous
  and `classify.ts` may not do I/O. The call site resolves by lookup, primary
  path first, Groupon as fallback. Both steps are non-destructive.
- `deals.ts`: `valueAmounts` sentinel. Not a price and never used to derive what
  the guest gets — `items` alone does that. It exists so a SECOND deal fails
  loud (`unmapped` → grants nothing) instead of silently collecting this deal's
  five items. `[6500, 100]` = prod observed + the preprod placeholder.
- `service/redeem-sweep.server.ts` + `/api/cron/groupon-redeem-sweep`
  (every 10 min): drives `pending` rows to `sent`. Owns no redeem logic —
  every row goes through `redeemAfterDelivery`, the single writer. Rows past 12
  attempts are excluded from the worklist so they cannot starve it, and counted
  as `stalled` so the cron says so out loud.

Verified: `tsc --noEmit` clean, eslint clean, full suite 371 files / 5379 tests
green.

### Still open

- **Kiosk wiring (item 3) — NOT BUILT.** The Groupon fallback branch at the
  code-entry call site, and the panel that shows the five items and what is
  left. Needs EN+ES for every guest-facing string.
- **The redeem has still never run against production.** Owner confirmed
  `89895632` is ours to burn; it should be burned THROUGH the wired kiosk on a
  Game One machine, since that is the only way the delivery-then-PATCH ordering
  and the per-item claim CAS get exercised at all.
- **What the scanner physically emits is still unknown.** The printed barcode
  shows no EAN guard-bar descenders and digits set to the SIDE, which reads as
  Code 128/39 and contradicts the 2026-07-30 `ean-13` capture. Settle it by
  scanning with the real kiosk scanner and logging the raw string — also catches
  any scanner prefix/suffix.
- Ask Groupon whether `attributes` can be populated, or a per-deal config name
  issued. Until then `valueAmounts` is the only discriminator we have.

---

## 2026-08-20 (later) — voucher BURNED in production; kiosk validate path wired

### The production redeem is proven

`89895632` was redeemed for real, owner-authorised, **through the app's own
`redeemUnit`** (driven via vitest — see the runner note below). HTTP 200 first
attempt; re-fetch confirmed `status:"redeemed"`,
`redeemedAt:"2026-08-20T20:03:41Z"`. The whole-unit-echo contract now holds in
production, not just staging. Notes:

- The PATCH **response echoes the updated unit**, so it is usable as
  confirmation — but the RE-FETCH is what we assert on.
- `redeemedAt` is millisecond-precision on the PATCH response and
  second-precision on the following GET. Never compare them for equality.
- `attributes` is **still null after redemption**. It is not a deal identifier
  on this funnel; stop waiting for it.
- **Runner note:** this package is CJS-by-default, so a `.mts` script importing
  a `.ts` module gets "does not provide an export named …", and Node 24's native
  type-stripping wins even over `node --import tsx`. **Vitest is the only runner
  here that resolves app modules** — shape a one-shot probe as a `*.spec.ts`,
  run it, delete it.

### Landed since

- **`vouchers/validated-items.ts`** — the item-presentation mapper
  (`ValidatedItem`, `cartCoverageName`, `toValidatedItem`) extracted out of
  `native-voucher.ts` so Groupon maps through the SAME code. `coverageName` is
  matched by the booking's `voucherTarget()`; a second issuer spelling
  "Lasertag" where this one says "Laser Tag" would validate, show the guest a
  laser tag line, and then cover nothing at checkout. Pure extraction —
  all 215 game-cards tests unchanged and green.
- **`groupon/service/kiosk-validate.server.ts`** — Groupon → `ValidatedItem[]`,
  so the existing receipt, spent-leg strike-through, cart-coverage grouping and
  its EN+ES copy are reused instead of a second panel being built. `itemIndex`
  is preserved verbatim (it is the claim identity in `voucher_claims`) and that
  is pinned by a test.
- **`POST /api/kiosk/groupon/validate`** — non-destructive. Shape-gated before
  any network call, because the fallback fires mostly on codes that are not
  Groupon at all.
- **Kiosk fallback wiring.** Primary path runs first, unchanged; Groupon is
  tried only if it REFUSED. The refusal signal is read off `logReject` (which
  every rejection funnels through) rather than threading a return value through
  ~270 lines of branches. Three rejections that were silently bypassing
  `logReject` now go through it — they were also missing from the logs.
- **Scan tones** (`kiosk/sound.ts`, owner-supplied audio). A scan has no
  keypress and no cursor, so without a tone a guest cannot tell a dead code from
  a beam that missed. Autoplay-blocked playback is swallowed;
  `unlockKioskSounds()` primes the elements off a gesture. One scan never plays
  an error tone followed by a success tone — the reject tone is held while a
  Groupon fallback is still pending.
- EN+ES copy for every Groupon refusal, kept distinct on purpose: `unmapped`
  means the voucher is REAL and we are not ready, and `unavailable` means try
  again rather than go and queue at Guest Services.

### THE REMAINING GAP — the claim/dispense rail

`claimAnyVoucher` has **no `groupon` branch**, and `voucherIssuerFor` never
returns `"groupon"` — the type was widened in anticipation, the rail was not
built. So the kiosk can now VALIDATE a Groupon voucher and show what is on it,
but it cannot hand any of it over.

`tryGroupon` therefore deliberately does NOT route legs to `onGzCardsAdd` /
`onNativeCartItems`: those lead to the native claim, which would look the code
up in the `vouchers` table where no Groupon row exists — showing a guest a card
on the receipt and then failing to dispense it. That is exactly the
promise-then-strand failure the BMI comp path already taught us. Until the rail
exists, an accepted Groupon says so and points at staff.

To finish, `claimAnyVoucher` needs a `groupon` branch that: resolves the unit
from `groupon_units`, picks an unspent leg, claims it in `voucher_claims` via
the existing CAS with `issuer: "groupon"`, grants the tokens — and **only then**
calls `redeemAfterDelivery`. That last ordering is the doctrine and the reason
the sweep cron exists.

Also still open: one scanner capture on real hardware to settle the symbology
(printed barcode reads as Code 128/39, contradicting the 2026-07-30 `ean-13`
note) and to catch any scanner prefix/suffix.

---

## 2026-08-20 (final) — the claim rail is built; kiosk hands the legs over

The "see Guest Services" dead end is gone. A Groupon now behaves like any
multi-leg voucher on the kiosk: the card dispenses, the laser tag entries cover
booking lines, and a return visit shows the spent legs struck through.

### Claim (the $25 card)

`groupon/service/claim.server.ts` → `claimGrouponGameZone`. Mirrors the native
rail's ordering exactly: **claim first, then the ledger row, release the claim if
the ledger insert fails.** A claim without a ledger row is a leg the guest can
never spend; a ledger row without a claim is a card we might hand out twice.
Reuses `voucher_claims` — the same one-statement CAS the native rail uses — so
two kiosks scanning one Groupon cannot both take the card. Spend is NOT tracked
in `groupon_units`: that would be a second writer for the same fact.

### Partial claim (the four laser tag entries)

NOT a new rail. `claimNativeCartVouchers` is now **issuer-aware**, because
everything that makes cart coverage correct already lives there — pre-claim
validation, equivalent-leg substitution, idempotency on the reserve's `baseKey`,
release on rollback, the spent stamp, the stale sweep. Only two things differ per
issuer and both are switched: which table proves the voucher is real
(`groupon_units` vs `vouchers`), and whether there is a wallet pass to mirror
(Groupon has none).

**One safety hole found and closed:** `sweepStaleCartClaims` decides whether to
release a stale claim using `hasChargedRedeemEvent`, which reads the NATIVE
registry. A Groupon code has no row there, so that check is always false and the
sweep would have released a leg a captured booking had already spent — letting
the guest spend it twice. Groupon claims are now never released by the sweep;
they are logged for a human instead. A stuck leg is recoverable, a double-spent
one is not.

### Issuer routing — shape decides only the unambiguous case

The existing router tests caught a real regression: `voucherIssuerFor("SUMMER26")`
started returning `"groupon"`, because an 8-character promo is shaped exactly
like a Groupon short code. Shape genuinely cannot decide it.

So `voucherIssuerFor` stays shape-only and matches **only** the unambiguous
`VS-XXXX-…` long form, and a new async `resolveVoucherIssuer` settles the short
form with a **ledger lookup** — by claim time we have already validated the
voucher and written a `groupon_units` row, so that row's existence IS the
answer. A promo has no row and behaves exactly as before. It fails OPEN to
"not Groupon" if the read throws.

### The delivery → PATCH hook

Wired into `load-card` at the point `loaded === true` — a card has left the
stacker carrying tokens. That is the first moment value has genuinely moved, and
the only moment we tell Groupon. Soft-fail: a failed PATCH leaves the row
`pending` for the sweep cron, because throwing here would fail a load that
already succeeded and leave the guest holding a credited card the kiosk called
an error.

Verified: `tsc` clean, eslint 0 errors (the only 2 warnings are pre-existing, in
`account-hooks.ts`), full suite **373 files / 5395 tests** green.

### Still open

- One scanner capture on real hardware, to settle the symbology (the printed
  barcode reads as Code 128/39, contradicting the 2026-07-30 `ean-13` note) and
  to catch any scanner prefix/suffix.
- `GROUPON_CLIENT_ID` / `GROUPON_API_KEY` / `GROUPON_CONFIG_NAME=headpinz` into
  Vercel. One key slot, so setting prod stops preprod probes working.
- **No unspent production code remains** — `89895632` was burned proving the
  rail. Get more staging/prod codes from Groupon before the on-glass smoke.

---

## 2026-08-22 — the short code can also be 7 characters

Owner report: "Groupons can also be 7 numbers instead of 8." The pre-filter
`GROUPON_CODE_RE` was `^[A-Z0-9]{8}$`, so a 7-long code was refused at the
shape gate in `/api/kiosk/groupon/validate` and never reached Groupon — the
guest saw a plain "invalid code".

**Change:** one regex, `^[A-Z0-9]{7,8}$`. Every consumer reads the shape
through `looksLikeGrouponCode` / `GROUPON_CODE_RE`, so the kiosk classifier,
the API shape gate, `resolveVoucherIssuer` and the cart-voucher `issuerOf` all
picked it up with no edit. Nothing downstream branches on code length.

**Why the 7 case is strictly easier than the 8.** The 8 is the hard one: an
8-digit run matches the bare game-card rule `^\d{8,}$`, which is what made
`34431265` show "That's a Game Zone card" on glass and never fall back
(2026-08-20). Seven digits does **not** match that rule, so it lands on the
promo catch-all carrying `grouponCandidate`, and `routeWithGrouponFallback`
already resolves Groupon-first for any candidate.

**What it costs.** A 7-character promo code now spends one speculative Groupon
round-trip before the promo validator answers — the same trade already accepted
for 8-character promos. The asymmetry justifies it: a wrong guess costs a
round-trip, a missed Groupon turns a paying guest away at the kiosk.

**What it does NOT touch.** The window is held shut at 6 and 9, pinned by tests.
Six would swallow W-numbers and the 6–16-char reservation short-code space and
put a Groupon call in front of all of them. A padded game-card barcode is still
unflagged: the hint is computed on the COMPACT string (`0000000001038091`, 16
digits), never on the zero-stripped value (`1038091`, 7) — `classify.test.ts`
now says so explicitly, because that test became load-bearing with this change.

Coverage: new `src/features/groupon/codes.test.ts` (both length edges, the long
form, normalization, the shapes the API gate must keep out) plus three
classifier cases. `tsc` clean, eslint clean, full web suite green apart from 3
pre-existing `race-pack-kiosk.test.ts` failures unrelated to Groupon.

**Unverified, and it needs a real code:** that Groupon's API accepts a 7-long
value as a `redemptionCodes` query param. Every code we have ever fetched was 8.
The shape gate is no longer the blocker; if a 7-long code still fails it will
now fail *at Groupon*, with a real error code in the logs instead of a silent
`bad_format`. Worth capturing one 7-long code on glass to close this out.
