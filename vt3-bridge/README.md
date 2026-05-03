# vt3-bridge

A tiny always-on worker that holds a Server-Sent Events connection to
`https://sys.vt3.io/videos/events` and forwards each pushed event to
the FastTrax Vercel webhook. Lets us replace the every-2-min
`/api/cron/video-match` polling loop with sub-second push delivery.

Vercel can't host this — Lambdas have a 60s ceiling, SSE wants to
stay open indefinitely. So the bridge runs on Railway or Fly.io
($0/mo on either's free tier) and the rest of the system is unchanged.

## What it does

```
sys.vt3.io/videos/events ──SSE──► vt3-bridge (this) ──POST──► /api/webhooks/vt3-video-event
                         ◄──ack──                  + secret      (Vercel)
                                                                       │
                                                                       ▼
                                                          existing lib/video-match.ts
```

- Logs into VT3 with `VT3_USERNAME` / `VT3_PASSWORD` (same flow our
  Vercel-side `lib/vt3.ts` uses).
- Opens the SSE stream, parses frames, posts each one to the webhook
  with an `x-vt3-bridge-secret` header.
- Sends a session-establish ACK to `POST /sse/{sessionId}/ack` once
  per connection (matches what the VT3 control panel does — verified
  via captured HAR).
- Reconnects on stream errors with exponential backoff (1s → 5min cap).
- Re-logs on 401.

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | The worker. ~250 lines, no runtime deps (uses native `fetch`). |
| `package.json` | Just `tsx` + `typescript` as dev deps for local. Zero runtime deps. |
| `tsconfig.json` | Strict TS, ESNext target. |
| `Dockerfile` | Multi-stage build → ~50MB runtime image. |
| `railway.json` | Railway deploy config. |
| `fly.toml` | Fly.io deploy config. |
| `.env.example` | Required env var list. |

## Local dev

```bash
cd vt3-bridge
npm install
cp .env.example .env.local
# Fill in VT3_USERNAME, VT3_PASSWORD, WEBHOOK_URL, WEBHOOK_SECRET in .env.local
npm run dev   # tsx watch — auto-reloads on file changes
```

## PROBE mode — discover the event schema

The captured HARs show VT3's SSE stream URL + the ACK protocol, but
**Chromium's HAR export can't capture SSE message bodies**, so we
don't yet know the actual event payload shape.

To discover it, run the bridge in probe mode against your machine:

```bash
PROBE=1 npm run dev
```

This logs every parsed event to stdout *without* forwarding to the
webhook. Leave it running for ~30 minutes during a busy race window
(when video uploads are flowing), then read the output to see:

- What `event:` types VT3 emits (`videoCreated`, `sampleUploaded`,
  `videoProcessed`, etc.?)
- What the JSON `data:` payload looks like for each event.
- Whether VT3 includes a `sessionId` in any payload (so we know
  which session-id to ACK against).

Once you have the schema, design the Vercel webhook handler at
`fasttrax-web/app/api/webhooks/vt3-video-event/route.ts` to dispatch
on `eventType` and call into the existing `lib/video-match.ts`
matching logic.

## Deploying

### Railway (one-time)

```bash
# Install CLI: https://docs.railway.com/guides/cli
railway login
cd vt3-bridge
railway init      # link to a new project
railway variables set \
  VT3_USERNAME='...' \
  VT3_PASSWORD='...' \
  WEBHOOK_URL='https://fasttraxent.com/api/webhooks/vt3-video-event' \
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
railway up        # build + deploy from Dockerfile
railway logs -f   # tail logs to verify the SSE connection opens
```

### Fly.io (one-time)

```bash
# Install CLI: https://fly.io/docs/flyctl/install/
fly auth login
cd vt3-bridge
fly launch --no-deploy --copy-config   # accepts existing fly.toml
fly secrets set \
  VT3_USERNAME='...' \
  VT3_PASSWORD='...' \
  WEBHOOK_URL='https://fasttraxent.com/api/webhooks/vt3-video-event' \
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
fly deploy
fly logs           # tail logs
fly status         # check the machine is RUNNING
```

### Mirror the secret into Vercel

The same `WEBHOOK_SECRET` value goes into the FastTrax Vercel
project as `VT3_BRIDGE_SECRET` so the webhook handler can validate
incoming requests:

```bash
# From fasttrax-web/, with vercel CLI logged in:
vercel env add VT3_BRIDGE_SECRET production
# paste the same hex string used in fly/railway secrets
```

## Cost

| Component | Cost |
|---|---|
| Railway free tier | $0/mo (500h/mo execution, fits a single 24/7 worker) |
| Fly.io free tier | $0/mo (3× shared-cpu-1x machines + 3GB outbound) |
| Vercel webhook invocations | ~$0 (couple cents/month, cheaper than today's polling) |

## Reliability strategy

The Vercel-side `/api/cron/video-match` polling cron stays running at
**every 15 min** during the rollout window as a backstop. If the
bridge dies / Fly outage / VT3 misses an event on reconnect, the
cron will catch up within 15 min instead of the bridge's "instant or
never" failure mode.

After 2-3 weeks of bridge uptime with no missed videos, drop the
cron entry from `fasttrax-web/vercel.json`.

## Known unknowns

1. **Event schema** — captured HARs don't include SSE bodies. Use
   PROBE mode to discover before wiring up the webhook handler.
2. **`Last-Event-ID` replay** — does VT3 honor the SSE
   `Last-Event-ID` header on reconnect to replay missed events? If
   yes, persist the last seen id and pass it on reconnect. If no,
   the cron-backstop strategy above is essential.
3. **JWT refresh under load** — current worker re-logs on 401. Real-
   world behavior under sustained load needs verification.
4. **Multi-site filtering** — VT3 might emit events for sites we
   don't care about. Filter at the worker (cheap network) or at
   the webhook (cheap CPU). Either works once we see the schema.

See `tasks/future/vt3-sse-bridge.md` and
`tasks/future/vercel-workflows-evaluation.md` (in the parent repo)
for the broader architectural context — once VT3 push events are
flowing, the per-booking lifecycle workflow becomes the natural
next step.
