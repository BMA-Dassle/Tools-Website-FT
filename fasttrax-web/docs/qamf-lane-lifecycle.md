# QAMF Internal API — Reservation & Lane Lifecycle

Tested 2026-05-09 against center 9172 (HeadPinz Fort Myers) using the
Internal API at `https://api.qubicaamf.com/bowling-reservations`.

Auth: OAuth2 `client_credentials`, scope `bowling_reservations`, per-center token.

## Two Service Types

| Service | Use case | ExpiresAt while Temporary | Availability search |
|---------|----------|--------------------------|---------------------|
| `BookForLater` | Advance reservation | Yes (10-min hold) | Works via `POST /availability/search` |
| `PlayNow` | Walk-in / bowl now | No (`null`) | Returns 404 — just create directly |

Both use the same `POST /centers/{centerId}/reservations` endpoint.
Only difference is `WebOffer.Services: ["BookForLater"]` vs `["PlayNow"]`.
All subsequent lifecycle steps are identical.

## State Machine

### Reservation Status (via `PATCH /centers/{centerId}/reservations/{id}/status`)

```
Temporary → Confirmed ↔ Arrived
```

- `Completed` is **not settable via API** (400) — POS only.
- Confirming clears `ExpiresAt` (no more hold timer).
- Setting Arrived does **not** change lane status.

Allowed values: `Temporary`, `Confirmed`, `Arrived`, `Completed` (read-only).

### Lane Status (via `PATCH /centers/{centerId}/reservations/{id}/lanes/{laneGuid}/status`)

```
Temporary → Confirmed ↔ Ready ↔ Running
```

- `Completed` is **not settable via API** (400) — POS only.
- Failed Completed PATCH reverts lane back to `Ready`.
- Lane GUID is in `Lanes[].Id` (not the lane number).

Allowed values: `None`, `Canceled`, `Temporary`, `Confirmed`, `Ready`, `Running`, `Completed` (read-only).

## Full Lifecycle (tested both PlayNow and BookForLater — identical)

| Step | Endpoint | Body | Res Status | Lane Status | HTTP |
|------|----------|------|-----------|-------------|------|
| 1 | `POST /reservations` | `{ Services: [...] }` | Temporary | Temporary | 201 |
| 2 | `PATCH /reservations/{id}/status` | `{ Status: "Confirmed" }` | **Confirmed** | Confirmed | 200 |
| 3 | `PATCH /reservations/{id}/status` | `{ Status: "Arrived" }` | **Arrived** | Confirmed | 200 |
| 4 | `PATCH /reservations/{id}/lanes/{guid}/status` | `{ Status: "Ready" }` | Arrived | **Ready** | 200 |
| 5 | `PATCH /reservations/{id}/lanes/{guid}/status` | `{ Status: "Running" }` | Arrived | **Running** | 200 |
| 6 | `PATCH /reservations/{id}/lanes/{guid}/status` | `{ Status: "Completed" }` | — | reverts to Ready | **400** |
| 7 | `PATCH /reservations/{id}/status` | `{ Status: "Completed" }` | — | — | **400** |

## How to Open a Lane (Self-Service Check-In)

The full API-driven flow to open a lane without staff intervention:

```
1. PATCH /reservations/{id}/status         → { Status: "Arrived" }
2. PATCH /reservations/{id}/lanes/{guid}/status → { Status: "Ready" }
3. PATCH /reservations/{id}/lanes/{guid}/status → { Status: "Running" }
```

**Order matters.** Arrived must be set before lane Ready — setting Ready before
Arrived can cause the lane to revert to Confirmed.

Lane GUID comes from `GET /reservations/{id}` → `Lanes[0].Id`.

## Important Notes

- `BookedAt` must have seconds = `:00` or QAMF returns 400.
- Lane numbers are in `Lanes[].LaneNumber`; the PATCH URL uses `Lanes[].Id` (a GUID).
- Reservation status stays `Arrived` even after lane goes `Running` — it does not auto-advance.
- Multi-lane reservations: each lane has its own GUID and must be patched individually.
- `Completed` status on both reservation and lane is set exclusively by the POS/Conqueror system.
