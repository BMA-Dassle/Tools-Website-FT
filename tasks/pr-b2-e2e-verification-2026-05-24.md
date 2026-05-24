# PR-B2 End-to-End Verification — 2026-05-24

**Dev server:** `http://localhost:3000` (running in background, process `bosebbsti`)
**Branch:** `feat/booking-b2-race` @ `e2d5c37e`
**Target URL:** `http://localhost:3000/book/race/v2`
**Brand cookie:** `?brand=fasttrax` (or set via the brand switcher)

Mark each row with ✅ / ⚠️ (works with caveats) / ❌. Note bugs inline.

---

## Test paths

### A1 — New racer single-heat happy path

**Steps:**
1. Open `/book/race/v2`
2. Party: add 1 adult, mark new racer
3. Date: pick a non-Tuesday weekday with availability
4. Adult Race: pick "Starter Race Red" or "Starter Race Blue" (Mon-Thu schedule)
5. Adult Heats: pick one heat ≥ 75 min in the future
6. POV & Pack: either rookie pack (if env flag on) OR add a POV camera
7. Extras: skip
8. Checkout: enter contact info → BMI book heats → review → pay with Square sandbox card (4111 1111 1111 1111, any future exp, any CVC, any ZIP)
9. Wait for redirect to `/book/confirmation`

**Expect:**
- BMI bill created (visible in confirmation page reservation number)
- Heat booked at chosen time
- License auto-sold for new racer ($4.99 line)
- Square sandbox shows payment
- Confirmation page renders with QR per racer + heat schedule
- SMS + email received (if `SMS_TO_TEST` / `EMAIL_TO_TEST` env are set)

**Result:** ☐ Status: ____  Notes: ____

---

### A2 — Returning racer BMI verification

**Steps:**
1. Open `/book/race/v2`
2. Party: add 1 adult, click ExperiencePicker "Returning"
3. ReturningRacerLookup: enter phone OR email of a known BMI-office racer
4. Receive OTP via SMS → enter it
5. Select linked account from the list
6. Continue through date → product → heats → checkout

**Expect:**
- ReturningRacerLookup fetches accounts via `/api/bmi-office?action=search`
- OTP fires via `/api/sms-verify`
- Selecting an account populates `bmiPersonId` on the party member
- Verified racer's tier/waiver/credit badges appear in RacePartyStep
- 75-min lead-time cutoff does NOT apply (returning racer, presumed waiver valid)
- Express Lane badge appears if waiver is valid

**Result:** ☐ Status: ____  Notes: ____

---

### A3 — Mixed adult + junior new racers

**Steps:**
1. Party: add 1 adult new + 1 junior new
2. Date: avoid Tuesday (Mega blocks new juniors)
3. Adult Race: pick a Starter (Red/Blue)
4. Adult Heats: pick 1
5. Junior Race: pick Junior Starter Blue
6. Junior Heats: pick 1 (cross-racer conflict check: different racer can race same time)
7. POV / Extras / Checkout

**Expect:**
- 2 BMI lines on the combined bill (one per racer × heat)
- 2 license sales auto-added (one per new racer)
- Each line carries the correct `bmiPersonId` (null for new racers — BMI creates them at book time)

**Result:** ☐ Status: ____  Notes: ____

---

### A4 — Multi-heat 3-Pack (track-locked)

**Steps:**
1. Party: 1 adult new (Starter only) won't see 3-Pack. Use 1 adult **returning** (BMI-verified per A2)
2. Date: any weekday
3. Adult Race: pick "Intermediate Weekday 3-Pack" → TrackPickerModal opens → pick Blue
4. Adult Heats: only Blue heats appear (locked-track filter). Pick 3 heats respecting conflict rules (Blue ≥16 min apart)
5. POV / Extras / Checkout

**Expect:**
- TrackPickerModal renders Blue + Red cards with track images + stats + taglines
- After picking Blue: heats grid shows only Blue (no Red rendered)
- 3 heats chain on one BMI orderId (visible in BMI bill if you inspect)
- Conflict rule enforces ≥16-min Blue gap

**Result:** ☐ Status: ____  Notes: ____

---

### A5 — Premium Package

**Steps:**
1. Party: 1 adult returning
2. Date: weekday with package availability
3. Adult Race: scroll above single-race grid → pick a Premium Package card (amber tinted)
4. PackageHeatPicker: walks per-component (e.g. Starter → Intermediate). Per-component gap rules enforced
5. Checkout

**Expect:**
- PackageCard shows live BMI pricing + "you save $X" line
- PackageHeatPicker auto-advances to the next component after picking
- Each component's heat books against its component productId
- Bundled price applied at checkout

**Result:** ☐ Status: ____  Notes: ____

---

### A6 — Add-ons with race-heat + cross-building conflict

**Steps:**
1. Walk through party → date → race → 1 heat at e.g. 2:00 PM
2. Extras: click "Add for all 2 racers" on Gel Blaster (HP, per-person) — wait for slot list
3. Pick a slot that does NOT overlap with 2:00 PM ± 30 min
4. Add Shuffly (FT, per-group) — slot list loads
5. Try picking a Shuffly slot back-to-back with the Gel Blaster slot (different building = 30-min buffer required) — expect greyed
6. Pick non-conflicting slots → checkout

**Expect:**
- Race heat appears as 🏎️ pill in the slot picker
- 30-min buffer around race heat enforced (slots overlapping that window are greyed)
- Same-building add-on conflicts: 0 buffer (back-to-back OK)
- Cross-building add-on conflicts: 30 min buffer
- Each add-on sells via BMI `booking/sell` (one line per add-on entry)

**Result:** ☐ Status: ____  Notes: ____

---

### A7 — Discount code

**Steps:**
1. Open `/admin/[token]/discount-codes` and find an active race-scoped code (or use `RACEAPP` if scoped)
2. Visit `/book/v2?code=<that_code>` → tile highlighted on landing
3. Click race tile → land on `/book/race/v2?code=<that_code>` (promo captured in session)
4. Walk through party → date → race → heats → checkout
5. Inspect the Square order line items — discount should be applied

**Expect:**
- Landing page shows the code chip
- Session captures `appliedPromo` (visible by inspecting React DevTools if needed)
- Checkout passes the promo to Square; Square Order has `applied_discounts` array referencing the catalog discount id

**Result:** ☐ Status: ____  Notes: ____

---

### A8 — HeightAgeConfirmModal intercept

**Steps:**
1. Party: 1 adult new
2. Click Next to leave party step
3. Modal appears: "Confirm Your Party" — height/age disclaimers
4. Try clicking "Confirm & Pick a Date" without checking boxes — expect blocked
5. Check all boxes → click confirm → land on date step

**Expect:**
- Modal renders dynamic disclaimers from party composition (adult count, junior count)
- All checkboxes required before submission
- Modal does NOT appear for returning racers (waiver on file)

**Result:** ☐ Status: ____  Notes: ____

---

### A9 — Private event date blocker

**Steps:**
1. Open `apps/web/lib/group-events.ts` — find an `eventDate` value in `GROUP_EVENTS`
2. Walk to date step, navigate calendar to that month
3. Hover over the date — tooltip: `Private Event: <company name>`
4. Try clicking — disabled

**Expect:**
- Cell renders amber tint (`bg-amber-500/15`)
- Click blocked
- Tooltip shows company name

**Result:** ☐ Status: ____  Notes: ____

---

### A10 — Mega Tuesday + new juniors banner

**Steps:**
1. Party: 1 junior new racer
2. Date: pick any Tuesday (purple cell — Mega Track)
3. Expect: amber banner below calendar — "Heads up — Mega Tuesday" + "Pick a different date" CTA
4. Try clicking Next → disabled with hover tooltip "First-time juniors can't race on Mega Tuesdays."
5. Click "Pick a different date" → date clears

**Expect:**
- Banner copy matches v1 verbatim
- Next button disabled while date+junior conflict exists
- Banner CTA clears the date

**Result:** ☐ Status: ____  Notes: ____

---

### A11 — Reservation timer

**Steps:**
1. Walk to heat step → pick a heat (this creates the BMI bill)
2. Look at the sticky step bar — Ticketmaster-style countdown pill should appear (starts at 10:00)
3. Wait ~30 seconds → confirm it counts down
4. Look for a refresh button next to the timer — click it → expect refresh via `/api/sms?endpoint=bill/overview`
5. (Optional) Wait until expiry → confirm session behavior (TBD: does the bill cancel? does the UI reset?)

**Expect:**
- Pill renders at 10:00 and counts down each second
- Refresh fetches updated bill state without losing UI state
- On expiry: behavior TBD — note what happens

**Result:** ☐ Status: ____  Notes: ____

---

### A12 — Error path (BMI booking fails mid-flow)

**Steps:**
1. Walk through to checkout step
2. Open DevTools → Network tab → block `/api/bmi` requests OR disconnect Wi-Fi
3. Click contact form Submit → `runCheckout` will fire BMI book
4. Expect: phase transitions to "error" with retry button

**Expect:**
- Error message shows
- Square is NOT charged (payment never started — booking failed first)
- "Retry" button re-invokes `runCheckout`
- After re-connecting + clicking retry → flow proceeds normally

**Result:** ☐ Status: ____  Notes: ____

---

## Side-effect verification (after a successful e2e booking)

For one of the successful A-paths above, confirm these side effects:

- ☐ **Square sandbox** — charge appears at https://squareupsandbox.com with correct amount + line items
- ☐ **BMI bill** — reservation number visible on confirmation page; if you have BMI office access, lines should be visible
- ☐ **sales_log** — row appears at `/admin/{token}/sales` within ~1 min of confirmation. Fields populated: `bookingType="racing"`, `participantCount`, `isNewRacer`, `rookiePack`, `licensePurchased`, `expressLane`
- ☐ **clickwrap_acceptances** — row written (check via `/admin/{token}/clickwrap` if that admin page exists, or query Neon directly)
- ☐ **SMS confirmation** — customer phone receives confirmation
- ☐ **Email confirmation** — customer email receives confirmation
- ☐ **Confirmation page** — renders QR per racer + reservation number + (if Rookie Pack) RACEAPP appetizer code

## Build / typecheck / test

- ☐ `npx turbo run typecheck test --filter=fasttrax-web` → expect 313/313 passing (currently green)
- ☐ `npx turbo run build --filter=fasttrax-web` → expect clean build

---

## Summary

**Total paths:** 12
**Passing:** ____
**Failing:** ____
**Blockers (must fix before merge):** ____

**Decision:** ☐ Ready to flip Draft → Ready  ☐ Fix specific bugs first (list below)

### Bugs found
_(fill in as you walk)_

| # | Path | Severity | Description | File:line if known |
|---|---|---|---|---|
| | | | | |
