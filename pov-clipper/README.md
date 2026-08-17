# pov-clipper

Cuts a racer's **actual fastest lap** out of their Viewpoint (VT3) video and uploads it to Vercel
Blob for the check-in wall's highlight reel. Third Railway service alongside `kart-timing-bridge`
and `vt3-bridge`, and deployed the same way (Dockerfile + `railway.json`).

## Why this is not a Vercel function

- **ffmpeg + tesseract are ~120MB of apk packages.** Bundled into the Next app they would sit on the
  deploy path of the booking flow, the kiosk and every TV feed — to serve one job a day.
- **Vercel caps a function at 300s.** Ten clips at ~10-20s each plus OCR is uncomfortably close; a
  full rebuild would exceed it.

## How a clip is located

Two facts meet, and both were verified against real footage on 2026-08-17:

1. **`TimingPassingNotification`** gives the UTC instant a racer crossed the line completing their
   best lap, and how long it took. It is the only thing on any of our wires that timestamps a lap.
2. **The camera burns a wall clock into the picture** (`YYYY/MM/DD HH:MM:SS`, bottom-left) and it
   advances 1:1 with playback, so one OCR'd frame fixes the video's start time.

```
videoStart     = burnInAt(t) − t
lapEndOffset   = bestLapAt − videoStart
lapStartOffset = lapEndOffset − bestLapMs
```

Confirmed end-to-end: the timing system said a lap completed at `23:00:02.948` ET; the frame at the
predicted offset (t=443.9s) read `23:00:03`. Two systems sharing no identifier, ~50ms apart.

**VT3 exposes no recording-start field**, which is why the OCR exists. `created_at` was tested as a
substitute across 1,385 videos — interquartile spread **243 seconds**. It cannot anchor anything.

## Two properties worth not breaking

- **The source is never downloaded.** `-ss` goes **before** `-i` so ffmpeg range-seeks; cutting 25s
  out of a 14-minute/800MB video took 10s and fetched tens of megabytes. Reordering those flags
  would decode from the start and pull the whole file.
- **A fastest lap can never be a caution lap**, so yellow flags exclude themselves. There is no
  yellow-flag filter anywhere in this pipeline and there should not be — pixel-motion detection was
  measured against a known yellow-flag clip and scored it at the 69th percentile of its own race.

## API

```
GET  /health   → { ok, running, hasWebhook }
POST /build    → 202 { accepted, skipped }
  header: x-kart-bridge-secret
  body:   { jobs: [{ videoCode, racerName, bestLapAtMs, bestLapMs,
                     sector?: 0|1|2, clipSeconds?, raceDurationS? }] }
```

Returns **202 immediately** — a run takes minutes and the cron must not hold the connection.
Results POST back to `CLIP_RESULT_WEBHOOK` **per clip**, so a run that dies halfway still publishes
what it finished. A second `/build` while one is running gets **409**, not a queue.

`sector` rotates which slice of the lap is taken (0 opening, 1 middle, 2 run to the line) so
consecutive clips in the reel show different corners rather than ten identical run-ups to the line.

`anchor` on each result is `"burn-in"` (exact) or `"estimate"` (OCR failed, fell back to centring
the race in the video). **A wall of `estimate` means OCR is broken** — that fallback was measured
55s wrong on a real video, so it is a floor, not a plan.

## Deploy

1. New Railway service from this repo, root `pov-clipper/`. `watchPatterns` keeps it from
   redeploying on unrelated pushes.
2. Set `KART_BRIDGE_SECRET`, `BLOB_READ_WRITE_TOKEN`, `CLIP_RESULT_WEBHOOK`.
3. `GET /health` should return `{ ok: true }`.

## Costs

One container idling ~23.9h/day for a daily job — around $5/month, and genuinely wasteful. If that
grates, the same image runs as a **Railway cron** instead: scheduled, exits when done, pay for
minutes. The trade is slightly more moving parts.
