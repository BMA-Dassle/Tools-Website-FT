# kart-timing-bridge

Tiny always-on worker that holds a WebSocket connection to the
FastTrax kart timing broadcast endpoint at `ws://68.171.192.138:10001`,
sends the SMS-Timing `BcStart` subscription on connect, and forwards
every inbound message to a Vercel webhook on fasttraxent.com.

Sibling subproject to `vt3-bridge/`. Same architecture, different
upstream protocol (WebSocket frames vs SSE).

## Subscription on open

```jsonc
{
  "$type": "BcStart",
  "Timing": "false",
  "Notifications": "true",
  "Resource": "Red Track",
  "BcFormat": "0",
  "NotificationGroups": ["BROADCAST", "TIMING", "INFO"],
  "RaceStatsResendInterval": "00:00:01"
}
```

Sent on every successful WebSocket open (including reconnects).

## What you get

```
ws://68.171.192.138:10001 ──WebSocket──► kart-timing-bridge (Railway)
                                         │
                                         ▼ POST + x-kart-bridge-secret
                                    https://fasttraxent.com/api/webhooks/kart-timing-event
                                         │
                                         ▼
                                    Redis FIFO `kart:events:queue` (capped 5000, 24h TTL)
                                    + heartbeat `kart:bridge:last-event`
```

Every inbound WebSocket message gets:
- Logged to console (Railway logs)
- POST'd to the Vercel webhook with the shared secret
- Stored in a Redis list for inspection / future processing

## Local dev

```bash
cd kart-timing-bridge
npm install
cp .env.example .env.local
# Edit .env.local — set WEBHOOK_SECRET to the same hex string the
# vt3-bridge service uses (same value, both bridges share it on the
# Vercel side via VT3_BRIDGE_SECRET).
npm run dev
```

## PROBE mode

```bash
PROBE=1 npm run dev
```

Logs every parsed message to stdout in addition to forwarding.
Useful for discovering the actual broadcast schema (BcRaceState,
BcInfo, BcTiming, etc.) before you build per-message-type handlers
on the Vercel side.

## Deploying to Railway

```bash
cd kart-timing-bridge
railway init   # link to a new project
railway variables set \
  WS_URL='ws://68.171.192.138:10001' \
  WEBHOOK_URL='https://fasttraxent.com/api/webhooks/kart-timing-event' \
  WEBHOOK_SECRET='<paste same hex as vt3-bridge>'
railway up
railway logs -f
```

Mirror the same secret value into Vercel as `VT3_BRIDGE_SECRET` if
you don't want a separate env var (the kart webhook validates
against either VT3_BRIDGE_SECRET or KART_BRIDGE_SECRET; one shared
secret keeps env config simple).

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Single-file worker, Node 22+ built-in WebSocket. |
| `package.json` | Zero runtime deps; `tsx` + `typescript` as dev deps. |
| `tsconfig.json` | Strict TS, ESNext target. |
| `Dockerfile` | Multi-stage build → ~50MB runtime image. |
| `railway.json` | Railway deploy config. |
| `fly.toml` | Fly.io alternate config. |
| `.env.example` | Required env vars. |

## Reconnect behavior

- Exponential backoff on close/error: 1s → 5min cap, with jitter.
- BcStart subscription auto-resends on every open (including reconnects).
- 30s open watchdog: if the connection stalls in CONNECTING state
  for 30s, force-close and let the loop retry.

## Known unknowns

1. **Broadcast message types.** The protocol uses `$type`-discriminated
   .NET serialization. Common types from SMS-Timing's protocol:
   - `BcRaceState` — heat / race lifecycle
   - `BcInfo` — admin notifications
   - `BcTiming` — lap data (we have `Timing: "false"` so probably
     not subscribed by default)
   PROBE mode reveals the actual schema flowing through this server.

2. **Reconnect drift.** Server may dedupe based on session id (like
   VT3) or replay missed events on subscribe. Worth checking with
   `BcFormat: "0"` vs other format values once we see traffic.

3. **TLS.** Currently `ws://` (plaintext). If we ever expose this
   to the public internet, switch to `wss://` with proper certs.