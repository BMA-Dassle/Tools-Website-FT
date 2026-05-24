# What FastTrax Listens To on the Viewpoint Feed

Heads-up for the VT3 / Viewpoint dev team — these are the endpoints,
events, and fields our production integration depends on. Please give
us a heads-up before changing any of them.

Site: **FastTrax (site `992`)** on `sys.vt3.io`.

---

## Endpoints we hit

| Method | Path                      | Purpose                                                                 |
| ------ | ------------------------- | ----------------------------------------------------------------------- |
| POST   | `/auth/local`             | Service-account login → JWT (7d).                                       |
| GET    | `/videos/events` (SSE)    | **Primary** — always-on stream of video lifecycle events.               |
| POST   | `/sse/{sessionId}/ack`    | One-time session ACK on connect.                                        |
| POST   | `/videos`                 | Backstop poll, body `{_start, _limit, _sort:"id:desc", site_in:[992]}`. |
| POST   | `/reporting/video-report` | Occasional health / breakage report.                                    |

---

## SSE events we consume

| `event:`    | Payload                                                                                | What we do                    |
| ----------- | -------------------------------------------------------------------------------------- | ----------------------------- |
| `connected` | bare UUID string (session id)                                                          | Capture, send ACK, ignore.    |
| `message`   | JSON video record. Inner `data.eventType` is `"video-updated"` or `"sample-uploaded"`. | Match + ready-check pipeline. |

---

## Fields we depend on per video record

### Identity / routing

- `id` — cursor for the polling backstop
- `code` — 10-char share code (drives `vt3.io/?code={code}`)
- `site.id` — we filter to `992`
- `camera` — primary key for matching to the NFC-tagged racer
- `system.name` — kart number, legacy fallback for matching
- `created_at` — used to look up which racer was on that camera at capture time

### Readiness — the single gate

- **`sampleUploadTime`** (ISO or `null`). **Non-null = we send the racer's SMS.** This is the most load-bearing field in the integration.
- `status` — used only as a display label in our admin UI. Statuses seen: `TRANSFERRED → FOR_SAMPLING → SAMPLING → FOR_ENCODING → IS_ENCODING → PENDING_ACTIVATION → ACTIVE / READY`.
- `uploadTime` — shown in admin UI.

### Impressions (for "viewed" chip)

- `hasVideoPageImpression`
- `hasMediaCentreImpression`
- `firstImpressionAt`, `lastImpressionAt`

### Purchase (for "purchased" chip)

- **`unlockTime`** — non-null = purchased.
- `purchaseType` — `STRIPE` / `STRIPE_TERMINAL` / `VENUE` / `UNLOCK_CODE` / `MANUAL` / `API`.

### Misc

- `thumbnailUrl`, `duration`, `disabled`

---

## Contact

Eric Osborn — eric@headpinz.com
