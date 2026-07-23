# Game-card bridge (kiosk PC)

## Setup a PC (start here)

One script per center — clean-reinstalls everything (Node if missing, latest
bridge, env, browser policies, self-healing boot task) and verifies a clean
cloud poll. On the PC, in an **admin** PowerShell (the secret = Vercel's
`GAME_CARD_BRIDGE_SECRET`; it is deliberately not in this public repo — the
script prompts for it):

```
# FastTrax Fort Myers
irm https://raw.githubusercontent.com/BMA-Dassle/Tools-Website-FT/main/game-card-bridge/install-fasttrax.ps1 -OutFile C:\work\setup.ps1

# HeadPinz Fort Myers
irm https://raw.githubusercontent.com/BMA-Dassle/Tools-Website-FT/main/game-card-bridge/install-headpinz-fm.ps1 -OutFile C:\work\setup.ps1

# HeadPinz Naples
irm https://raw.githubusercontent.com/BMA-Dassle/Tools-Website-FT/main/game-card-bridge/install-naples.ps1 -OutFile C:\work\setup.ps1

# then, for any of the three:
C:\work\setup.ps1
```

(`install.ps1` is the underlying parameterized installer: `-Center 13|12|6
-Secret <hex>`.) After a green finish, restart the kiosk browser so the Game
Zone chip reads LOCAL.

Loads Intercard tokens onto game cards through the **on-prem EIS transaction
server** (raw TCP `:3044`, `iEnhancedInterfaceRequest` XML) — the immediate path
SWFLPassport uses. The cloud SOAP endpoint (our default) propagates to the
centers too slowly; this bridge writes straight to the local center server.

Two front doors:

1. **Kiosk fast path** — localhost HTTP `:4599`; the kiosk web app calls
   `http://127.0.0.1:4599/credit` and the bridge does the socket load.
2. **Web-reload queue worker** (opt-in) — polls the cloud app **outbound** for
   website reload jobs for THIS center: claim → local EIS credit → ack. No
   inbound port is ever opened; the bridge only dials out.

## Why it runs on the kiosk PC

The EIS servers are on the private center LAN (`10.x.x.x`). Vercel/cloud can't
reach them, and a browser can't open a raw TCP socket. The kiosk PC is on the
center LAN, so it carries both paths.

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

To also work the web-reload queue, add (values per center):

```
GC_CLOUD_URL=https://<prod domain>
GC_BRIDGE_SECRET=<same value as Vercel GAME_CARD_BRIDGE_SECRET>
GC_LOCATION_CODE=13        # 12 HeadPinz FM | 6 HeadPinz Naples | 13 FastTrax FM
```

Install it as a Windows service (nssm / Task Scheduler at logon) so it's always
up. Health check: `GET http://127.0.0.1:4599/health` (includes worker status).

## API

- `POST /credit` `{ accountNumber, tokens, bonusTokens }` → `{ ok, code, description }`
  (`code: "0"` = loaded). `tokens`/`bonusTokens` are token counts.
- `GET /health` → `{ ok, configured, ip, eisPort, worker }`.

## Env

| var                         | default     | notes                                          |
| --------------------------- | ----------- | ---------------------------------------------- |
| `PORT`                      | `4599`      | localhost port the kiosk app calls             |
| `INTERCARD_IP`              | —           | this center's EIS server IP (required)         |
| `INTERCARD_MAC`             | —           | this center's Intercard MAC (required, secret) |
| `INTERCARD_EIS_PORT`        | `3044`      | EIS TCP port                                   |
| `INTERCARD_TIMEOUT_MS`      | `30000`     | socket timeout                                 |
| `BRIDGE_ALLOW_ORIGIN`       | `*`         | restrict to the kiosk web origin if desired    |
| `GC_CLOUD_URL`              | —           | cloud app origin; unset = queue worker off     |
| `GC_BRIDGE_SECRET`          | —           | shared secret (`x-gc-bridge-secret` header)    |
| `GC_LOCATION_CODE`          | —           | Intercard location code this worker claims for |
| `GC_POLL_MS`                | `2500`      | claim poll interval                            |
| `INTERCARD_WEB_EMPLOYEE_ID` | `WebReload` | EmployeeID stamped on queue credits (audit)    |

The kiosk web app tries this bridge first for token loads and falls back to the
cloud SOAP path (`NEXT_PUBLIC_GAME_CARD_BRIDGE_URL`, default
`http://127.0.0.1:4599`) if the bridge is unreachable.

## Global load-path switch (`INTERCARD_LOAD_MODE`)

Set in **Vercel** (the app), not on the bridge PC. One master switch over the
per-center `GAME_CARD_EIS_QUEUE_CENTERS` list, governing kiosk AND web at once:

| value          | effect                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud`        | Force cloud SOAP everywhere. Web skips the queue; the **kiosk stops calling this bridge entirely** (GZ chip + `/reload` badge show Cloud). The bridge becomes safe to uninstall. |
| `local`        | Force local EIS at every center (all centers queue web reloads; kiosk dials the bridge).                                                                                         |
| unset / `auto` | Per-center behavior via `GAME_CARD_EIS_QUEUE_CENTERS` (default; the pilot mechanism).                                                                                            |

Mirror the SAME value into `NEXT_PUBLIC_INTERCARD_LOAD_MODE` so the kiosk browser
agrees. The cloud SOAP fallback is **never** disabled by this flag — it only
picks the preferred path, never the recover-forward safety net.

Use `cloud` before the **card-consolidation project**: the local EIS path can
only load tokens (no consolidate / card-clear), so those flows must run through
cloud. Flip to `cloud`, confirm the kiosk chip reads Cloud, then uninstall the
bridge.

## Queue safety (read before touching the worker)

The EIS `CreditAccounts` request has **no idempotency id** (the cloud SOAP path
dedups on `tpi_transaction_id`; this path does not). The worker therefore NEVER
retries a credit. It classifies each attempt and acks the cloud:

| outcome      | meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `ok`         | EIS ResponseCode 0 — credited                                  |
| `declined`   | EIS replied non-0 — definitively NOT credited → cloud SOAP     |
| `no_attempt` | request never reached the EIS (connect failed / stale claim)   |
| `unknown`    | request written, no/partial reply — cloud resolves via history |

Multiple kiosk PCs per center can run the worker safely: the cloud claim is
`FOR UPDATE SKIP LOCKED`, so jobs are handed out disjointly.

**Ops runbook — rows flagged `manual`** (queue_state='manual' in
`intercard_transactions`, logged as `MANUAL INTERVENTION REQUIRED (verify)`):
the bridge attempted a credit and the outcome is unknown, and cloud history
never showed it. Check Intercard reports for the credit (account + tokens +
time) before hand-crediting — hand-crediting a card that DID receive the EIS
credit double-loads it.

## Tests

`node --test` (zero-dep, uses an ephemeral local TCP server).
