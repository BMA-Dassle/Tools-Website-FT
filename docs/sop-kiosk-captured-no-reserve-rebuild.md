# SOP — Rebuild a kiosk booking that captured payment but never reserved

**Scope:** any kiosk checkout where the Square Terminal captured the guest's money
but the booking was never created (no `bowling_reservations` row) — and especially
the VIP combo (`race-bowl-v2`), which has hit this twice:

| Date       | Guest       | Amount  | Proximate cause                                                                                                                                                                         | Outcome                                                        |
| ---------- | ----------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 2026-07-28 | Paul Chung  | $234.21 | `reserve-all` ran and threw on QAMF `createReservation` 400 ("Millisecond must be 0" + PhoneNumber) — both normalizers since added to `lib/qamf-bowling.ts`                             | forensics only (`scripts/chung-orphan-forensics.mts`)          |
| 2026-08-10 | Dante Yocum | $420.68 | client never called `reserve-all` after capture; ~58s later a kiosk unwind (idle-reset/start-over class) **cancelled the BMI bill** at 21:24:43Z, which also killed the built-in resume | fully rebuilt same evening as W59710 — this SOP is that recipe |

**Why this class exists:** the VIP combo is the longest multi-vendor checkout we
have. The BMI bill + heats are created _before_ payment; the terminal capture sits
in the _middle_ of the chain; QAMF + Neon + BMI-confirm + Pandora all happen
_after_. Anything that dies after capture strands real money with no booking.
Aggravators (open fixes, see "Prevention backlog" at the bottom):

- Every kiosk exit path (idle reset, Start Over, self-update reload) "releases
  holds", which **cancels the BMI bill without checking the tender ledger** — if
  the ledger row is already `captured`, that cancel destroys the resume path.
- `kiosk-tender-sweep` detects captured-no-booking but (since 2026-08-10,
  19e64843) **alerts nowhere** — its Teams card was removed with the call-center
  chat cleanup. `listCapturedUnreserved()` (lib/reserve-attempt-log.ts) has zero
  callers. Detection is currently manual.

---

## 1. Triage — find the money and the cart (all read-only)

1. **Square:** find the payment (dashboard transaction link, or GET
   `/v2/payments/{id}` / `/v2/orders/{id}` — a dashboard URL's id is usually the
   ORDER id; its `tenders[].payment_id` is the payment). You need: `paymentId`,
   `order_id` (= the deposit order), amount, status (`COMPLETED`, refunded $0).
2. **Ledger:** `kiosk_split_tenders` row with `deposit_order_id` = that order.
   `seed` = the BMI bill id, `base_key` = `reserveBaseKey(seed)`. `state=captured`
   with no matching `bowling_reservations` row = this incident class.
3. **The cart survives in Redis** (this is what makes rebuilds possible):
   `GET https://fasttraxent.com/api/booking-record?billId={seed}` with
   `x-api-key: $BOOKING_API_KEY`. The kiosk saves it PRE-payment, so it holds the
   full party (names + BMI personIds), every heat (product/tier/track/start/stop),
   and the bowling leg (`experienceSlug`, `bookedAt`, `laneCount`, `playerCount`).
   Secondary source: Redis `bmi:api:log` (every BMI proxy call, 5000 entries).
4. **BMI bill state:** public-booking `order/{bill}/overview` (raw text only —
   NEVER `JSON.parse` an id-bearing BMI body). `statusId:-4, lines:[]` = dead.
   NOTE (1.16.8 lesson): the overview **cannot** tell cancelled from converted —
   only the Office project can.
5. **Confirm nobody already rebooked** (multi-writer shop): recent
   `bowling_reservations` by guest name/email, and ask staff.

## 2. Decisions that are already made (learned the hard way, 8/10)

- **A cancelled BMI bill cannot be revived.** `booking/book` with the dead
  `orderId` silently mints a NEW bill (returned a different orderId). Do not
  fight it — take the new bill and continue on it.
- **A new bill ⇒ the captured payment can never verify through `externalPayment`.**
  Every Square idempotency key derives from `reserveBaseKey(seedSource)` and
  `seedSource = session.bmiBillId` — a new bill means a new baseKey means a new
  (unpaid) deposit order, and `finalizeDepositFromExternalPayment` hard-fails
  the order-id check (by design; it pages on-call). **Do not send
  `externalPayment` when rebuilding onto a new bill.**
- **Therefore: rebuild at $0 through the real rail.** Mint a single-use 100%
  promo (`discount_codes`: `mechanic='percent', amount_pct=100`,
  `scopes {"racing":{},"bowling":{}}`, booking-date = visit date, `max_uses=1`,
  description that names the incident + paymentId), run `reserve-all` with the
  promo in the session — quote MUST price to $0 before you apply — then patch
  the real money linkage onto the Neon rows afterward. Nothing can double-charge:
  there is no card token and a $0 deposit charges nothing.
- **`context: { kiosk: true }` on the session** — it routes the deposit-location
  parity AND fires the kiosk post-reserve rail (guest email+SMS, BMI memo,
  Pandora `-3` state, `Confirmation - VIP` 55466363 stamp) so you don't hand-roll
  comms. The notification route dedups on Redis `notif:{billId}`; a manual
  fallback send after ~75s is safe (returns `{duplicate:true}` if the rail won).

## 3. The rebuild recipe (proven 2026-08-10)

Executable form: **`apps/web/scripts/kiosk-captured-no-reserve-rebuild.template.mts`**
(dry-run by default; `APPLY=1` to book). Copy it per incident and fill the CONFIG
block from triage. It covers steps 1–12 below, including the projectPerson attach
and grid push of §4. The 8/10 per-incident copies (`vip-yocum-*.mts`) are NOT
committed — they carry guest PII and this repo is public; keep per-incident
copies local and delete them when done.

1. **Capacity probe** — BMI availability for each heat (deployed `/api/bmi`
   proxy, correct PageId from `race-products.ts`), QAMF `/api/bowling/v2/availability`
   for the lane slot.
2. **Promo row** — insert `discount_codes` as above.
3. **Quote gate** — POST `/api/booking/v2/quote` with the session; assert
   `totalCents === 0`. STOP if not.
4. **Book the heats** onto one bill via `/api/bmi?endpoint=booking%2Fbook`
   (chain with raw-injected `{"orderId":<bill>,...}` — never `JSON.stringify` a
   17-digit id), then `person/registerContactPerson`.
5. **POV** — `/api/sms?endpoint=booking%2Fsell` productId `50361293` × racers ($0 line).
6. **QAMF hold** — POST `/api/bowling/v2/reserve/hold` (BookForLater). Old holds
   from the failed session are expired; always take a fresh one.
7. **Booking record** — POST `/api/booking-record` for the NEW bill BEFORE
   reserve (racers MUST carry `tier`, `category`, `heatStop` — the schedule
   endpoint 400s without them). PATCH the ORPHANED record with `rebuiltTo`.
8. **RESERVE** — POST `/api/booking/v2/reserve-all` `{session, contact}`. This
   creates: both Neon rows, QAMF confirm + lane, day-of orders, W-number,
   POV codes, the VIP voucher, short codes, and (kiosk context) all guest comms.
9. **Money patch (Neon)** — set `square_deposit_order_id`,
   `square_deposit_payment_id`, real per-leg `deposit_cents`/`total_cents`
   (tax-included split of the captured amount), and a notes block that says the
   day-of orders are $0-promo and NOTHING may be collected at settle.
10. **BMI memo** — `booking/memo` is a single overwriting field; recompose the
    whole memo (paid-at-kiosk + paymentId + "do not charge" + visit plan).

## 4. The two steps the rail does NOT cover on a rebuild

The 8/10 rebuild initially seated **0/10 racers** — heats booked without
`PersonId` mean the people are not on the BMI project, and the grid link answers
`person_not_on_project` for everyone.

11. **Attach projectPersons** — public-booking `person/registerProjectPerson`
    per person (raw-id injection; **HTTP 200 is NOT success** — check the body
    for `success:false`). Template §8 does this.
12. **Grid push** — POST
    `https://bma-pandora-api.azurewebsites.net/v2/bmi/schedule/LAB52GY480CJF/{W#}`
    (Bearer `SWAGGER_ADMIN_KEY`) with the full racers array. Attach→schedule has
    a propagation lag: a push right after the attach may still answer
    `person_not_on_project` — retry after ~10s (idempotent per racer:
    `inserted` / `already_linked`). Template §8 retries ×5 automatically.

## 5. Verify (checklist)

- BMI overview: W-number + confirmation code present, statusId `55466363`
  (Confirmation - VIP) for a VIP.
- Neon: both rows `confirmed`, real money fields, `square_deposit_*` set.
- QAMF via `/api/qamf-internal/centers/9172/reservations/{X-id}`: `Confirmed`,
  title `VIP Exp. {name} (Np)`. (Local QAMF creds are stale — always the proxy.)
- Booking record: `status confirmed`, `vipVoucherCode`, `bowlingLane`.
- Vercel logs: `[booking-confirmation] KIOSK confirmation sent … email=true sms=true`,
  `[kiosk-post] session assignment` / `race-session-assign-sweep` shows all racers linked.
- Grid: schedule POST answers `already_linked` for every racer.

## 6. Known loose ends this recipe leaves (document per incident)

- BMI bill shows its own list-price total as "due" (`totalToDeposit`) because the
  $0 promo records no BMI payment — the memo + VIP state are the guard against
  double-collection at the counter.
- The captured money stays on the original "Reservation Deposit" order; day-of
  orders are $0. `race-confirm-reconcile` may fund the deposit gift card
  (`WEBFT{last8-of-new-bill}`) from the patched linkage — fine, it just won't be
  drawn.
- QAMF `BookedAt` can drift from the requested slot (wall-clock handling — 8/10
  drifted 19:45→19:15). Confirm the lane window; earlier is harmless.

## 7. Prevention backlog (the actual fixes, in priority order)

1. **The unwind must not cancel a bill whose `kiosk_split_tenders` row is
   `captured` (or has `payment_ids`).** One guard in the kiosk exit/hold-release
   path preserves the built-in resume — this alone would have made 8/10 a
   non-event.
2. **Alert on captured-no-booking again.** The sweep's Teams card was removed
   2026-08-10 (19e64843, owner: no call-center chat cards) — wire
   `listCapturedUnreserved()` / the sweep's `captured` state to a channel that
   is allowed to exist (radio alert, email, admin badge), or a cron that pages.
3. **Diagnose why the 8/10 client never POSTed reserve-all after capture**
   (kiosk device logs / Clarity around 2026-08-10 21:23–21:25Z, FastTrax kiosk,
   Terminal 0407). The server saw capture-then-silence; the client-side cause is
   still unproven.
4. `notif:{billId}`, `bmi:confirmed:{billId}`, `reserve:lock:{seed}` are the keys
   that make replays safe — never work around them.
