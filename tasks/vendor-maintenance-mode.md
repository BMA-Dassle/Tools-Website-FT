# Vendor maintenance mode (BMI booking-API outage, 2026-08-03)

## Incident scope — as finally established with the owner

The scope moved several times while this was being built. Final, verified state:

**DOWN — BMI Public Booking API** (`api.bmileisure.com/public-booking`), the
*selling* rail: `availability`, `booking/book`, `booking/sell`, `payment/confirm`.

**UP:**

| Vendor | Host | Evidence |
| --- | --- | --- |
| BMI **Office** | `office-api22.sms-timing.com` | owner: "they said check is working" |
| Pandora | `bma-pandora-api.azurewebsites.net` | owner: "i lied pandora is good" |
| QAMF (Conqueror) | bowling, duckpin 11542, KBF | owner: "bowling, duck… working" |
| Intercard | Game Zone TPI bridge | owner: "…and game zone" |

So exactly one rail is dark, and the product line on it goes off sale:
racing, laser tag, gel blasters, Shuffle Showdown, race packs, the Ultimate
Qualifier, and the Ultimate VIP combo (its race legs are BMI).

### Explicitly OUT of scope

- **Check-in and e-tickets** — owner: *"dont do anything with eticket or check in.
  its working."* They ride BMI Office. They are **not classified** in the vendor
  map at all, so this feature cannot reach them (an unclassified id fails open).
  A test pins that. Do not "complete" the map by adding them.
- **Group-event contracts** — I did not block these, against the initial ask, and
  said so. Verified: viewing, signing and paying a balance are Neon + Square +
  Vercel Blob; the only BMI touch is the planner-notes panel, which already falls
  back to the DB (`quote.notes || eventDetails?.notes`); the phone and waiver
  pushes go to Pandora. Blocking `/contract/*` would have stopped us collecting
  group balances we can still collect. Attributed to `pandora` in the registry so
  a real Pandora outage covers them automatically.
- **Waivers** — asked for, then superseded. Signing is Pandora (up); the
  reservation/account lookup both flows start with is Office (up). So waivers
  **work today**. The guard is wired and tested but inert — see "armed" below.

## Design

One registry at `apps/web/src/features/maintenance/`, keyed by **vendor** — the
axis outages actually travel along (owner: "maybe it's by vendor in future").

- `vendors.ts` — product id → the vendors it needs; off sale if **any** is down.
  `race-bowl` = `["bmi","qamf"]` (owner: "vip depends on both"). `duck-pin`
  resolves through the same `fasttraxQamfDuckpinEnabled()` kill switch the
  booking flow reads, so reverting duckpin to its legacy BMI page also moves it
  back under a BMI outage instead of silently staying open.
- `outages.ts` — declared incidents + guest copy (web EN; kiosk EN **and** ES).
  Declared = active; cleared per-vendor by env var.
- `index.ts` — the public API every surface reads.

**"BMI" is deliberately two vendors** (`bmi`, `bmi-office`). That split is what
let this outage be scoped correctly: same brand, different hosts, different blast
radius, and on 2026-08-03 one was down while the other was fine. Lumping them
would have taken down check-in and waivers for no reason.

Product ids are the same vocabulary the kiosk availability payload and the
activities catalog already use, so no surface needs a translation table.

## Surfaces

| Surface | Mechanism |
| --- | --- |
| Web, every booking entry | `middleware.ts` gate → 307 to `/service-notice?a=<product>`. One gate covers v1 + v2 routes, `/hp/*` variants, marketing "Book Now", and emailed/QR/bookmarked deep links. Runs **before** the V1→V2 cutover so a paused v1 URL never bounces through a v2 flow it can't finish. |
| Web, notice page | `app/service-notice/page.tsx` — names the activity, says the front desk can't book it either, links what IS still bookable (derived from the registry, so it can't advertise something also down). `noindex`. Redirects to `/book/v2` when no outage is active. |
| Web, `/book/v2` landing | Amber banner + locked cards. `CardShell` renders an inert `div`, not a dead-styled link — so it doesn't navigate on Enter and isn't crawled. |
| Kiosk tiles | `/api/kiosk/availability` returns `paused: string[]` beside `items`; tiles lock with `categories.disabled.vendorOutage` (EN+ES). |
| Kiosk Experiences | VIP combo, Ultimate Qualifier and Race Packs lock; the Experiences **category card** locks when everything behind it is out. |
| Money | `app/api/bmi/route.ts` refuses `booking/book` + `booking/sell` with 503. |
| Armed, inert | `/kiosk/waiver` + the chooser's waiver door read `isProductPaused("waiver")` → `bmi-office`, which is up. One env var arms them. |

### Deliberate non-blocks

- `payment/confirm`, `booking/removeItem`, `booking/memo`, `bill` DELETE and every
  GET stay open. Blocking `payment/confirm` mid-flow is how you orphan a charge;
  blocking teardown strands holds on heats. GETs feed admin, ops scripts, and the
  probes that tell us BMI is back.
- Any path containing `/confirmation` or `/checkin` — a guest who already paid
  keeps their receipt and their texted lane-ready link.
- `/book/v2` itself — the landing shows locked tiles, more useful than a wall.
- `/waiver-3`, the static legal page. A bare `startsWith("/waiver")` would have
  taken it down; the match is exact-or-trailing-slash.

### Two different sentences

"Nothing left to book today — the front desk can help with walk-ins" and
"Temporarily unavailable — one of our vendors is having a system issue. Please see
Guest Services" are not interchangeable. The first sends a guest to a desk that
can help. During a vendor outage that desk is on the same vendor, so the outage
copy sends them to Guest Services instead.

### Performance side effect (not cosmetic)

Paused products are **not probed**. A dead vendor answers in timeouts, which was
burning the kiosk availability compute's 60s budget and taking the *working*
bowling/KBF availability lines down with it.

## Operating it — ONE variable

```
MAINTENANCE_VENDORS_DOWN = bmi
```

That is the entire control surface. It lists the vendors that are **down**:

| Value | Meaning |
| --- | --- |
| *(unset / empty)* | Nothing down — everything sells |
| `bmi` | Today's outage: the BMI booking API |
| `bmi,bmi-office` | Both BMI rails down (adds waivers) |
| `qamf` | Bowling / duckpin / KBF down |

Valid names: `bmi`, `bmi-office`, `pandora`, `qamf`, `intercard`. Case, spaces and
underscores-for-hyphens are tolerated (`BMI_OFFICE` works). Runtime, server-only
var — **no redeploy** (deliberately not `NEXT_PUBLIC_*`, which is build-baked).
Web reacts on the next request; kiosk tiles within one availability TTL (≤3 min),
because the paused overlay is applied *after* the cache.

**Why this shape.** The first cut declared outages in CODE and *cleared* them with
per-vendor `MAINTENANCE_VENDOR_<X>="false"` switches — a default-on design that is
safer (a forgotten variable cannot leave us selling something broken) but had two
concepts pointing in opposite directions. Mid-incident the owner could not tell
which variable did what, twice. Reasoning about it at 11pm beat the extra safety:
*"have everything as off by default then tell me what to flip on."*

**The cost, stated plainly.** Activation now fails OPEN: no variable means we keep
selling. A typo means the same. Mitigation is a loud `console.error` naming the bad
token and the valid values, so a mistake is findable in Vercel's runtime logs
instead of silent — and a test pins the fail-open behavior so it stays a known
property rather than a surprise. A misspelled name never breaks the *rest* of the
list; the vendors that parse still go down.

House-rule note: this is not the "opt-in feature gate" the CLAUDE.md flag rule
forbids. The maintenance feature is unconditional code that always ships on; this
variable carries operational INPUT — which vendor is broken today, a fact only a
human knows.

## Verification

- [x] `tsc --noEmit` — clean (4 pre-existing errors in **untracked** one-off
      forensics scripts; not committed, so Vercel never sees them)
- [x] `vitest run` — 211 files / 2934 tests pass; 24 new
- [x] `eslint` on every changed file — 0 errors. 2 warnings, both pre-existing
      and on untouched lines (`Date.now()` in the World Cup block; an already-dead
      `promoDealLine`, confirmed unused on HEAD)
- [x] `npm run build` + a11y gate — passes, `/service-notice` registered
- [x] Check-in / e-ticket files byte-identical to HEAD (`git diff` empty)
- [x] Live smoke on `next dev`:
      - 6 paused entries → 307 `/service-notice?a=<product>` with the right product
      - `/waiver`, `/waiver-3`, `/kiosk/checkin`, `/kiosk/waiver`, bowling, KBF,
        duckpin, `/reload`, `/book/v2` and all 3 confirmation routes → 200
      - `booking/book` + `booking/sell` → 503 `maintenance:true`;
        `payment/confirm` / `removeItem` / `memo` not intercepted
      - `/book/v2`: banner renders, exactly 5 locked cards, all `aria-disabled`,
        **zero** `href`s for paused slugs, bowling/KBF/duckpin still linked

## Still open

- Kiosk not device-smoked on a physical unit (bumped to **v1.13.0** — the footer
  version is how staff confirm a kiosk picked up the bundle).
- `/book/checkout` (v1, reachable mid-flow only) is not gated; the BMI write
  guard covers the money path. Not worth a redirect that could strand a live cart.
- Marketing pages still show racing/laser/gel content and price cards. Their
  "Book Now" buttons all land on the notice, which is correct — but if the outage
  runs long, consider an inline notice on `/racing` and `/attractions`.
- **`MAINTENANCE_VENDORS_DOWN=bmi` MUST be set in Vercel for today's outage to be
  in force.** Since the env-driven refactor, an unset variable means everything
  sells. Verify with `fasttraxent.com/book/race` → it must land on
  `/service-notice`. If it renders the booking wizard, the variable is missing or
  misspelled (check the runtime logs for the `[maintenance]` line).
