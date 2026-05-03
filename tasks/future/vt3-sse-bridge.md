# Future: VT3 → webhook SSE bridge worker

> Buildable plan for Option B from `tasks/future/vercel-workflows-evaluation.md`.
> Tap into VT3's `/videos/events` SSE stream so we can drop the
> 2-min polling cron and notify customers within ~1s of upload
> instead of "up to 2 min after the next cron tick."
>
> Saved 2026-05-03. Not yet built — gated on confirming the SSE
> event schema with a longer HAR + checking with VT3 whether they
> offer webhooks (Option A from the parent doc, which would skip
> this whole worker).

## Architecture

```
sys.vt3.io/videos/events  ──SSE──►  Fly.io worker (always-on)
                          ◄──ack──   │
                                     │ POST + x-secret
                                     ▼
                          Vercel: /api/webhooks/vt3-video-event
                                     │
                                     ▼
                          existing lib/video-match.ts
```

Worker holds the long-lived SSE connection (Vercel serverless can't —
60s function ceiling). Webhook on Vercel runs the existing matching
logic per pushed event.

## Components

### 1. Worker — `vt3-bridge/src/index.ts`

Single TypeScript file, no SSE polyfill. Manual SSE parsing keeps
the dependency tree empty. Auth flow mirrors the existing
`lib/vt3.ts` pattern (POST `/auth/local` → JWT good for 7 days).

Behaviors:

- Login on startup, cache JWT in memory for 6 days, re-login on 401
- Open SSE connection to `https://sys.vt3.io/videos/events` with
  `Authorization: Bearer {jwt}` and `x-cp-ui: mui` / `x-cp-ver`
  headers (matching control panel)
- Parse SSE frames manually (`id:`, `event:`, `data:` lines, `\n\n`
  separator)
- Forward each event payload to `WEBHOOK_URL` with
  `x-vt3-bridge-secret: {WEBHOOK_SECRET}` header
- ACK back to VT3 via `POST /sse/{sessionId}/ack` for each event
  (best-effort, never blocks)
- Reconnect with exponential backoff (1s → 5min cap) on stream
  errors. Force re-login on 401.
- Single retry per webhook delivery on transient failure; persistent
  failures are logged + dropped (cron-backstop catches misses)
- SIGTERM-aware so `fly deploy` rolling restarts cleanly

Code shape: ~150 lines. See the chat history for the full draft —
will move into the repo when we build.

### 2. Dockerfile

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src/ ./src/
RUN npx tsc -p src/
CMD ["node", "dist/index.js"]
```

### 3. fly.toml

```toml
app = "vt3-bridge"
primary_region = "iad"

[build]

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"

[[services]]
  internal_port = 8080
  protocol = "tcp"

  [[services.tcp_checks]]
    interval = "60s"
    timeout = "10s"
    grace_period = "30s"
```

### 4. Webhook on Vercel — `app/api/webhooks/vt3-video-event/route.ts`

Validates `x-vt3-bridge-secret` header against `VT3_BRIDGE_SECRET`
env, then calls `matchVt3Video(payload)` — the per-video version of
the matching logic currently in the cron. Need to extract that
function from `app/api/cron/video-match/route.ts` into
`lib/video-match.ts` so both the cron and the webhook share it.

## Deploy

```bash
cd vt3-bridge
fly auth login
fly launch --no-deploy --copy-config
fly secrets set \
  VT3_USERNAME='...' \
  VT3_PASSWORD='...' \
  WEBHOOK_URL='https://fasttraxent.com/api/webhooks/vt3-video-event' \
  WEBHOOK_SECRET="$(openssl rand -hex 32)"

# Mirror the same WEBHOOK_SECRET into Vercel as VT3_BRIDGE_SECRET
fly deploy
fly logs   # watch the SSE handshake + first events
fly status
```

## Cost

Fly.io free tier covers our use case: 3 × shared-cpu-1x machines
free, 3GB persistent volume, 160GB outbound. We need 1 machine,
~256MB RAM, near-zero outbound (just the webhook posts back to
fasttraxent.com).

| Component | Cost |
|---|---|
| Fly.io shared-cpu-1x always-on | **$0/mo** (free tier) |
| Vercel webhook invocations | ~$0 |
| **Total** | **$0–$2/mo** |

## Reliability strategy

**Keep `/api/cron/video-match` running at slower cadence** during the
rollout window:

- Bridge primary path (sub-second latency)
- Cron at every 15 min instead of 2 min as a backstop
- Compare bridge events vs. cron-detected videos for 2-3 weeks
- Once parity is proven, drop the cron from `vercel.json`

This protects against:
- Fly.io brief outages (machine restarts, region issues)
- VT3 SSE stream gaps if their replay-on-reconnect doesn't cover
  events lost during disconnect
- Bugs in our SSE parser missing event types

## Open items before building

1. **Capture longer HAR (2-3 hours during a busy race window)** so we
   know the actual SSE `data:` schema and event types. The 30s HAR
   we have only showed setup traffic, not real video events.

2. **Confirm with VT3** whether they offer webhook delivery as an
   alternative. If yes, skip this worker entirely — VT3 posts to
   our endpoint directly. (This is Option A from the parent doc and
   the cleanest solution.)

3. **ACK cadence** — control panel HAR showed `POST /sse/{id}/ack`
   but we couldn't tell from 30s of traffic whether ACK is per-event
   or periodic heartbeat. Adjust the worker's ack() call site once
   we see real behavior.

4. **Reconnect / replay** — does VT3 honor `Last-Event-ID` on
   reconnect to replay missed events? If yes, persist the last seen
   event id (Redis from the worker, or a tiny SQLite file on Fly's
   volume) and send it on reconnect. If no, our cron-backstop
   strategy is essential.

5. **JWT refresh under load** — current worker re-logs on 401. If
   the SSE stream itself sends a 401 mid-flight (token expired
   between checks), the reconnect loop handles it. Verify under
   real conditions.

## When this gets built

- After the longer HAR capture confirms the event schema is what
  we expect.
- After VT3 confirms whether they offer webhooks (kills this whole
  plan if yes).
- Likely paired with kicking off `tasks/future/vercel-workflows-evaluation.md`
  per-booking lifecycle workflow, since SSE → webhook → workflow
  hook is the full chain that lets us delete the cron AND replace
  the polling architecture.

## Out of scope (for v1 of the bridge)

- Multiple sites — VT3 might emit events for sites we don't care
  about. Filter at the worker (cheap network) or at the webhook
  (cheap CPU). Either way, drop early.
- HA across regions — single Fly machine is fine for v1; if it
  becomes critical, scale to 2 machines in different regions with
  Redis-backed dedup keyed off event id.
- Backfill — if the bridge has been down for hours, missed events
  during downtime won't replay (unless VT3 honors `Last-Event-ID`).
  The 15-min cron backstop covers this gap.
