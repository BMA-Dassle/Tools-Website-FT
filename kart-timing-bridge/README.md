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
  "Resource": "Karting",
  "BcFormat": "0",
  "NotificationGroups": [
    "BROADCAST",
    "CLIENTACTIONS",
    "DEVICE",
    "MAINTENANCE",
    "PERSON",
    "PROJECT",
    "SESSION",
    "SUBSCRIPTION",
    "SYSTEM",
    "TESTING",
    "TIMING",
  ],
  "RaceStatsResendInterval": "00:00:01",
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
npm run probe
```

Works the same in PowerShell and bash — the flag is `--probe` on the
command line, not a POSIX `VAR=1 cmd` prefix (which cmd.exe rejects
outright). `PROBE=1` or `PROBE=true` in `.env.local` or in Railway's
variables does the same thing; `npm run dev` and `npm run probe` both
load `.env.local` via Node's `--env-file-if-exists`. Nothing loaded
that file before, so a `PROBE=1` line in it was silently ignored.

Check the `probeMode` field in the `[kart-bridge] starting` line to
confirm it took.

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

### Watch paths — why the pattern starts with `/`

`railway.json` sets `build.watchPatterns: ["/kart-timing-bridge/**"]`. Without
it, **every push to `main` redeploys this service**, including pushes that only
touch `apps/web`. That is not cosmetic: a redeploy drops the timing socket, and
the reconnect replays the venue's full catch-up dump (109 records) — the exact
replay that fed the race clock a false green flag on 2026-08-15. On the night of
2026-08-16 five socket drops were traced to five pushes, several of them while
the venue was still racing, and only one of the five actually changed this
bridge.

The leading slash is deliberate and should not be "tidied" away. Railway's watch
patterns are evaluated **from the repository root even when the service has a
Root Directory configured** — with a root of `kart-timing-bridge`, the pattern is
still `/kart-timing-bridge/**`, not `/**` or `src/**`. Getting this wrong fails
in the quiet direction: the service simply stops picking up its own changes, and
you find out when a bridge fix doesn't take.

## Files

| File            | Purpose                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`  | Single-file worker. Uses `ws@8`, NOT Node's built-in WebSocket — see the header comment; the built-in silently decoded every compressed frame to an empty string. |
| `package.json`  | `ws` as the one runtime dep; `tsx` + `typescript` as dev deps.                                                                                                    |
| `tsconfig.json` | Strict TS, ESNext target.                                                                                                                                         |
| `Dockerfile`    | Multi-stage build → ~50MB runtime image.                                                                                                                          |
| `railway.json`  | Railway deploy config + watch paths (see above).                                                                                                                  |
| `fly.toml`      | Fly.io alternate config.                                                                                                                                          |
| `.env.example`  | Required env vars.                                                                                                                                                |

## Reconnect behavior

- Exponential backoff on close/error: 1s → 5min cap, with jitter. Backoff
  resets only after a session that carried a frame AND lasted 60s — a socket
  that opens and dies instantly is a failure, not a clean close.
- BcStart subscription auto-resends on every open (including reconnects).
- **Three watchdogs**, because a half-open socket looks exactly like a quiet
  venue (see the `src/index.ts` header for the full account):
  1. **connect** — 30s to reach `open`.
  2. **ping/pong** — every 25s; a ping issued while the last pong is still
     outstanding means the peer is gone before TCP admits it.
  3. **idle frame** — 45s with no raw frame at all, measured BEFORE the dedupe.
     This is the one that catches the silent stall.

  All three end with `terminate()`, never `close()`.

### Did it recover, or did we restart it?

Reconnects go to stdout, which is only readable in Railway. So the bridge also
POSTs `boot` and `session-end` records to
`/api/webhooks/kart-bridge-session` → `kart:bridge:sessions` in Redis:

```bash
cd apps/web && npx tsx scripts/kart-bridge-sessions.mts
```

`bootId` is generated per process. A **new bootId** means the process was
replaced (deploy or crash); the **same bootId with an incrementing reconnect
count** means the socket dropped and the bridge healed itself. `reason` names
the watchdog that ended the session. Without those two fields the only way to
tell the cases apart was correlating full-snapshot replays in
`kart:events:queue` against commit timestamps — and that queue holds barely
45 minutes during racing.

## Wire format — READ THIS BEFORE TOUCHING THE CLIENT

The server is `websocket-sharp/1.0` and negotiates
`permessage-deflate; client_no_context_takeover; server_no_context_takeover`.

- **Every frame is compressed** (RSV1 set). Node's **built-in** `WebSocket`
  (undici) decodes them to **zero-length strings**. This bridge used to treat
  those as "empty keep-alives" and threw away 100% of the live stream for its
  entire life while looking healthy. That is why we depend on `ws`.
- On `BcFormat: "0"` a message also arrives **fragmented** (`TEXT fin=0` +
  `CONT` + `CONT fin=1`). Inflating one fragment alone throws
  `unexpected end of file`. `ws` reassembles; a hand-rolled client must.
- **A zero-length frame now means the decoder is broken**, not that the venue
  is quiet. The bridge warns on it rather than dropping it silently.
- `RaceStatsResendInterval: "00:00:01"` **is honored** — ~1 message/sec.
- Verify any client change against a **running race**. An idle venue and a
  broken decoder look identical.

## Message types actually observed (2026-08-15)

`BcFormat` selects between two mutually exclusive payloads:

| `BcFormat`   | You get                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"0"` (ours) | `RaceStart`, `RaceFinish` (has `ActualStart` **and** `ActualEnd`), `RaceStop`, `RaceAdvice`, `SessionDurationChangedNotification`, `BcTime`                   |
| `"1"`        | `PositioningGamificationRequest` / `Kind: "RacesStats"` — `TimeLeftMs`, `GenerationTimeUtc`, per-kart `Laps` / `PositionInRace` / `TrackProgress` / `IsInPit` |

`Timing: "true"` and the `NotificationGroups` list changed nothing in testing.

**The full snapshot (~86 records, ~35KB) is re-sent every second** whether or
not anything changed, so the bridge dedupes by content hash per
(`$type`, `RaceId`) and forwards only what moved. Without that it would evict
the webhook's 5000-entry Redis FIFO in ~83 minutes.

## The race clock

**The vendor's `TimeLeftMs` is always `0`. Do not use it.** Derive:

```
remaining = ActualStartUtc + DurationTimeMs + accumulatedPause − GenerationTimeUtc
```

- `GenerationTimeUtc` is the venue's own clock — use it as "now", no skew.
- `ActualStart` **never restamps on resume**, so paused time must be tracked
  from `RaceStop` (`State: Paused`) → `RaceStart` (`State: Started`).
- Staff time-adds arrive as `SessionDurationChangedNotification`
  (`SessionId` = `RaceId`, new `DurationTime`, `Date`).
- Verified exactly: race 58698117 ran a 62:23 wall span against a 53:00
  duration → 9:23 accumulated pause.

## One subscription only

A second `BcStart` **re-points the stats feed globally, across other open
connections** — opening a per-track socket hijacked the existing one. You
cannot hold Blue + Red + Mega subscriptions concurrently.

You do not need to: a single `Resource: "Karting"` subscription on
`BcFormat: "0"` carries every track (Blue id 11208654 and Red id 11208660 both
appear in one snapshot). Per-resource subscriptions are only relevant to
`BcFormat: "1"` stats, and `"Karting"` was observed to _omit_ a newly started
Red race that `Resource: "Red Track"` returned correctly.

## Known unknowns

1. **Mega track.** Absent from the 2026-08-15 snapshot, but so was any Mega
   race. Expected to appear under `Karting` like Red does — confirm when Mega
   next runs.
2. **Why `TimeLeftMs` is zero.** Possibly fed by kart telemetry rather than the
   race clock; every race observed had no kart physically moving. Open with BMI.
3. **TLS.** Currently `ws://` (plaintext). If we ever expose this
   to the public internet, switch to `wss://` with proper certs.
