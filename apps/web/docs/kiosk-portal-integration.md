# Kiosk Bookings — Team-Member Portal Integration

Audience: the team-member **PORTAL** app (Vercel project `tools-team-member-portal`),
which embeds the FastTrax reservation-admin board. This doc describes how kiosk
bookings surface in that board and what the portal embed needs to do — nothing
here requires portal-side data access; kiosk bookings arrive through the same
board API and reservation shape the portal already renders.

## 1. What "kiosk" means

A kiosk booking is a self-service booking placed at an in-center kiosk terminal
that runs the normal booking-flow (`unifiedReserve`) — same code path as
headpinz.com web bookings, but the session is flagged as a kiosk session
(`session.context.kiosk`). Product kinds are the full booking-flow set:
`race`, `bowling` (open/KBF), and `attraction`.

Because it flows through `unifiedReserve`, a true kiosk booking is a fully-formed
reservation: it has a real BMI bill / short code, deposit + total, guest contact,
line items, etc. — identical to a web booking except for its origin label.

## 2. Where it is stored

Neon table `bowling_reservations`, column `booking_source`:

- Column: `apps/web/lib/bowling-db.ts:333`
  ```
  ADD COLUMN IF NOT EXISTS booking_source TEXT NOT NULL DEFAULT 'web'
  ```
- Type (`apps/web/lib/bowling-db.ts:651`):
  ```ts
  bookingSource?: "web" | "kiosk" | "conqueror" | "admin";
  ```
- Mapped to the client at `apps/web/lib/bowling-db.ts:876`
  (`bookingSource: (row.booking_source ...) ?? "web"`).

The value is stamped at capture in the unified reserve path:
`apps/web/src/features/booking/service/unified-reserve.ts:1613` (and :1280)
— `bookingSource: session.context?.kiosk ? "kiosk" : "web"`.

Origin legend (per the type doc comment at `bowling-db.ts:650`):

| Value       | Origin                                  |
| ----------- | --------------------------------------- |
| `web`       | headpinz.com (default)                  |
| `kiosk`     | in-center kiosk terminal (booking-flow) |
| `conqueror` | Conqueror / QAMF staff POS              |
| `admin`     | staff KBF admin                         |

## 3. How the board delivers it

The board reads `GET /api/admin/bowling/reservations`
(`apps/web/app/api/admin/bowling/reservations/route.ts:74-82`,
`listBowlingReservations`). Each reservation object carries `bookingSource`
through the reservations-admin reservation type, so no extra fetch is needed —
the embed already receives it.

Query params the route accepts today:

- `date` — required, `YYYY-MM-DD`.
- `center` — Square location ID / center slug (aliased in-route; see
  `route.ts:74-79`).
- `kind` — comma-separated `ReservationProductKind` filter (e.g. `race,bowling`).

## 4. Displaying the kiosk badge

The source badge already exists in the board's design system —
`apps/web/src/features/reservations-admin/constants.ts:59-71`:

```ts
SOURCE_LABELS.kiosk = "Kiosk";
SOURCE_COLORS.kiosk = "#f59e0b"; // amber
```

If the portal renders its own row chrome instead of the board's, reuse these two
maps (label + amber color) so the badge matches. Do not hardcode a different
label/color — keep one source of truth.

## 5. CAVEAT — the "kiosk" naming collision (read this)

`booking_source = 'kiosk'` is written by **two unrelated paths**, and they mean
different things:

1. **True booking-flow kiosk** (this doc's subject) — written by `unifiedReserve`
   at `unified-reserve.ts:1613`. Full reservation: real BMI bill / short code,
   deposit + total, line items, guest contact.

2. **QAMF lane-side walk-in** — written by the QAMF bowling webhook at
   `apps/web/app/api/webhooks/qamf-bowling/route.ts:297`:
   ```ts
   const bookingSource: "kiosk" | "conqueror" = qamfId.startsWith("K") ? "kiosk" : "conqueror";
   ```
   These are walk-ins created directly at the lane in QAMF. The webhook labels
   them `kiosk` purely because the QAMF reservation id starts with `"K"`. They
   are **not** booking-flow kiosk bookings. Such rows are inserted with
   `depositCents: 0`, `totalCents: 0`, **no line items** (`[]` — "POS handles
   pricing"), and `productKind: "open"`.

### How to tell them apart

A true booking-flow kiosk booking has the artifacts a walk-in never gets:

- a **short code** (`shortCode`) and/or a real **BMI bill** reference;
- a non-zero **deposit / total** (`depositCents` / `totalCents` > 0);
- **line items** attached.

A QAMF walk-in has a `qamfReservationId` starting with `"K"`, zero deposit/total,
and no line items. Practical rule for the embed: treat a `kiosk`-sourced row as a
true kiosk booking only when it has a short code (or non-zero total); otherwise
it is a QAMF `K`-prefixed walk-in. Do not rely on `booking_source` alone to mean
"came through our booking flow."

## 6. The new "Kiosk" board filter

A sibling change adds a **Kiosk** filter to the board (filters on
`bookingSource === "kiosk"`). For the portal embed:

- If the embed uses the board's own filter UI, no change is needed — selecting
  **Kiosk** filters client-side on the reservation list the embed already holds.
- If the embed drives the board via URL / props, pass the same source filter the
  board exposes for its embed (mirror whatever `source`/filter param the sibling
  change wires up — confirm the exact param name against the board's embed props
  before shipping; it is client-side filtering, not a new API param).

Note: the `/api/admin/bowling/reservations` route does **not** filter by
`booking_source` server-side today (only `date` / `center` / `kind`). The Kiosk
filter is a client-side filter over the already-fetched list. If the portal wants
kiosk-only rows without the board UI, filter the returned reservations on
`bookingSource === "kiosk"` yourself, applying the §5 walk-in disambiguation.

## 7. Summary for the portal team

- Read `bookingSource` off each reservation — it is already on the object.
- Show the amber **Kiosk** badge using `SOURCE_LABELS`/`SOURCE_COLORS`.
- Disambiguate: `kiosk` + short code / non-zero total = real kiosk booking;
  `kiosk` + `K`-prefixed QAMF id + zero total + no line items = lane walk-in.
- Use the board's Kiosk filter (client-side) rather than a new API param.
