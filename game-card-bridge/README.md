# Game-card bridge (kiosk PC)

Loads Intercard tokens onto game cards through the **on-prem EIS transaction
server** (raw TCP `:3044`, `iEnhancedInterfaceRequest` XML) — the immediate path
SWFLPassport uses. The cloud SOAP endpoint (our default) propagates to the
centers too slowly; this bridge writes straight to the local center server.

## Why it runs on the kiosk PC

The EIS servers are on the private center LAN (`10.x.x.x`). Vercel/cloud can't
reach them, and a browser can't open a raw TCP socket. The kiosk PC is on the
center LAN, so it runs this tiny HTTP→TCP bridge on `localhost`; the kiosk web app
calls `http://127.0.0.1:4599/credit` and the bridge does the socket load.

Each bridge is pinned to ITS center via env — the MAC is a secret and never
leaves the PC or reaches the browser.

## Run (Node 18+)

```
# FastTrax Fort Myers
INTERCARD_IP=10.48.2.2 INTERCARD_MAC=68EDA47E4B69 npm start

# HeadPinz Fort Myers
INTERCARD_IP=10.43.2.2 INTERCARD_MAC=989096D0F391 npm start

# HeadPinz Naples
INTERCARD_IP=10.40.2.2 INTERCARD_MAC=68EDA45A5F59 npm start
```

Install it as a Windows service (nssm / Task Scheduler at logon) so it's always
up. Health check: `GET http://127.0.0.1:4599/health`.

## API

- `POST /credit` `{ accountNumber, tokens, bonusTokens }` → `{ ok, code, description }`
  (`code: "0"` = loaded). `tokens`/`bonusTokens` are token counts.
- `GET /health` → `{ ok, configured, ip, eisPort }`.

## Env

| var                    | default | notes                                          |
| ---------------------- | ------- | ---------------------------------------------- |
| `PORT`                 | `4599`  | localhost port the kiosk app calls             |
| `INTERCARD_IP`         | —       | this center's EIS server IP (required)         |
| `INTERCARD_MAC`        | —       | this center's Intercard MAC (required, secret) |
| `INTERCARD_EIS_PORT`   | `3044`  | EIS TCP port                                   |
| `INTERCARD_TIMEOUT_MS` | `30000` | socket timeout                                 |
| `BRIDGE_ALLOW_ORIGIN`  | `*`     | restrict to the kiosk web origin if desired    |

The kiosk web app tries this bridge first for token loads and falls back to the
cloud SOAP path (`NEXT_PUBLIC_GAME_CARD_BRIDGE_URL`, default
`http://127.0.0.1:4599`) if the bridge is unreachable.
