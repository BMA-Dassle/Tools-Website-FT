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
