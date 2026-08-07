# Open Tasks

## FastTrax operational changes — new Mon–Fri hours + Mega is Junior Pro only (2026-08-05)

Two owner-announced operational changes, both landing **2026-08-10**:

1. **Mon–Fri open moves 1:00 PM → 3:00 PM.** Sat/Sun (11 AM) and every closing time
   are unchanged.
2. **Mega days run Junior Pro races only** — no Junior Starter (never existed in BMI)
   and no Junior Intermediate (retired). Consequence: a junior must qualify all the
   way to Junior Pro on a split-track day before they can race a Mega Tuesday.

### Hours — one registry, effective-dated (not a flip)

The same four hours lines were hardcoded in five display surfaces plus two
behavioural ones. A plain edit would have published the NEW hours during the five
days we still open at 1 PM. So `apps/web/src/lib/constants/fasttrax-hours.ts` is now
the single source of truth and every consumer asks for the hours **on a date**:

- [x] `fasttrax-hours.ts` — `SCHEDULE_ERAS` (newest first) + formatters + week
      grouping + the schema.org opening-hours builder. Next hours change = one entry.
- [x] Marketing surfaces read TODAY in ET: `components/Nav.tsx`,
      `components/Footer.tsx`, `components/home/Attractions.tsx` (hours pills),
      `components/seo/JsonLd.tsx` (LocalBusiness + Restaurant + Mega Tuesday event
      start/end), `app/racing/layout.tsx` (the rainy-day FAQ hours sentence).
- [x] `app/api/pandora/races-current/route.ts` — live-races operating window takes its
      OPEN from the registry; the deliberately generous close-side grace stays local.
- [x] `race-restriction-rules.ts` — the opening-heats express-only window is anchored
      to the venue open time **for the heat's own date**, not "now". A heat on Aug 8
      keeps the 1:00–1:24 PM window while a heat on Aug 11 gets 3:00–3:24 PM; both
      correct at the same instant. (`openingWindowExpressOnly.windows` →
      `windowsForDate(isoDate)`.) Without this the rule would have silently stopped
      firing on weekdays — 1:00 PM would have had no heats in it.
- [x] Verified: rendered copy is byte-identical to the live site before 8/10
      ("Mon–Thu: 1:00 PM – 11:00 PM" …) and flips on the 10th. Every route builds as
      `ƒ` (dynamic) — the root layout's `headers()` call means no redeploy is needed
      for the switchover.

### Mega = Junior Pro only

- [x] Catalog is the functional truth: **Junior Intermediate Race Mega removed** —
      `24966320` (new) + `43732358` (existing) — from
      `src/features/booking/service/race-products.ts` AND v1 `app/book/race/data.ts`
      (lockstep). Junior Pro Race Mega is now the only junior product on the track,
      so `filterProducts` and `juniorProductsOnTrack` follow automatically.
- [x] `RACE_BUILD_PRODUCTS["junior:intermediate:Mega"]` deliberately KEPT so a session
      that picked the heat before the deploy still resolves a real $0 build product
      instead of hitting `bmiBookingTarget`'s error path. Delete once none can be live.
- [x] Guard widened from "first-time juniors" to "any junior not Junior-Pro qualified"
      in both wizards — v2 `RaceDateStep.tsx` (`juniorsBlockedOnMega`, via
      `isQualifiedForTier(…, "junior", "pro")`, never a substring match) and v1
      `app/book/race/page.tsx` (`countJuniorsBlockedOnMega`, via `getRacerTier`).
      Unverified juniors count as blocked.
- [x] Copy updated: `/racing` page + `racing-content.ts` cards/track warning, the Mega
      Tuesday FAQ, `MegaTrackTuesdayJsonLd` description, homepage `TuesdayAlert`,
      `embed/booking-info/products.ts` notes.
- [x] Kiosk copy in EN **and** ES: `peopleUi.megaJuniorWarning`,
      `stepReason.megaTuesday` (+ the matching `KioskFlow.tsx` reverse-map key and the
      v2 `canAdvance` reason string — all three must stay identical), attract-slide
      notice → "Junior Pro only on Mega".

### Gates run

`tsc --noEmit` 0 · `vitest` 3479 passed / 250 files · `eslint` 0 errors (only
pre-existing warnings) · `next build` 0 · `a11y-gate` 0 violations. New tests:
`src/lib/constants/fasttrax-hours.test.ts` (16), the era-crossing opening-window
block in `race-restriction-rules.test.ts`, the Junior-Pro-only block in
`race-products.test.ts`.

### Open

- [ ] **Not committed / not deployed** — the change set is in the working tree only,
      pending the owner's call on branch + PR (shared tree, multi-writer).
- [ ] **BMI side is not ours to change.** The Junior Intermediate Mega dayplanner still
      exists upstream; we only stopped selling it. If ops leaves those heats on the
      Mega dayplanner they'll sit empty (harmless) — but a walk-in booked at the
      register under `43732358` would still run, so ops should pull the tier from the
      Tuesday dayplanner too.
- [ ] **The attract-slide model is English-only** (`title` / `bannerAction` / `notice`
      are raw strings in `kiosk/assets.ts`, not catalog keys). Pre-existing gap across
      every slide, not introduced here — worth routing through the i18n catalog.
- [ ] **Never smoked.** No card charge, no kiosk device run, no Google re-crawl check.

## Group event moves between centers — FT → HeadPinz Fort Myers (2026-08-03)

US Anesthesia Partners (**H3194**, BMI project **56000667**, 8/8 4:36 PM, $2,146.35)
is moving from FastTrax to HeadPinz Fort Myers. Both share one BMI client
(`headpinzftmyers`), so the move keeps the same project, contract, deposit and gift
card — but the quote's center stamp was written only at INSERT, so nothing followed
the event. See lessons.md § "A derived flag written only at INSERT rots" (third
instance) and § "Refunding a deposit while its gift card stays funded pays twice".

- [x] **`syncQuoteCenter`** (group-quote-dispatch) re-derives `center_code /
      center_name / square_location_id / brand / base_url / gan_prefix /
      hermes_center` on every "Send Contract" pass, gated on
      `center_code`/`square_location_id` so ~170 legacy `gan_prefix` rows don't churn.
      Audit-logs `center_moved`, writes a BMI private note, folds the move into the
      post-sign `changes[]` set (a venue change can move zero money, which the
      `changes.length === 0` early-exit would otherwise swallow).
- [x] **`reconcileDayofOrder`** rebuilds on a **location** mismatch, not just a total
      mismatch — a Square order's location is immutable — and cancels the superseded
      order at its OWN location.
- [x] **`isFastTraxSubject`** replaces `subject.includes("FT")` (also matched GIFT /
      LEFT / SOFT / CRAFT / DRAFT / AFTER; the check can only ADD FastTrax, so a false
      positive pinned a HeadPinz-bound event to FastTrax permanently). Tested.
- [x] **Cancel path drains the deposit gift cards before refunding**
      (`drainInternalDepositGiftCards`, `ADJUST_DECREMENT` / `PURCHASE_WAS_REFUNDED`),
      so a cancel-and-rebook move can't refund the card AND leave the GC funded.
      Drain failure pages staff (`notifyGiftCardDrainFailed`) and never blocks the refund.
- [x] **`scripts/gf-center-move-check.mts`** — read-only: BMI location vs quote stamp vs
      day-of order location vs gift-card balance. Run before and after the move.
- [ ] **Not yet verified live** — nothing has moved yet. When sales flips H3194's BMI
      Location to HeadPinz and re-flips the project to "Send Contract":
      run `npx tsx scripts/gf-center-move-check.mts 56000667` and confirm all ✓.
- [ ] **Deadline:** the T-72h balance charge fires **Aug 5 ~4:36 PM ET** on the card on
      file, using the frozen `balance_cents`. Move + reprice before then or the balance
      collects at FastTrax pricing and the difference has to be settled as a reprice delta.
- [ ] **Unverified external behavior:** a cross-location gift-card `LOAD` (FT-minted card,
      HPFM-located quote) is expected to work — Square gift cards are seller-wide, and
      cross-location *redemption* is already proven in `group-dayof-pay` — but no card in
      our own history has activities at two locations, so it is inference, not evidence.
      If the T-72h load errors, `sumGiftCardLoadsForPayment` makes the retry idempotent;
      the failure is loud (`balance_last_error`), not silent.

## Google review ask on the survey reward screen — branch `feat/survey-google-review` (2026-08-02)

The guest survey ends on the reward-confirmation screen (500 Pinz / $5 e-gift card) —
the highest-goodwill moment we have with a guest, previously spent on nothing. Adds a
"Got 10 more seconds?" Google review CTA there, shown ONLY to guests whose own answers
say the visit went well.

- [x] **`src/lib/constants/review-links.ts`** — single source of truth for per-center
      Google review destinations, keyed by Square location id (= `guest_surveys.center_code`).
      `{ placeId }` builds the `writereview` URL that opens the star form directly;
      `{ url }` is a full-URL escape hatch. Unknown center → `null` → no ask (fail-closed,
      so a new center never gets pointed at another center's listing).
- [x] **Positive-sentiment gate** — `isPositiveSentiment()` in `features/guest-survey/gating.ts`,
      beside the existing `LOW_RATING_THRESHOLD` so there is ONE definition of a bad visit.
      Requires: overall (baseline #1) answered and ≥ 4, no `rating_1_5` anywhere ≤ 3,
      and recommend (baseline #2) ≠ "No". Questions addressed by (tag, ordinal), never by
      text, so seed copy edits can't silently disable the gate. Fail-closed on a missing or
      unanswered overall question. Plus `toAnswerMap()` to narrow a stored `responses_json`
      blob honestly (drops non-scalars rather than letting an object stringify to
      "[object Object]" inside a comparison).
- [x] **`GET /api/surveys/[token]/review`** — tracked 302 hop. The CTA links here, not
      straight at Google, so the click is recorded server-side (the CTA opens in a new tab,
      which is exactly the case a client beacon drops) and sentiment is RE-VERIFIED against
      the stored responses — a hand-crafted URL can't harvest the link. Records a
      `marketing_touches` 'converted' touch with `meta.stage: "review_click"`, matching the
      reward route's `reward_issued` shape, so existing admin stats pick it up with no
      schema change. Non-happy / incomplete / unmapped-center all 302 to the brand home,
      never an error page.
- [x] **`GoogleReviewCta.tsx`** — own client component. `target="_blank"` is required, not
      cosmetic: on the gift-card screen it sits below the QR, GAN and GS-XXXX promo code,
      and navigating away in place would take all of that off the guest's screen. Styled
      accent-OUTLINED so it never competes with "Add to Apple Wallet". Fires
      `clarityEvent("survey:review_click")`.
- [x] Rendered once in `RewardConfirmation` (covers both the Pinz and gift-card branches),
      and on `ThanksAlreadyPanel` for a reopened link — a happy guest who closed the tab on
      the reward screen gets a second chance, gated on the same stored answers.
- [x] **Middleware dedupe** — `/review` + `/review/naples` now build their targets from
      `googleReviewUrl(...)` instead of duplicating the two place ids inline. Behavior
      identical (asserted in the unit test).
- [x] **Click tracking on the survey row** (owner ask: "keep track of how many people click
      it"). New `guest_surveys` columns `review_click_count` / `review_first_click_at` /
      `review_last_click_at`, added to the DDL **plus idempotent ALTERs** so prod picks them
      up on the next `ensureGuestSurveySchema()` — no migration step. Incremented by
      `recordGuestSurveyReviewClick()` as a single atomic `SET count = count + 1` (the
      increment happens in Postgres, so a double-tap or two open tabs can't lose a count).
      **Awaited** in the route, unlike the fire-and-forget touch: a serverless teardown the
      instant we return a redirect can drop a detached write, and this is the number ops
      reads. Wrapped in try/catch — a lost count beats a broken link.
      Counted rather than booleaned because the CTA opens in a new tab, so the reward screen
      survives behind it and repeat taps are real.
- [x] **Admin stats** — `getGuestSurveyStats` gains
      `reviewClicks: { clickers, clicks, clickRate }` (clickers = distinct people, the
      headline; `clickRate` divides by **completed**, not sent, because the CTA only exists
      after submit), plus `reviewClickers` on `byDay` and `byCenter` so you can see which
      center's guests actually review. `/api/admin/guest-survey/stats` spreads the object,
      so it surfaces with no route change.
- [x] Incidental: `theme.ts` extracted from `SurveyForm.tsx` so server + client can share
      the palette. Side effect — the terminal panels (`ThanksAlreadyPanel` / `ExpiredPanel`)
      were hardcoding the HeadPinz background even for FastTrax racing surveys; they now
      follow the brand theme like the form `Shell` already did.
- [x] 49 units green (11 sentiment, 7 review-links, 12 review-route incl. hand-crafted-URL
      bypass attempts and the counting-fails-still-redirects case); full suite 2885 green;
      tsc clean; eslint exit 0; zero jsx-a11y in changed files; `next build` **compiled successfully**
      (verifies the middleware edge bundle with its new imports + the client/server
      boundaries). Build's type-check step then failed only on pre-existing UNTRACKED WIP
      leftovers in the working tree (`scripts/*.mts` ×4, `VipExperiencePopupClient.tsx`) —
      not on main, not in this commit.

**NOT smoked live.** Needs a two-brand phone pass: happy path → CTA appears → lands on the
right listing; overall-5-but-one-area-2 → no CTA; reopened link → CTA; and
`/api/surveys/<unhappy-token>/review` → home, not Google. Then confirm the count landed:
`GET /api/admin/guest-survey/stats` → `reviewClicks.clickers` incremented (and
`review_click_count` on the row), which also proves the idempotent ALTERs ran against prod.

**FastTrax place id — RESOLVED 2026-08-02.** All three centers now go straight to the star
form. FastTrax = `ChIJ3w3IFwAV24gRAVrB_FB6JE4`, derived from the feature id in Google's own
Maps URL for the 14501 Global Pkwy listing (`0x88db150017c80ddf:0x4e247a50fcc15a01`,
CID 5630759922376464897). A place id is base64url over the FID pair; the conversion was
validated by round-tripping both known HeadPinz ids byte-for-byte first. The interim
search-results URL is gone.

Two traps if this ever needs re-deriving: HeadPinz Fort Myers (`0x88dda5…`) is across the
same parking lot, and a CLOSED FastTrax exists at 17455 Summerlin Rd. The distinct
`0x88db15…` prefix is the tell. A unit test now asserts **every** mapped center resolves to
a `writereview?placeid=` URL, so a future `{ url }` fallback fails the build rather than
silently costing guests an extra tap.

Follow-ups (out of scope, not started):
- `emails/race-results.html:548` sends FastTrax racers to HeadPinz Fort Myers' place id.
- `pickBrand()` in `api/surveys/[token]/reward/route.ts` + `send-sms/route.ts` does
  `centerCode in CENTER_META ? "HeadPinz" : "FastTrax"`, but `CENTER_META` *contains*
  FastTrax — so racing reward SMS is branded "HeadPinz".

## Video match hardening — branch `feat/video-match-hardening` (2026-08-02)

Root causes proven by the 8/2 investigation (live Redis forensics, 7/10–7/28 corpus:
8,687 matched / 846 unmatched): junk short clips (0–120s) get matched + SMS'd and steal
racer slots (152 matched junk, 39 proven thefts); the webhook processes VT3 events in
arrival order while only the cron sorts by `created_at`, so out-of-order uploads swap
pairs of racers; held videos are nameless and never notify. Scope of THIS PR (matcher
correctness only — admin UX / Neon persistence / SMS-Timing reconcile are later PRs):

- [x] **Junk quarantine** — videos with duration < `VIDEO_JUNK_MIN_S` (default 120s)
      never auto-match/notify; recorded to the review bucket with new reason
      `"junk-short"`. Kill switch `VIDEO_JUNK_QUARANTINE=false` (default ON per house
      flag rule).
- [x] **Junk→real auto-swap** — when a real (≥ threshold) video walks to a slot occupied
      by a junk-grade one, displace the junk to the review bucket and take the slot;
      notify fires for the real video. Same kill switch.
- [x] **Ordered matching** — webhook no longer creates matches inline in arrival order.
      New-match events buffer in `video-pending:*` (merged per code), and a locked drain
      processes them oldest-`created_at`-first after a `VIDEO_MATCH_SETTLE_S` (90s)
      settle window, per-camera order enforced. Drain runs opportunistically on webhook
      calls + every cron tick (including the bridge-alive early exit). PATH-1 updates
      (overlay/block/deferred notify) stay inline — they're order-insensitive. Kill
      switch `VIDEO_MATCH_ORDERED=false` reverts to inline behavior. Side fix: a
      sample-uploaded-first video (no created_at) now buffers + matches instead of
      being dropped until the bridge goes quiet.
- [x] Admin: render the `junk-short` reason chip on review rows (list route already
      passes `reason` through).
- [x] Vitest units (19 green) for the pure logic: junk classification bounds, buffered-event merge,
      drain ordering (per-camera holds, settle window, created_at/id tiebreak).
- [x] `scripts/video-match-shadow.mts` — local monitor: `--replay` (what would the new
      rules have done over today's live corpus) + `--watch` (post-merge verification:
      junk-matched must go to zero, buffer depth, drain lag). Read-only.
- [x] tsc + eslint + a11y-gate green; 19 new units green; shadow --replay validated on
      8/2 LIVE traffic (4 junk matches incl. 1 texted guest, 3 swap repairs identified,
      cam61 flagged flaky with 39 junk clips); branch pushed + rebased on 384194fd.
      NOTE: 6 pre-existing failures on main (guest-survey-db.test.ts × 5 — seed is 30
      questions, test expects 22; steps-v3-gating.test.ts × 1) — unrelated, present at
      base, flagged to owners.
- [ ] **Owner: open PR + merge = go-live.** Post-merge: run
      `npx tsx scripts/video-match-shadow.mts --watch` from apps/web — junk-matched
      must stay 0, quarantined rows appear, pending buffer drains <5 min. Also new
      Neon table `video_decision_log` auto-creates on first write.
- [ ] ALSO ADDED (owner request mid-build): durable Neon `video_decision_log` — every
      match outcome w/ candidate context, notify results (incl. silent no-contact
      skips), block flips, buffer entries, drain summaries. Fire-and-forget writes.

## Kiosk attract motion — HeadPinz first (2026-07-26, branch `feat/kiosk-hp-attract`)

Owner-picked scope after the demo artifacts (claude.ai/code/artifact/4fc7ccbb + 290a6377).
People walk past the kiosks; current attract motion is below peripheral-vision threshold.
FastTrax picks (drive-by + relay wave) come in a LATER PR — this one is HeadPinz + shared plumbing.

**BUILT + PUSHED 2026-07-26** — commit `5d2916cb` on `feat/kiosk-hp-attract`; 9 unit tests green,
eslint + a11y-gate clean, tsc clean on touched files (pre-existing errors in the OTHER sessions'
uncommitted ReturningRacerLookup work were left alone).

- [x] `attract/billboard.ts` — bank position maps (FT 1–7 in order; **HPFM 3,2,6,1,4**;
      **Naples 10,9,7,8**), slide sets per venue, pure clock-phase fn + unit tests. Kiosks NOT in
      the map sit out of the choreography (owner call — no number-order fallback)
- [x] `AttractBillboard.tsx` — billboard overlay, navy veil so the finale never bleeds into the
      rotating welcome text; pointer-events-none; **default ON at BOTH HeadPinz venues** (owner),
      kill = `NEXT_PUBLIC_KIOSK_BILLBOARD=false`
- [x] Rotating welcome line, clock-synced 4s fade; kill = `NEXT_PUBLIC_KIOSK_WELCOME_ROTATE=false`
- [x] HeadPinz banner bowling ball (CSS sprite, same 8s slot + stagger as the FT car); rumble on
      both brands; car stagger moved to the position map (fixes HPFM handoff order)
- [x] kiosk.css keyframes + KIOSK_GLOW_PERIODS_MS same-commit
- [ ] **Owner: live smoke on a real HeadPinz kiosk bank** (billboard sync across screens, ball
      crossing, welcome rotation, tap-through during the takeover) — then PR review + merge
- [ ] Later PR: FastTrax full-screen drive-by + bank relay wave (picked; not started)
## Post-day-of refund flow — BUILT + MERGED 2026-07-28, FLAGS OFF

**Plan + flag-flip runbook: [tasks/future/post-dayof-refund-plan.md](future/post-dayof-refund-plan.md).**
All owner decisions from §5 answered 2026-07-27. §8 Tier-3 smoke COMPLETE — three live shapes
(`--live` MID 18/18 · `--live --post` POST 18/18 · `--live --post --race` POST + collapsed pack
line + FULL refund 20/20), all run with the master switch OFF.

Staff entry point: a **Refund** button on the manage modal for rows Cancel refuses (terminal
status + a day-of payment), opening the edit modal with `intent="refund"`.

**Remaining (owner, in this order — see the plan doc):** deploy, then set ONLY
`RESERVATION_EDIT_V2_MID_DECREASE=true` and `RESERVATION_EDIT_V2_POST=true`. Leave
`RESERVATION_EDIT_V2` at `"false"` — it also unlocks PRE-phase editing, whose QAMF player sync is
blocked by a vendor bug. Refunds are exempt from it by design (`isRefundOnlyPlan`).


Owner requirement (2026-07-27): **the Payments tab and History tab in ManageReservationModal
must reflect EVERYTHING we do to a reservation** — edits, partial/full refunds, store credit,
gift-card adjustments, and the new post-day-of refund chain. Any money step that doesn't
surface in those two tabs is unfinished. Full plan doc lands at
tasks/future/post-dayof-refund-plan.md (research workflow in flight).

Owner requirement (2026-07-27): **full testing is part of the plan** — unit tests per money
step/allocator/guard, live API probes at the non-accounting location `6MZJFTGAYD7TC`, and an
end-to-end seed+smoke of the real flow (book → pay deposit → check in → charge day-of →
partial refund chain → verify Square + Neon + Payments/History tabs) before anything is
called done. No flag flips without the smoke checklist passing.

## KNOWN ISSUE (parked 2026-07-27): PRE-phase race edit — heat removal can't match order line

Owner call: **park until the post-day-of refund flow ships, then return.** Repro (res 16924-era,
Pedro Quinones fort-myers 7/27 9:36 PM, 3 heats): Edit Reservation → remove one "Starter Race
Red" heat → PRICE panel shows `pricing_unresolvable`: "no order line matches removed heat
'Starter Race Red' — the order money can't be derived safely; adjust this one manually in
Square". Source: the exact-match guard in `raceLegPlan` — a removed heat must match a live order
line by `catalogObjectId` OR exact `name`. Guard is failing SAFE (no money moves), so no urgency.

**ROOT CAUSE FOUND 2026-07-28** (while building the Refund action): a race booked as a **PACK**
bills the day-of order as ONE collapsed line — res 16426's order carries a single "Rookie Pack"
×1 = $27.67, not per-heat race lines. Per-heat removal therefore has nothing to match, by
construction; it is not a name/catalog divergence. Post-payment phases route around it entirely
via `spec.orderLines` (return the pack line — that IS the refund), and the guard message now
points there. **PRE still needs a real fix:** reprice against the pack (a partial pack removal has
no defined price) or refuse pack bookings with a pack-aware message. Do NOT widen the matcher to
unit-price fallback — on a collapsed pack line that would silently refund the wrong amount.

## Bowling reservation flow redesign (single time pick + offer-accurate availability) — BUILT 2026-07-19, DARK

Full plan: [tasks/bowling-reservation-flow-plan.md](bowling-reservation-flow-plan.md). **Built on
branch `claude/bowling-reservation-flow-0rd3nx` (plan PR0→PR3 as sequential commits), pushed for
Vercel preview testing.** Fixes four owner-reported problems in web booking v2 AND kiosk bowling:
double time selection, offers shown at times not actually bookable for that duration (1.5h
available ⇒ 2h shown), dated offer screen, past times shown as available (12:00 PM at 12:17 PM).

What's live-on-merge even with the flag dark: past-time now-floor on all full-day scans ·
`optionCheck=accurate` duration filtering for the classic offer step, World Cup, and combo legs ·
duration guards at hold/reserve/reschedule (typed 409s, pre-charge only, fail-open on infra
errors) · superseded-hold release. What's flag-gated (`NEXT_PUBLIC_BOWLING_ONE_TIME_FLOW`, or
per-session `?bowlingV3=1` on web + `/kiosk/flow?bowlingV3=1`): the v3 Date → Experience →
Time flow (merged tier+package screen, "Next Available" hero + accurate grid, tap = eager hold)
on web AND kiosk. Accurate mode is implemented as plan branch D (windowed necessary-condition
filter) — the QAMF probes below can upgrade it to branch A/B/C.

- [ ] **Owner: preview-test both surfaces** — `/book/bowling/v2?bowlingV3=1`,
      `/book/kbf/v2?bowlingV3=1`, `/kiosk/flow?bowlingV3=1` on the Vercel preview; plus classic
      flow regression (flag dark): offer step now hides truly-unfittable durations, and no past
      times anywhere at :17 past the hour
- [ ] Run QAMF probes P1–P8 from local dev (`scripts/qamf-duration-probe.mts`, plan §7) — P6
      picks the availability design branch (A–E); D is what's built
- [ ] Then: PR4 polish leftovers if any → PR5 flip (flag default-on + schema bumps 2→3 / 10→11,
      ops sign-off on preview per plan §11) → PR6 delete classic steps
- [ ] Known pre-existing failure unrelated to this train: `lib/guest-survey-db.test.ts` (5, see
      2026-07-06 note below)

## Kiosk Online & Group Waiver — ON MAIN, BUTTON OFF BY DEFAULT (2026-07-18/19)

Attract-screen entry → `/kiosk/waiver`: guest picks today's reservation (next 2h, waiver
events, event name or "First L." labels — daily-events group/online split), sees "First L."
of everyone registered with a currently-valid waiver, and adds people via the LIVE kiosk
people step (`KioskAttractionPeopleStep.Component` mounted over a local, non-persisted
instance of the real booking reducer — deliberately NOT an extraction, that file is
multi-writer-hot; the waiver page inherits the guardian-signer flow, Title Case etc. for
free). Joins persist to Neon `kiosk_waiver_joins` FIRST; BMI `registerProjectPerson`
attach runs after. Race now / Bowl now attract chips hidden same day (owner: "might come
back later" — commented in AttractScreen).

Flags (owner 2026-07-19, revised after first live look — "turn the event thing off by
default for now"): attract button is OPT-IN, default OFF —
`NEXT_PUBLIC_KIOSK_GROUP_WAIVER_ENABLED=true` in Vercel + redeploy shows it; the
/kiosk/waiver page stays typed-URL reachable for staff testing. BMI attach stays
default-ON (`KIOSK_WAIVER_BMI_ATTACH=0` kills it) — moot while the flow is unused.
NOTE from the 1 AM live test: a just-created reservation takes up to ~6 min to reach the
picker (5-min daily-events cache warm + 60s shaped cache) — expected, but remember it
when testing.

Probe `apps/web/scripts/kiosk-waiver-attach-probe.mts` dry-run DONE (2026-07-19):
A1 = personsByIds has NO waiver fields (Pandora fan-out in roster route is required);
A2 = Pandora person GET accepts 17-digit Office ids (live-verified).

- [ ] **A3 probe (recommended even though attach defaults ON):** staff-create a THROWAWAY
      test reservation + test person, run
      `PROJECT_ID=… PERSON_ID=… APPLY=1 npx tsx scripts/kiosk-waiver-attach-probe.mts`
      → confirm projectPersons +1, state/products unchanged, idempotency. A rejected attach
      is contained (Neon row 'failed', guest unaffected) but watch `listFailedJoins()`
      after the first real event; kill with `KIOSK_WAIVER_BMI_ATTACH=0` if BMI misbehaves.
- [ ] **Owner live smoke** on a real kiosk (picker window + labels, new person photo+sign,
      returning OTP person, minor + guardian-signer flow, sequential second signer, idle
      reset).
- [ ] Follow-up: migrate `app/event/[slug]/page.tsx` local `makeDisplayName` to
      `@/lib/display-name`; consider a retry sweep for `kiosk_waiver_joins` rows with
      `bmi_attach_status='failed'` (`listFailedJoins()` exists).

## Kiosk — expired returning-racer license (deferred, needs a data source) (2026-07-19)

Shipped `d63fc584`: a MIXED race party (returning + new racer) auto-enrolls the new
racer(s) in the full Rookie Pack and skips the license/POV step. Owner asked to also show
the license page when a **returning** racer's license is EXPIRED — deferred because the
data + charge path don't exist:

- **No license-expiry signal anywhere.** The racer lookup (`PersonData` in
  `ReturningRacerLookup.tsx`) returns `memberships` (tier-name strings, no dates),
  `races` (a count), `birthDate`, `creditBalances`, `waiverValid` — **no license field**.
  `PartyMember` has none either. Only the **waiver** has an expiry (`waiverValid` /
  `waiverExpiry`); the racing license does not.
- **Charge also keys off `isNewRacer`.** `checkout.ts` charges the license per
  `m.isNewRacer && !packageRacerIds` — so even if the page were forced to show for a mixed
  party, a returning racer (`isNewRacer=false`) with an expired license would NOT be
  charged. Structurally, "needs a license" == `isNewRacer` today.
- **To implement:** source a license-expiry date (confirm whether BMI Office's person
  response carries one, or whether "Racing License" appears in the memberships array as
  active-only), then flag an expired returning racer as needs-license (set `isNewRacer=true`
  or add a `needsLicense` field) so the page shows AND the license charges. Until then a
  returning racer is assumed licensed — matching the web flow.

## Kiosk minors-first + guardian-signs waiver — BUILT (2026-07-18), not yet live-verified

Minors can register FIRST on the kiosk; a guardian is only involved when the minor's waiver
actually needs signing (first-timer or expired — a returning minor with a valid waiver needs no
guardian at all). Guardian resolution overlay in `KioskPeopleStep`: pick an adult already here
(party adult or prior guardian chip) · add a NEW adult · find an existing account (OTP lookup).
Guardian must have a valid OWN waiver first (signs it in-chain), then signs the minor's waiver
as Pandora `sigPersonID` (plumbed through `/api/pandora/waiver` POST → `pandoraSignWaiver` →
`WaiverSigning.signerPersonId`; self-sign default unchanged). Signer-only guardians live in
`session.guardians` (NEW — machine actions add/update/removeGuardian, schema v10) so they are
excluded from products/heats/charges/BMI bill registration BY CONSTRUCTION; roster shows a
dashed "Guardians — signed, not playing" chip with **Join the fun** (same id moves into party,
minors' `guardianMemberId` refs stay valid). Receipt contact switches to the guardian when the
Main person is a minor. ~~BMI-level `guardianID` link is best-effort via re-upsert.~~
**RESOLVED 2026-07-25 (Strachan incident):** the "re-upsert" provably CREATED A DUPLICATE person
per minor sign (Pandora create is NOT an upsert — see lessons.md § Pandora create is NOT an
upsert). `linkMinorToGuardian` was removed; the waiver's `sigPersonID` is the guardian record.

- [ ] **Live-verify on the kiosk dev flow** (see plan verification list): minor-first paths
      (valid-waiver / new-adult / lookup / expired-adult chain), guardian absent from charges +
      `registerProjectPerson`, log line `signer=<short id>`, two-minors-one-guardian, join-the-fun.
- [x] ~~Confirm whether the Pandora upsert persists `guardianID` on an existing person~~ —
      confirmed 2026-07-25: it persists it on a fresh DUPLICATE person (guardian's `related`
      pointed at two no-waiver orphans). `linkMinorToGuardian` dropped.

## Kiosk CRT-591 card reader/dispenser — DRIVER + TEST PANEL + GAME ZONE WIRED (branch `kiosk`)

**Driver + test panel (2026-07-17, hardware-verified):** Web Serial driver for the CRT-591 COM
protocol (`apps/web/src/features/kiosk/card-reader/` — frame codec w/ STX-resync, ACK/NAK/EOT
engine, typed commands, e1/e0 decode, auto-baud + identity discovery, B0 auto-reinit) + staff
test panel (`/kiosk/admin` → Card reader tab) + USB wedge capture. Verified on the real unit
(CRT-591-(R02)HB-HDN, fw `CRT-591-V1.00`, 115200 baud, magstripe over COM via `C 36 37`; buy
= `MOVE 34h`→read→`MOVE 30h` present, reload = `ENTRY 32h`→read→`MOVE 30h`→`ENTRY 30h` stop).
Docs `docs/crt-591/{README,protocol}.md`.

**Game Zone guest flow wired (2026-07-18):** `simDispense()` + typed-number input replaced with
the real reader. Reusable `useGameCardDispenser` hook (card-reader/) owns one connection per
session. BUY = one upfront charge (`/api/game-cards/purchase` kind:`new_card`, charge-only) then
per card: `dispenseAndRead` → `/api/game-cards/load-card` (creditTokens) → present (or capture
to bin on load fail); blanks are pre-encoded so no Intercard issuance needed. RELOAD = insert →
read → **always return the card** → verify → pay once (`purchase` kind:`reload`, unchanged) →
`prohibitEntry`. Also fixed the location-code bug (component sent 9/11; canonical 12/6/13 via
new `centerCodeFor` in `config/intercard-centers.ts`) — reload was throwing UNKNOWN_LOCATION at
both Fort Myers venues. 170 kiosk+game-cards tests green; tsc + eslint clean; routes smoke-OK.

- [ ] **Hardware session:** run buy (multi-card) + reload end-to-end on the kiosk against real
      Intercard — confirm balances via `/verify`; drill stacker-empty + a forced load failure
      (capture path) + Fort Myers reload (location-code fix).
- [ ] Request the CRT-591-(R02)HB-HDN magstripe protocol doc from the vendor (only the M001
      RFID/IC doc exists publicly; magstripe commands are reverse-engineered from captures).
- [ ] Follow-up: `msrEnabled` (reload-only, non-dispenser MSR) hardware path — currently the
      typed/wedge input; new_card linking for signed-in guests.

## Gate /api/bmi-office behind OTP verification — NOT STARTED (security)

`/api/bmi-office` is an unauthenticated proxy to BMI Office: anyone can call
`?action=search&q=<phone>` then `?action=person&id=…` / `?action=deposits&personId=…` and get
full racer PII (name, email, DOB, memberships, credit balances) with zero verification. The
returning-racer flow's OTP gate is client-side only — `ReturningRacerLookup` fetches all PII
into state BEFORE sending the code, and the `verified:<phone>` Redis flag set by
`/api/sms-verify` PUT is never checked server-side.

- [ ] Gate `action=person|deposits` (at minimum) on the `verified:<phone>` flag
- [ ] Reorder the client flow: send + verify OTP first, then fetch accounts
- [ ] Check the v1 component + any other `/api/bmi-office` callers before tightening

## Reservation-edit: VIP rows blocked from scaling edits (two primary-kind lines) — 2026-07-11

VIP experiences (`vip-fri-sun`, `pizza-bowl-vip`, `fun-4-all-vip`, world-cup variants) bundle
"VIP Chips & Salsa" (product 109, kind `open`) alongside the lane product — so these rows have
TWO primary-kind lines. `resolveBookedPricing` throws "found 2" (no stamp; backfill skips them)
and `repriceBowling` hard-refuses at edit time ("multiple primary lane lines"). VIP rows fall
to carry mode: shoes/roster/food edits work; player/lane/duration edits refuse. ~30 upcoming
rows affected as of 2026-07-11.

Fix needs a design decision, not a hack: either (a) reclassify chips & salsa as `addon_food`
in the catalog (check the VIP booking flow doesn't key on kind `open`, and decide whether it
scales with lane count on edits — the experience bundles it per lane), or (b) teach
reprice/derivation a designated-primary rule (e.g. the experience's duration-override family)
and scale bundled secondaries × laneCount per the original §4 spec. Until then the clean
refusal stands.

## Resadmin VIP race-truth (board stops clock-guessing race Done) — MERGED TO MAIN 2026-07-08

Problem: VIP combo cards mark a race step "✓ Done" purely off the clock
(`stepProgress` in `src/features/reservations-admin/combo-board.ts` — `now >= start+duration`),
so a delayed heat shows Done while the party is still waiting; retirement (30 min past last
step) can drop a delayed combo from Active Only before the race runs. Bowling already has
QAMF lane truth (`legStatus`); races have no truth signal today.

**Pandora SHIPPED `actualStart` / `actualEnd` — verified live 7/8 ~7PM ET** (explicit
`null` until they happen, never omitted) on the session objects of
`GET /v2/bmi/sessions/{locationID}` — deliberately timestamps NOT a state enum (vt3
`status`-drift lesson, see lib/video-match.ts:31). Derivation: `actualEnd` set → Finished ·
`actualStart` only → On track · neither + session is the track's `races/current` entry →
Called · neither + scheduledStart past → Delayed (amber) · neither + future → Upcoming.
Cancelled needs no state: heat vanishes from the bill's re-read `liveHeats`.
Live-test notes: delays are real (Blue heat 35 started 22 min late — the exact bug);
**actualEnd can fail to stamp** (heat 35 stayed open while 36-40 finished) so on-track must
be sanity-capped: finished if a later same-track heat has actualStart, or ~20-min cap.
Past dates return empty — same-day only. Our sessions proxy passes the fields through
as-is; pre-race-tickets keeps the Redis cache ≤2 min stale during ops hours.

Built on branch `fix/resadmin-vip-race-truth` (651bf4d8, pushed — PR: https://github.com/BMA-Dassle/Tools-Website-FT/pull/new/fix/resadmin-vip-race-truth). States shipped as finished/on_track/called/not_called; derivation is the pure module `src/features/reservations-admin/race-live-state.ts` (18 new unit tests; 55 green in the feature dir; tsc clean apart from 2 pre-existing scratch-script files).

- [x] **Server** (`app/api/admin/bowling/reservations/route.ts`): where `liveHeats` attaches,
      resolve each heat → Pandora session (sessions proxy `prefer=cache`, warmed 2-min by
      pre-race-tickets; match track + scheduledStart, UTC↔naive-ET convert) and stamp
      `raceState: "ran" | "called" | "not_called"` (absent = no data → clock fallback).
      Sources in order: session `actualStart`/`actualEnd` (once live) → `races/current` +
      Redis last-race-per-track watermark (`pandora:last-race:fasttrax:{blue|red|mega}`,
      checkin-alerts-warmed; heats run in order per track so watermark past heat = ran) →
      nothing. Reuse the 60s in-memory cache pattern (10s board poll must add no load).
- [x] **Board logic** (`combo-board.ts`): `ComboScheduleStep.raceState`; `stepProgress`
      precedence mirrors bowling — `called`/on-track → active "On track now" regardless of
      clock; `ran` → done; `not_called` past scheduled end → active+overdue amber
      "Delayed · not called yet"; no signal → current clock behavior.
- [x] **Retirement**: combo with a `not_called`/`called` race step can't go `inactive`;
      hard cap end of operating day (no-show party: heat still gets called track-wide,
      which retires the card 30 min later anyway).
- [x] **UI** (`VipComboCards.tsx`): pill wordings only. Main list inherits via schedule index.
- [x] **Tests**: extend `combo-board.test.ts` — delayed heat stays active past clock-end;
      watermark/actualEnd flips done early+late; no-signal fallback; retirement guard.
- [ ] **Live smoke** on a real combo night (delayed heat shows amber, flips Done on next call).

Phase 2 (separate, later): party-level truth — participants `checkedIn` + F_PAR_STATE docs
(asked Pandora) or vt3 video-match; needs racer personIds or name matching vs
`booking_metadata.racerNames`.

## Race close-out on track truth (race-dayof-pay settle gate) — MERGED TO MAIN 2026-07-08

Branch `fix/race-dayof-settle-truth` (84cc3d7f, pushed — STACKED on
`fix/resadmin-vip-race-truth`; merge that PR first, then re-base/merge this one).
The cron's no-check-in fallback charged races the instant the clock passed the first heat's
scheduled start ("TEMPORARY" per its own header) — heats run 6-22+ min behind, so guests could
be charged before racing. Owner decisions 7/8: settle when the LAST booked heat actually
finished (Pandora actualStart/actualEnd via `raceSettleGate` in race-live-state.ts);
unresolvable heats clock-settle at start +45 min; past-date stragglers immediately; +6h hard
cap; resolved-but-delayed heats WAIT past the net (truth wins); `reservation-status-close`
+2h flip, attractions, combos, -5 arrival path all unchanged.

- [x] Pure `raceSettleGate()` + 8 unit tests (63 green in feature dir; tsc clean)
- [x] Fetchers extracted to `race-live-state.server.ts` (shared board + cron; verbatim move)
- [x] Cron gates race fallback; `dayof_order_source` = `-fallback-raceend` (verified finished)
      vs `-fallback-timepassed` (any clock path); skip logs show gate waiting reason
- [x] Merged to main 7/8 (ff, with fix/resadmin-vip-race-truth) — deploys with next Vercel build
- [ ] **Live smoke** on a race night: `?dryRun=1&token=…` shows `waiting: … on_track` for a
      delayed heat instead of charging at scheduled start; settles minutes later with source
      `-raceend`; a -5 arrival still charges immediately (source `race-dayof-pay`)

## Ultimate VIP improvements — MERGED TO MAIN 2026-07-06, ALL DEFAULT ON; live smoke pending

Owner decisions (locked 7/6): reserve the combo's Starter anchor heats from regular bookings
(release 60 min before, Starter anchors only) · steer later same-date VIP bookings onto the
existing group's schedule (default + highlight, staff email flags non-matches) · juniors get a
mirror heat right AFTER the adult heat on both race legs, same per-person price. Owner 7/6:
everything defaults ON — each env flag is now a kill switch (`=false` in Vercel + redeploy;
build-baked). Plan file: `~/.claude/plans/cheeky-wandering-lampson.md`.

- [x] **Anchor reserve** — `vip-combo-anchor-reserve` restriction rule (empty slot at
      2/4/6/8/10 PM blocked on every track/tier, occupied-session joins allowed, 60-min
      lift, "VIP Reserved" disabled card) + per-rule `exemptComboBookings` / ctx
      `isComboBooking` so the combo's own `bookHeatsOnAdvance` path bypasses ONLY this rule.
      Kill: `NEXT_PUBLIC_COMBO_VIP_ANCHOR_RESERVE=false` (also inert if the combo is off).
      NOTE: on deploy the 2/4/6/8/10 PM heats grey out for regular racers immediately.
- [x] **Group match** — `combo-group-match.ts` (pure matchers) + `combo-existing.server.ts`
      over `listVipComboReservations` + GET `/api/booking/v2/combo/existing` (fail-open, no
      PII) + grid banner/badges ("Joins/Near the 4 PM group", gold ring) + staff-email match
      note (exact / same-hour-different-race ⚠️ warning + subject suffix / different-hour
      neutral FYI — 2026-07-10: warning narrowed to the same-hour case only). Kill:
      `NEXT_PUBLIC_COMBO_GROUP_MATCH=false` (email note unflagged). Advisory-only: reads
      booking_metadata heat times; office reschedules degrade the hint, never block.
- [x] **Junior mirror** — mixed parties book juniors on the first junior block strictly
      after the adult heat (36-min window, `pickJuniorMirror`); leg end = last race + 30 min
      (`raceLegEndMs`) so the bowling 75-min window measures from the junior heat; confirm
      modal shows "Juniors race at 2:12 PM on Blue"; staff email rows tagged "— Juniors".
      Kill: `NEXT_PUBLIC_COMBO_JUNIOR_MIRROR=false` = byte-identical same-start path. Known
      limits: junior Starter is Blue-only (juniors race Blue whatever the adults pick);
      Mega Tuesday stays junior-blocked (no BMI junior Starter Mega product).
- [x] Merged 1 → 2 → 3; ~36 new unit tests green; tsc clean; branches deleted.
- [ ] **Post-deploy live smoke:** regular picker greys "VIP Reserved" at 2:00 PM (2:12
      bookable), combo still books 2:00, card frees at T-59 · book VIP group A at 4 PM →
      reopen wizard → badge; book B on it → "same Starter heat" email; group C same hour
      but different heat (e.g. 4:12) → ⚠️ SAME HOUR, DIFFERENT RACE email; group D at 8 PM →
      neutral FYI note, no warning · 2 adults + 1 junior e2e on a non-Tuesday (junior heat right
      after adult on BOTH legs on the BMI bill; bowling scheduled off the junior heat).
- [ ] **Unrelated, found during merge:** `lib/guest-survey-db.test.ts` has 5 pre-existing
      failures on main (seed grew 22 → 30 questions — racing survey — without updating this
      older test). Fix or retire the stale test.

## Cancel & refund improvements (all-kinds cancel + store-credit gift cards) — BUILT 2026-07-03

**Branch `feat/cancel-refund-improvements` — not yet merged.** Owner decisions: no reschedule
flows beyond the existing bowling one; every other change = CANCEL with two outcomes — refund
to card, or convert the deposit into a NEW customer gift card (Square-generated GAN — internal
WEBHPFM… GANs are blocked from online payment) that the guest rebooks with (self-settles
weekday/weekend price differences). Combos staff-only; customer self-serve = gift card only;
staff can keep the GAN (notifyGuest=false) for phone rebooks; every cancel emails+texts.

**Built:** money-group cascade (`src/features/cancellation/` — 82 unit tests) over every row
sharing the deposit order (combos + mixed carts cancel together): audit row →
exactly-once per-tender refunds OR gift-card issuance (GAN persisted BEFORE
activation/delivery) → mark legs cancelled → best-effort teardown (day-of orders w/ tendered
refusal, GC drain ADJUST_DECREMENT + deactivate, QAMF delete, BMI project -4 via W-number
search + verify, add-ons, loyalty, promo) → email/SMS. New `reservation_cancel_events` audit
table doubles as idempotency attempt counter. Routes: `POST /api/admin/reservations/cancel`
(dry-run preview, both outcomes, all kinds), `POST /api/booking/v2/self-cancel` (HMAC sig),
legacy cancel routes delegate (fixes the combo single-leg bug for stale tabs). Portal: cancel
on ALL kinds + Cancel Combo on VIP cards + outcome picker modal (auto dry-run body) + GAN
copy button + durable "GC 1234-… ($X)" / "-$X" display on cancelled rows. Customer: v2
confirmation "Can't make it?" section + BowlingConfirmation gift-card-only swap — **shipped
ON, no flags (owner call 7/3)**; the guest card is branded **HeadPinz FastTrax Gift Card**
(order line item, emails, SMS, all UI).

- [x] 82 feature unit tests green; tsc + eslint parity with main; each step committed green
- [x] Dry-run exercises on prod rows (all shapes + a live combo; partial-redemption block
      verified on a real tonight-combo) · owner previewed the modal on Vercel preview
- [x] **Probe ran 7/13 — VERDICT: PURCHASE** (gift-card tender accepted on a GIFT_CARD-line
      sale; full sequence verified, probe objects cleaned up). Code default flipped to
      "purchase" on main (0b99d15a) — no env needed; `STORE_CREDIT_STRATEGY=comp` is the
      explicit fallback. If comp is ever re-enabled, create the dedicated catalog discount +
      `SQUARE_STORE_CREDIT_DISCOUNT_CATALOG_ID` (else it books against the survey discount).
- [ ] Post-deploy live smoke: race gift-card cancel e2e (GAN redeemable online, sweep
      dry-runs skip the -4, day-of order CANCELED) · admin refund + idempotent re-run ·
      combo both outcomes · tendered-day-of refusal

## Race product step redesign (Option C) + stepper overlap fix — SHIPPED 2026-07-02

Owner picked Option C from mockups: each tier is ONE card; Single vs 3-Race Pack are
side-by-side selectable columns inside it (5 cards → 3 for a returning racer). Copy rewritten:
one-line descriptions, qualification/ages in the tier section header (junior screens drop the
adult age line), "Runs on Red + Blue — pick your track with your heat time" dot line replaces
bare track chips, prices unified white (amber only for "Save $X"), first-visit license note
shows ONLY for new racers. Discount banner 🏁 emoji → IconDiscount2 (@tabler/icons-react).
Selection semantics untouched (each column selects its RaceProduct via handleCardClick).
Also: sticky stepper + timer bar `top-18/top-20` → `top-[120px]` (fixed nav is ~120px tall —
was overlapping the stepper).

- [x] `RaceProductStep.tsx` TierCard replaces ProductCard; `BookingFlow.tsx` sticky offsets
- [x] Verified live via dev server + puppeteer with seeded `sessionStorage.booking_session`
      (v2 envelope, item cursor): returning pro (3 cards, both packs, Save $13), new racer
      (license breakdown + note), junior (Blue-only, meta sans age), weekend (Save $21,
      $19.99/race, no Pro), pack-column click → SELECTED flag + Next enabled, mobile 390px
      stacks clean, stepper clears nav. 268 booking tests + tsc clean.
- [x] Merged to main per owner (was slated for preview-first; owner said push to main)

## Cross-reservation heat spacing + heat-cap removal — 2026-07-02

**Problem (owner):** racers dodge the per-racer spacing rules (same-track 13-min, cross-track
30-min) by booking each heat in a SEPARATE reservation — the conflict check only saw the cart,
and only client-side. **Decisions:** spacing rules only (no daily cap — the per-cart
6-heat `SINGLE_RACE_MAX_PER_RACER` is REMOVED entirely) · hard block · forward-only (no
backfill; personId matching covers returning racers; a re-registered "new" racer duplicates
the BMI person and slips — accepted).

**How:** persist `bmiPersonId` + racer name per heat in `booking_metadata.heats` at reserve
(shared `raceHeatsMetadata` in checkout.ts, used by BOTH reserve paths) → server guards in
`/api/booking/v2/reserve` (step 0b) + `unifiedReserve` (guard 0b) query Neon
(`raceHeatsForPersonsOnDate`, excludes own bill so retries don't self-conflict) and run
`findCrossBookingConflict` (conflict.ts — same heatsConflict rules) BEFORE any Square write →
409 EXISTING_BOOKING_CONFLICT with racer name + times. Picker greys the same slots up front
via GET `/api/booking/v2/booked-heats`. Fail-open on query errors everywhere.

- [x] 268 booking tests pass (7 new) · tsc clean · SQL live-validated against prod Neon
      (0 matches expected pre-rollout; 299 heats scanned; exclude param works)
- [ ] Live verify post-deploy: book a race, then try an adjacent heat for the same racer in a
      fresh session → picker greys it / reserve 409s; confirm new rows carry bmiPersonId

## Race restrictions: reserve 2 Starter slots/hour + unconditional junior back-to-back — IN PROGRESS 2026-07-02

**Owner decisions (2026-07-02):** all three tracks (Red/Blue/Mega) · only ADULT starter counts
toward/consumes the guarantee (junior starter is a consumer like int/pro) · 60-min last-minute
lift on the reserve rule · blocked slots HIDDEN. Plus: junior back-to-back becomes unconditional
("regardless of anything") — no last-minute override, and adjacency counts ANY junior race
(cross-tier via categoryTrackBlocks, not just the candidate's own tier). Hidden like Pro.

**Design:** new constraint `reserveStarterRoomPerClockHour {minRoom:2}` in
race-restriction-rules.ts. Counts remaining "starter room" in the candidate's clock hour =
distinct heat starts that are empty OR occupied by an adult-starter race (occupied heats are
tier-exclusive in BMI availability, so tag blocks by source product). Blocks a non-adult-starter
pick when booking it would leave room < 2. Room-counting (vs. hardcoded cap of heats/hour − 2)
degrades conservatively when BMI drops passed/sold-out heats and handles partial hours.
Two rule entries cover "everything except adult starter": tiers [intermediate,pro] all
categories + tier starter category junior (Blue only — juniors don't run Red/Mega starter).

- [x] `race-products.ts`: `singleRaceProductsOnTrack(track, schedule, racerType)` (all
      tiers+categories, !packType); reimplemented `juniorProductsOnTrack` on top of it
- [x] `race-restriction-rules.ts`: renamed `noAdjacentOccupiedSameTier` → `noAdjacentOccupied`
      with `scope: "tier" | "category"`; junior b2b rules → scope category, override dropped;
      new `reserveStarterRoomPerClockHour` constraint + `trackAllTierBlocks` ctx (tagged
      `adultStarter`); 2 new rules; header doc updated
- [x] Unit tests: 52 pass (12 new reserve-room cases + junior b2b cross-tier/unconditional)
- [x] `RaceHeatPickerStep.tsx`: junior-Mega-only fan-out → all-tier per-track `crossTierProducts`
      fan-out (skipped for adult-starter grids); one query set feeds junior + tagged unions
- [x] `race.ts` `assertHeatBookable`: all-tier union, Promise.all best-effort sibling fetches;
      junior union now covers Blue AND Mega
- [x] `_restriction-smoke.mts`: rewritten to run EVERY single product on a track with the unions
- [x] vitest (261 booking tests) + tsc clean (only pre-existing scratch-script errors)
- [x] LIVE SMOKE (2026-07-02): Blue Thu = exactly right blocks (hour-18 reserve, junior
      cross-tier b2b at 17:48/19:00, Starter never blocked); Mega 7/7 empty→no blocks; Red Fri
      sparse→no blocks. Live data forced one fix: joining an already-occupied session consumes
      no room → never reserve-blocked (was blocking a 16:48 join).
- [x] Verified live: occupied heats ARE tier-exclusive (16:12 occupied-Int absent from Starter
      list); room-counting is drop-off-safe by construction either way.
- ⚠️ DISCOVERED: Blue ran a 12-MIN cadence on 2026-07-02 (17:00/17:12/17:24…), not the 15-min
      the opening-heats-express-only-15min windows + jr-b2b gap-16 comment assume. Reserve rule
      is cadence-independent (counts real slots); the OPENING-WINDOW rule for Blue would cover
      3 heats (13:00/13:12/13:24) on 12-min days, not 2 — confirm intent with owner.
- [ ] Commit on a fresh branch off main (changes currently uncommitted in the working tree;
      current checkout is feat/account-dashboard-login — unrelated)

## Self-service "edit reservation up to check-in" — SPEC, awaiting approval 2026-06-21

> **2026-07-11:** the admin-side superset of this feature is now fully specced, APPROVED, and
> **BUILT** (branch `claude/reservation-editing-plan-vvh9ee`, all flags OFF) — see
> [tasks/future/reservation-editing-plan.md](future/reservation-editing-plan.md) § 16 for the
> flag matrix + the live-smoke gate that must run before enabling (staff edit engine: repricing,
> refunds both directions, QAMF/BMI sync, card-on-file vault + 72h sweep, EditReservationModal,
> self-hosted payment-difference page). This self-service spec becomes a thin guest-facing
> client of that engine; the engine now exists.

**Goal:** let a guest change their booked bowling reservation (food, players, lanes, time)
any time before check-in; if the change increases the total, charge the difference.

**Locked decisions (from owner 2026-06-21):**
- Scope = **everything**: food add-ons, player count, lanes, time.
- Difference charged by **re-entering a card on the edit page** (Square Web Payments; no card-on-file assumption).
- **Add-only — no reductions/refunds.** An edit may never lower the paid total; staff handle reductions manually.

**Grounding (verified):**
- Edit surface = the existing confirmation page reached via `headpinz.com/s/{shortCode}` (short-url → confirmation).
  Reservation lookup already exists: `GET /api/bowling/v2/reservations/by-code`.
- Repricing must reuse the quote path (`/api/square/bowling-orders/quote` + reserve pricing) to honor the
  **displayed-vs-charged hard-fail guard** (project rule) — recompute exactly, never trust client totals.
- Food-line attach to the day-of order already exists (shipped c00286ac) — Phase 1 reuses it.
- **QAMF has NO time/lane reschedule API in our client** (`patchReservation` = Title/Notes/Status only; we only
  *sync* BookedAt FROM Conqueror). Changing time/lanes ⇒ **cancel (`deleteReservation`) + `createReservation`**
  anew → re-check availability, re-link deposit/day-of order, risk slot loss. This is the hard part.

**Editability guard (all phases):** allow only while `status ∈ {confirmed, confirm_pending}`,
`dayof_order_sent_at IS NULL` (not checked in / lane not opened), and event time still in the future.
Optimistic guard against the lane-open cron racing the edit.

**NARROWED v1 (active, owner 2026-06-21): edit the PIZZA TOPPINGS + SODA flavor of a Pizza Bowl only.**
No player/lane/time changes; no adding pizzas/sides. Guests re-pick toppings/drinks before check-in.
- [ ] Edit surface on the confirmation page (`headpinz.com/s/{shortCode}`): load current pizza/soda
      selections per lane, reuse `BowlingFoodStep` UI to re-pick toppings + drink.
- [ ] Edit endpoint: guard (pre-check-in, future, status ok) → recompute rawItems (pizza/soda lines w/ new
      topping/drink notes) → reconcile onto the day-of Square order (update existing food line NOTES by uid,
      or remove+re-add) → update persisted `bowling_reservation_lines`.
- [ ] $0 swaps (same topping count) are free. **Adding paid extra toppings (>1/lane = $1 each):** OPEN
      QUESTION below — include the re-enter-card charge now, or restrict v1 to no-new-cost edits (paid extras
      added at the counter).
- [ ] If the food line isn't on the order yet (older orders pre-fix), add it during the edit.

**Later phases (deferred):** Phase 2 player count (reprice + `setLanePlayers`); Phase 3 lanes/time reschedule
(HARD — no QAMF reschedule API; cancel+rebook only, slot-loss risk). Spike Phase 3 before building.

**Payment-for-difference design:** recompute authoritative total → `diff = new_total − already_paid`;
enforce `diff ≥ 0` (add-only); if `diff > 0` require a fresh Square nonce on the edit page, charge with an
idempotency key bound to (reservationId, new_total), apply to the day-of order; hard-fail + page on-call if
displayed diff ≠ charged diff. Record an edit-audit row (what changed, diff, payment id, timestamp).

**Open questions for owner:**
- Phase 3: acceptable that a time/lane change briefly cancels + rebooks in QAMF (tiny window where the old
  slot is released)? Or restrict time/lane edits to "request" (staff-confirmed) rather than self-service?
- Any cap on how close to start time edits are allowed (e.g. block within 1h of the slot)?

**Verification:** live smoke per phase — book → edit (add paid item) → confirm difference charged once, day-of
order + Neon lines updated, QAMF reflects change, KDS gets the added food. No double-charge on retry.

## Christmas in July — landing page (B2B holiday open house, 2 locations) — IN PROGRESS 2026-06-15

Branch: `feat/xmas-in-july-landing` off `origin/feat/xmas-in-july-event` (NOT yet on main).
URL slug stays `xmas-in-july`; display title is **"Christmas in July"**.

**What it actually is (per flyer — corrected mid-build):** a festive **business-leader open house**,
NOT a public free-race promo. Holiday bites + signature drinks + venue/party-hosting pitch.
Included per guest: 2 drink tickets · holiday buffet (TBD) · complimentary bowling · 1 go-kart race (FM).
**Two events, one page, choose location:** Fort Myers 7/30 (HeadPinz & FastTrax, racing) and
Naples 7/23 (HeadPinz only — NO FastTrax, so RSVP-only). Both 4–7 PM; racing slot 4:30–5:30 PM.
Open RSVP. Decisions: one page w/ location chooser · RSVP + race booking · open access.

### Done
- [x] Assets on Vercel Blob (`events/xmas-in-july/`): bowling hero loop (1080/720 + poster), 7 gallery
      photos (WebP+JPEG, family pic dropped → 6 used). Upload script `scripts/upload-xmas-assets.mjs`.
- [x] Racing video = reused FastTrax homepage hero (`images/hero/hero-video.mp4` + `hero-racing.webp`).
- [x] `group-events.ts`: `GroupEventLanding` (heroVideo, included[], locations[], featureVideo, gallery,
      finePrint, eventTime) + `GroupEventLocation` (key/label/venue/date/address/racing). Populated
      `xmas-in-july` with B2B copy, both locations, what's-included. Dropped hard `minAge:18`.
- [x] Page: location-aware hero (bowling video) → "What's Included" → racing feature video → gallery →
      location chooser → RSVP. Naples branch skips waiver/DOB (RSVP-only); FM keeps race-booking funnel.
      Reduced-motion/Save-Data → poster. Confirmation hides waiver/racing-license for Naples.
- [x] RSVP endpoint stores `location` (both venues share the slug — only differentiator for ops).
- [x] tsc clean · build clean · a11y gate 0 violations · SSR renders all sections + chooser.

### TODO
- [ ] **GF photos** — owner sending 2–3 group-function photos; optimize + upload + slot into gallery.
- [ ] Buffet menu (TBD on flyer) — copy update when known.
- [ ] Live smoke on a deploy: FM path (choose FM → email → name+DOB → waiver → book race heat) +
      Naples path (choose Naples → email → name → RSVP confirmation). Verify RSVPs tagged by location.
- [ ] Commit + push branch (not committed yet) → PR link.
- [ ] Confirm with owner: keep slug `xmas-in-july` or add `christmas-in-july` alias.

## ⚠️ Temporary fallbacks to remove later

- **Race + standalone-attraction day-of auto-charge on start-time-passed** (added 2026-06-09,
  user-requested stopgap). `/api/cron/race-dayof-pay` normally settles the day-of order only when
  it sees the guest Arrived (-5) on the SMS-Timing dayplanner. As a safety net it now ALSO settles
  when the **activity start time has passed** (earliest heat for race, earliest slot for
  attraction — from `booking_metadata`, NOT `booked_at`), even if the Arrived scan failed/never
  fired. Standalone attractions = no bowling sharing the day-of order (bowling carts settle via
  lane-open). Remove once -5 detection is proven reliable. Search `FALLBACK` in
  `apps/web/app/api/cron/race-dayof-pay/route.ts` to delete (revert the scan-error bail too).
  NOTE: legacy attraction rows booked before this have empty `booking_metadata` → no start time →
  they're skipped (settle them manually via `?billId=…&token=…` if needed).

## HP Arena E-Tickets — Laser Tag + Gel Blaster at HeadPinz FM (LIVE — 2026-06-11)

**Status:** fully live, including the "now checking in" flow. Runbook + integration notes:
`docs/hp-arena-etickets-rollout.md`. Owner decisions: FM only (Naples later) · laser tag +
gel blaster · full HeadPinz identity (HP sender `+12393022155`, headpinz.com links).

- [x] PR-1..PR-5 (shared plumbing, HP ticket views, pre-session cron, schedule, scanner +
      `ARENA_QR_ENABLED`) — merged to main 2026-06-11, cron live (owner approved skipping the
      dry-run sequence; sender = existing HP DID).
- [x] PANDORA ASK — delivered same-day: `sessions/current` (called arena sessions) +
      `sessions/next` (next unstarted session by person/participant). Wired:
      `arena-checkin-alerts` cron (1 min — `race:called:{sid}` banner + NOW CHECKING IN
      SMS/email, source `arena-checkin-cron`) and scanner (called-signal green gate w/
      time-window fallback, "come back at X" via sessions/next).
- [ ] OWNER 0b: verify whether ONLINE arena bookings attach participants pre-session (book one
      2h+ out, probe participants). If purchaser-only/none → coverage = POS/phone population;
      follow-up = send e-ticket link at booking-confirmation time.
- [ ] OWNER 0d: sign off ImportantArenaInfo arrival/waiver copy (conservative defaults live).
- [ ] POST-LAUNCH WATCH (first week): admin board arena rows, `cron:log` `arena-pre` +
      `arena-checkin`, `unclassifiedSessions` in cron responses, undelivered rate on the HP DID,
      racing `bySource.eTicket` canary.
- ⚠️ BEFORE NAPLES: `ticket:bySession:{sid}:{pid}` + `alert:arena-pre/arena-checkin:{sid}:{pid}`
      + `race:called:{sid}` keys are NOT location-scoped — fine at FM (FT+HP FM share one BMI
      server / sessionId namespace), but Naples is a separate BMI server → add a location
      segment to these keys first.

## Booking V1→V2 FULL CUTOVER + race-pack port (IN PROGRESS — 2026-06-07)

**Goal (user directive):** V2 is the booking system. Replace ALL booking entry points
with entry into V2, AND port race-packs to V2 (the only activity with no v2 today).

**Grounding:** ~90 v1 entry points inventoried; 4 shared components carry most traffic.
Cutover mechanism = server-side redirects (catch emails/QR/bookmarks) + middleware fix +
update the hot shared links. Honors the repo cutover rule (redirect v1→v2; delete v1 later).
Decisions locked by `tasks/future/race-pack-as-credit-purchase.md` + v1 parity: race-pack
DEFERS redemption (credits spent in the existing v2 race flow), NO expiration (v1 = year-2999),
single Square SKU + name override, grant via `addDeposit(+N)` on Square capture.

### Phase A — Entry-point cutover for race/attraction/bowling/KBF (conflict-free w/ other workflow)
- [ ] Middleware: exclude `/v2` paths from the HeadPinz `/hp` + `/book/bowling*` + `/book/kids-bowl-free*`
      rewrites (FIXES latent bug: `headpinz.com/book/bowling/v2` → `/hp/book/bowling/v2` 404). Point
      HeadPinz `/book` (exact) → `/book/v2` instead of `/hp/book`.
- [ ] `next.config.ts` redirects (307 temporary during cutover — flip to 308 when v1 deleted):
      `/book`→`/book/v2`, `/book/race`→`/book/race/v2`, `/book/{gel-blaster,laser-tag,duck-pin,shuffly}`→`…/v2`,
      `/book/bowling`→`/book/bowling/v2`, `/book/kids-bowl-free`→`/book/kbf/v2`, plus `/hp/book/*` equivalents.
      EXCLUDE `/book/race-packs`, `/book/confirmation*`, `/book/checkout`, anything `/v2`.
- [ ] Update 4 shared components → v2: `components/Nav.tsx`, `components/MobileBookBar.tsx`,
      `components/headpinz/Nav.tsx`, `components/headpinz/MobileBookBar.tsx`.
- [ ] Update high-traffic CTAs (home Hero, pricing, racing, leaderboards, hp/fort-myers, hp/naples) → v2.
- [ ] Update static email-template booking URLs (redirects also catch these).
- [ ] **MERGE GATE:** bowling/KBF v2 must pass the QAMF+Square smoke test before this branch hits prod.

### Phase B — Race-pack v2 port (DONE — STANDALONE, 2026-06-07)
**Approach:** standalone `/book/race-pack/v2` (user: "whichever easiest/most efficient"). Deliberately
NOT the in-cart `CreditPackItem` from the design doc — that threads through `unified-reserve.ts` +
`types.ts`, which the other workflow is mid-refactor on. Standalone matches what v1 actually does
(race-packs is its own flow) and reuses v1's PROVEN, server-atomic Square + `addDeposit` money rail.
Touches ZERO files the other workflow is editing.
- [x] `src/features/booking/data/packs.ts` — 6 SKUs verified 1:1 vs v1 (price, depositKind, raceCount, shared Square SKU).
- [x] `src/components/features/booking/RacePackFlow.tsx` — pick pack → identify racer (returning lookup /
      new) → review + clickwrap → `PaymentForm` (lineItem + `postPaymentAction:addDeposit`).
- [x] Route `app/book/race-pack/v2/page.tsx` (thin server shell + metadata).
- [x] Confirmation reuses v1 `/book/race-packs/confirmation` (already renders the viaDeposit "Credits
      Loaded" + "Credits Pending" states) — left on v1, NOT redirected.
- N/A `CreditPackItem` union / `credit-pack` service / `unified-reserve.ts` wiring / step registry —
      unused by the standalone approach (charge goes through `/api/square/pay`, never unified-reserve).
- N/A Landing tile on `/book/v2` — the v1 `/book` hub never listed packs either (parity-correct).
- ⚠️ Simplification vs v1: per-mode OTP omitted (loading credits is non-extractive — the buyer pays to
      ADD value, so there's no account-takeover surface to gate). Revisit if abuse ever appears.
- FOLLOW-UP (optional): in-cart `CreditPackItem` integration once the other workflow's unified-reserve
      refactor lands, if mixing a pack into a multi-activity session is ever wanted.

### Phase C — Race-pack cutover (DONE — 2026-06-07)
- [x] Redirect `/book/race-packs` → `/book/race-pack/v2` (middleware `bookingV2Target`, exact match so
      `/book/race-packs/confirmation` stays on v1). Pricing "View Packages" CTA covered by the redirect.
- [ ] Retire/delete the v1 `/book/race-packs` page in a later PR after ops sign-off.

### Phase D — HeadPinz center-aware v2 landing (DONE — 2026-06-07)
Convert HPFM/HPN booking to v2 with center-scoped offering order on `/book/v2`.
- [x] `landingOfferingsFor(brand, center)` in `activities-catalog.ts` — Naples scopes to ONLY
      Naples-available offerings (drops FT-only race/duckpin/shuffly); Fort Myers/unknown shows all;
      within scope the VISITOR'S brand propagates first (FastTrax-first on FT, HP-first on HP;
      shuffly's "auto" brand resolves to the entry brand). + 5 unit tests (26/26 catalog tests pass).
- [x] `?location=` → `session.center`: `EntryContext.center` + parsed in `parse-entry-context.ts`
      (was an unused gap — `setCenter` was never dispatched in v2, so center was always null/FM).
      `BookingFlow` seeds `setCenter` on a fresh session → Naples books with the Naples clientKey.
- [x] `/book/v2` page resolves center from `?location` + passes ordered offerings + center to PromoLanding.
- [x] `PromoLanding` tile links carry `?location` so the picked activity seeds the right center.
- Entry: Naples hero CTA (`/hp/book?location=naples`) → Phase-A redirect → `/book/v2?location=naples` → scopes. ✓
- ⚠️ Minor pre-existing gaps (not blocking): HP nav "Book Now" goes bowling-direct (not the grid) and
      one `/naples` laser-tag link lacks `?location` → defaults to FM center. Polish later if wanted.

## Group-Function: re-price after paid-in-full (IMPLEMENTED — 2026-06-06)
- **Plan + impl log:** [group-function-paid-in-full-reprice.md](group-function-paid-in-full-reprice.md)
- **Problem:** A BMI edit on a *paid-in-full* event recomputed balance as `total − deposit_due`, ignoring the balance already collected → re-sign re-charged it → **overcharge**. No path to charge just the delta. Also: paid Square balance links were never reconciled.
- **Scope (Eric):** Only paid-in-full events. Resign required regardless. Increase → charge difference + load gift cards (card on file, or capture a card on re-sign). Decrease → flag staff, no auto-refund. Deposit-phase flows untouched.
- **Status:** PR-1 + PR-2 implemented on branch `feat/gf-balance-link-reconcile`; typecheck/lint/prettier clean. **Not committed; not live-smoke-tested.** Verify §6 before go-live.

## PR-B5: Bowling + KBF into Unified BookingFlow (IN PROGRESS — 2026-06-02)
- **Branch:** `feat/booking-b2-race` · merged with main 2026-06-02
- **What shipped (all build-verified):**
  - D1: Type extensions — BowlingItem/KbfItem with 30+ fields, LoyaltyState on BookingSession, 5 new reducer actions
  - D2: Bowling service — `service/bowling.ts` (hold/confirm/cancel/reserve) wired into `getService()`
  - D3: 7 bowling step components — Players, Slots, Tier, Offer (QAMF hold), Shoes, Attractions (info-only), Food
  - D4: 2 KBF steps — KbfIdentity (lookup→OTP→verify), KbfBowlers (family member selection)
  - D5: Hold timer generalized — ReservationTimer handles BMI + QAMF with 8-min auto-extend
  - D6: Checkout bowling path → `bowlingReserve()` → `/api/bowling/v2/reserve`
  - D6b: Shared HeadPinz Loyalty — LoyaltySection at checkout for ALL HeadPinz bookings (earning + redeeming)
  - D7: Step registry — all bowling/kbf placeholders replaced with real components
  - D8: Deposit unification — bowling reserve uses `createDepositAndCharge()`, same as race/attraction
  - D9: DiscountCodeInput on bowling slots step
  - D10 (2026-06-02): BowlingSlotsStep → HP_LOCATIONS for real center hours
  - D11 (2026-06-02): BowlingOfferStep — duration picker for hourly, line-item enrichment (label/price/catalog/deposit%), per-lane vs per-person multipliers, product overrides
  - D12 (2026-06-02): Checkout quote fetch from `/api/square/bowling-orders/quote` + real line-item display (product names, per-line amounts, booking fee, tax, deposit breakdown)
  - D13 (2026-06-02): BowlingShoesStep stores shoe product metadata for checkout name resolution
  - D14 (2026-06-02): BowlingAttractionsStep → info-only (attractions are separate cart items, same as racing)
  - D15 (2026-06-02): Loyalty params wired to BMI reserve path (loyaltyAccountId, rewardTierId, rewardDiscountCents)
  - D16 (2026-06-02): Mixed-cart guard — **NEVER LANDED / entry is stale** (verified 2026-06-10: `addItem` allows mixed carts — `machine.test.ts:62` asserts it; `buildCombinedLineItems` merges race+bowling+attraction into one Square order). Kept that way DELIBERATELY: combo specials ([combo-specials-plan.md](combo-specials-plan.md)) require race+bowling in one session. Do NOT re-add a guard.
- **Still needs before go-live:**
  - Smoke test with QAMF staging + Square sandbox
  - Full Square Loyalty API reward creation in BMI reserve route (currently applies discount only; bowling route has full implementation)

## v2 Checkout: Server-side atomic BMI payment/confirm
- **Priority:** Medium (v2 checkout milestone)
- **Context:** v1 confirms BMI payment client-side on the confirmation page after Square charges. PR #13 (2026-06-02) added retry + error UI as an immediate fix, but the architecture still has a gap if the browser closes between Square charge and confirmation page load.
- **v2 fix:** Add `confirmBmi` postPaymentAction to `/api/square/pay` so Square charge + BMI confirm happen atomically server-side. Extract shared `lib/bmi-client.ts` for BMI auth + `confirmPayment()`. Wire into v2 checkout service.
- **See:** [restructure-plan.md § v2 checkout: server-side atomic BMI payment/confirm](restructure-plan.md)

## SEO: HeadPinz metadata on shared /book routes
- **Priority:** High
- **Issue:** `headpinz.com/book/*` pages show FastTrax title/description in Google results because `/book` routes use the root layout metadata (FastTrax-branded), not the `/hp` layout
- **Root cause:** Middleware line 69 excludes `/book` from the `/hp` rewrite, so shared booking pages inherit the root `app/layout.tsx` metadata
- **Fix:** Use `generateMetadata` in `/book` pages that reads the `x-brand` header (set by middleware) to return HeadPinz or FastTrax metadata dynamically
- **Files:** `app/layout.tsx`, `app/book/[attraction]/page.tsx`, `app/book/race/page.tsx`, `middleware.ts`
- **Google result example:** `headpinz.com/book/gel-blaster` shows "Indoor Go-Kart Racing & Entertainment | Fort Myers, FL" and "63000 sq ft of high-performance electric go-kart racing..."

## Daily Events admin (ported from employee portal) — BUILT 2026-07-12, feat/daily-events-admin

Ports portal.headpinz.com/management/operations/daily-events (group event ops board + detail)
into this repo at `/admin/{token}/daily-events` (+ `/admin/embed/daily-events` HMAC embed).
Feature at `src/features/daily-events/` + `src/components/features/daily-events/`; routes at
`app/api/admin/daily-events/{reservations,reservations/[projectId],payments,event-metadata}`.
Owner directive honored: upstream BMI calls are byte-faithful ports of the portal's (only
deviations: parseWithRawIds response parsing per the precision hard rule; resource mappings +
waiver thresholds frozen from a 2026-07-12 portal-DB export into constants.ts; payments read
`group_function_quotes` directly by projectId instead of the portal→website proxy hop).
Dropped per owner: party assignments, PandaDoc (replaced by native ContractSection).
`event_metadata` re-homed to website Neon (portal-verbatim DDL) — run
`scripts/migrate-daily-event-metadata.mjs` once at cutover (PORTAL_DATABASE_URL + DATABASE_URL).

**Remaining before staff cutover:**
- [ ] Owner live pass: page vs portal side-by-side (same date/location), detail modal, print
      outputs, food-out manual save on a REAL event (verifies the BMI private-note sync write —
      left untested on purpose; sync no-op path + Neon cycle verified with a synthetic id).
- [ ] Portal repo (separate PR): add `daily-events` to embed TOOL_PATHS, swap its page for the
      iframe, retire its party-assignment note writer (two writers would alternate the
      "----- Portal Staff -----" section), keep TV dashboard (still reads portal event_metadata).
- [ ] Run the event_metadata backfill at cutover.
- [ ] Env check on Vercel: ANTHROPIC_API_KEY or VERCEL_AI_GATEWAY_KEY must be present for
      food-out AI extraction (graceful "AI extraction failed" fallback otherwise).

**Cleanup candidate discovered:** `lib/bmi-office-actions.ts` `fetchProject`/`fetchPersonsByIds`
parse BMI payloads with plain JSON.parse — latent 17-digit precision hazard for OTHER callers
(this feature deliberately does not reuse them). Fix in its own PR.

## Ultimate Qualifier: same-track gap 60 → 30 (owner 2026-08-04) — DONE, unsmoked

Owner: "Ultimate qualifier booking restriction if on same track can be dropped to 30 minutes.
Both web and kiosk."

The UQ Starter→Intermediate buffer (60 min) budgeted qualifying + POV review + appetizer AND the
walk to the other track. Staying on one track drops the walk, so same-track pairs now need only
30 min. Cross-track stays 60.

- [x] `lib/packages.ts` — `minMinutesAfterEndOf` gains `sameTrackMinutes?`; all 5 UQ variants set
      `{ ref: "starter", minutes: 60, sameTrackMinutes: 30 }`. Mega + both junior variants are
      single-track, so they are effectively 30 flat.
- [x] `packageGapMinutesFor(rule, refTrack, candidateTrack)` added to BOTH conflict modules
      (v1 `lib/heat-conflict.ts`, v2 `src/features/booking/service/conflict.ts` — kept in
      lockstep). Reuses each file's `normalizeTrack`, so "Blue Track" ≡ "Blue"; an empty/unknown
      track on either side counts as a track CHANGE and keeps the stricter 60.
- [x] **Web (v1, `/book/race`)** — `app/book/race/components/PackageHeatPicker.tsx` resolves the
      gap PER CARD from `refPick.trackOption.track` vs `proposal._track`.
- [x] **Kiosk + web v2** — `src/components/.../race/PackageHeatPicker.tsx`: `effectiveGapByRef`
      (Map<ref, minutes>) became `effectiveGapByRefTrack` (Map<`ref|track`, minutes>). The
      late-night dead-end fallback still floors at 30 and now evaluates each proposal against
      its OWN resolved gap.
- [x] Step-banner copy is now dynamic: one number when every track resolves the same, otherwise
      "…30 min … on the same track — 60 min if you switch tracks". Keyed EN+ES as
      `racePackage.gapNote` / `racePackage.gapNoteSplit` (kiosk i18n hard rule).
- [x] `UQ_LONG` marketing copy: "scheduled an hour later" → "scheduled at least half an hour
      later" (the old line is wrong for same-track now).
- [x] No server-side change needed — `assertHeatBookable` enforces tier + restriction rules, NOT
      the package gap. The gap is a picker-side rule in both flows.
- [x] Gates: tsc clean, eslint 0 errors (4 pre-existing warnings), a11y-gate green, 1386 booking
      + kiosk tests pass, `packageGapMinutesFor` unit-tested in `conflict.test.ts`.

**Not done — needs a live pass:**
- [ ] Web `/book/race`: UQ weekday adult, pick a Red Starter → Red Intermediate 30–59 min later
      is now pickable; the same-time Blue Intermediate still reads "Available 60 min after…".
- [ ] Kiosk: same check on the shared picker, plus the Spanish banner (switch locale on the
      Intermediate step) and a single-track variant (Mega Tuesday / junior Blue) showing the
      one-number "30 min" form.
- [ ] Confirm ops actually want 30 min on Mega — that variant is single-track, so it went from a
      hard 60 to a hard 30 with no cross-track escape hatch.

**Pre-existing, NOT fixed here:** the v2 `PackageHeatPicker` is otherwise all hardcoded English
(card status labels, tooltips, roster, banners) despite being a kiosk surface. Only the gap note
is keyed. Worth its own i18n PR.

---

# E-ticket retraction on removal (2026-08-06)

## The bug

A racer taken off a heat kept the e-ticket SMS we had already sent them. Measured
across 8/5–8/6: **29 cron sends named a heat the recipient is now off**, 19
distinct racers. Every one went out BEFORE the heat ran — median ~50 min of lead
time, up to 135 — so there was a real, actionable window and nothing used it.

**Root cause: the SMS is a one-shot snapshot with no retraction path.** The
`/t/{id}` and `/g/{id}` pages already poll session-participants every 20s and
flip to `InvalidCard` (verified — and `InvalidCard` is evaluated before `isPast`
and `checkingIn`, so removal wins the render race). But that only helps a guest
who reopens the link. The text in their pocket stayed wrong.

**Why nothing caught it:** Pandora exposes no removal event. `excludeRemoved`
filters on `F_PAR_STATE = 5`, but that field is NOT in the response body — a
removed racer's record is byte-identical in shape to an active one. Verified
against live payloads. The only way to know is to pull the roster twice and diff.

## What shipped

- **`src/features/racing/eticket/removal-sweep.ts`** — notify index + pure
  `removalVerdict` guard matrix + retraction copy/send.
- **`app/api/cron/eticket-removals/route.ts`** — every 2 min, `*/2 * * * *`.
- **`pre-race-tickets`** — `recordNotified` on both send paths;
  `releaseVacatedHeat` now also `forgetNotified`s the vacated heat.
- **`checkin-alerts`** — `fetchPandoraPidsAnyState` fail-open FIXED (see below).
- Kill switch `ETICKET_REMOVAL_SWEEP` (defaults ON, `!== "false"`).

## A move is not a removal — four guards

Moving a racer A→B removes them from A, and `pre-race-tickets` already owns that
case ("was X -> now Y" + `supersedeMovedTicket`). Double-texting on a move would
be strictly worse than the bug. Guards, in order:

- **G1** racer is ACTIVE on any other heat today
- **G2** old ticket carries `movedTo`
- **G3** participant index repointed at another session
- **G4** 6-minute grace = 3 pre-race ticks, so the move path always wins the race

**G1 had to be widened, and the replay is what caught it.** Built only from
sessions we'd e-ticketed, it missed a racer moved to a not-yet-ticketed heat —
racer 18586763 (bounced across four heats in twelve minutes on 8/6) drew four
retractions. Now computed across the whole day, lazily, only when someone is
about to be retracted, via `prefer=cache` so it is Redis reads not Pandora.

## Fail closed, always

The diff is a POSITIVE signal ("Pandora affirmatively has them at state 5").
Inferring removal from mere ABSENCE is indistinguishable from Pandora blinking,
and would text racers mid-outage that their race had vanished. So: either roster
call non-200, malformed, or flagged `stale` by the proxy's cache-fallback path →
skip the whole session. Empty all-state roster → skip. Heat already ran
(`actualStart`/`actualEnd`) → skip; beyond retracting.

Same reasoning fixed `fetchPandoraPidsAnyState`, which returned `new Set()` on a
non-200 — making `!allPandoraPids.has(pid)` pass for EVERY express holder, so the
one existing removal check silently inverted itself exactly when Pandora was
unhealthy. Now returns null and the caller drops the express path for that tick.

## Verification

- 19 unit tests on the guard matrix (incl. move-vs-grace ordering, GSM-7 body).
- Full suite: 256 files / 3563 tests green. tsc + eslint clean.
- **Live replay of 8/6** (`scripts/eticket-removal-replay.mts`, untracked local probe): 33 removals →
  **28 suppressed as moves, 5 genuine scratches retracted**, one text each.

## Known limits

- A racer scratched from one heat while still active on another gets NO
  retraction (G1 is blunt and suppresses it). False negative, chosen
  deliberately: a wrong retraction is far worse than a missed one. `participantId`
  could distinguish move-vs-second-booking precisely if this ever matters.
- Only pre-race notifications are swept. Check-in alerts fire when the heat is
  already being called, so the retraction window is ~0 and the heat-ran guard
  would exclude them anyway.
- **Not yet smoked against a live scratch.** The notify index only populates
  once `pre-race-tickets` runs with this code deployed.
- BMI precision is NOT a concern on this path (checked, not assumed): Pandora
  returns `personId` as a QUOTED STRING — `"personId":"63000000007188906"` —
  so `JSON.parse` round-trips 17-digit ids bit-exact and `typeof` is `string`.
  The proxy, the crons and this sweep never coerce them.
