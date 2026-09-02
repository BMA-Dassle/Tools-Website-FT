# Intercard `Api_External` REST API — Full Reference

> **Status: LATEST.** This is the current Intercard REST interface. It has been **tested
> only at HeadPinz Fort Myers** (center 12 / `LocID 12`). Behavior at other centers is
> unverified — the credentials and the on-site SignalR client are provisioned per-location,
> so treat everything below as confirmed for HeadPinz Fort Myers and untested elsewhere.

> **Confidential — NDA vendor integration.** This documents Intercard's `Api_External`
> service (game-card / debit-card system). The repo `BMA-Dassle/Tools-Website-FT` is
> **public**, so do **not** commit live credentials (the `ClientToken` JWT, the MAC
> address, or the `Api_External` binaries) into this file or anywhere in git history.
> Placeholders (`<CLIENT_TOKEN>`) are used below. Same public-repo hazard flagged for
> `docs/intercard-enhanced-3rd-party-interface-v7.pdf`.

**Source of truth for this doc:** reverse-engineered 2026-08-27 from the shipped binary
`Api_External.dll` (`AssemblyVersion 5.4.1.0`, informational `5.4.1.0.20250929`, .NET 8)
via ILSpy, cross-checked against the live Swagger document and live smoke calls against
the FastTrax / SWFL Passport production instance. Every endpoint, model field, header
name, and error string below is read directly from the decompiled source.

---

## 1. What this service is

`Api_External` is **not** the card system. It is a thin **cloud relay** that sits in
front of an on-premise Intercard client:

```
   You (REST caller)                Api_External (cloud)                 On-site client
  ─────────────────                ────────────────────                 ──────────────
  POST /api/v1/tpi/xxx  ──────▶  1. IsValidLicenseInfo (DB lookup)
   headers: LocID,                2. find SignalR connection for LocID
     ProductCode, ClientToken     3. SendAsync("ReceiveTransaction") ──▶ processes against
   body: {transactionRequest,        (waits up to 30 s)                   the real Intercard
          <operation payload>}                                            Transaction Server
                               ◀── 4. Ok(result) ◀── TransactionResponse ◀──  (SignalR)
```

Consequences of the relay design:

- A call can **authenticate successfully yet fail** with `404` if no on-site client is
  currently connected for that location, or `504` if the on-site client does not answer
  within 30 seconds.
- The **response body shape is produced by the on-site client**, not by `Api_External`.
  The relay just deserializes whatever JSON the client posts back and returns it. The
  observed envelope is `{ responseCode, responseDescription, <payload> }` (see §6).
- There is **no queue / no store-and-forward**. If the client is offline, the call fails
  immediately; there is no retry on the server side.

Runtime facts (from `Program.cs`):

- ASP.NET Core 8, Kestrel behind IIS (`UseIISIntegration`, `UseHttpsRedirection`).
- SignalR hub mapped at **`/transactionHub`** (see §8).
- Logging: Serilog → rolling file `Logs/Log.txt` **and** Graylog UDP `logs.intercardinc.com:50000`.
- Swagger UI/JSON is only wired up `if (env.IsDevelopment())`. It is reachable in
  production, which means the live instance runs with `ASPNETCORE_ENVIRONMENT=Development`.
- There is an empty `ApiExternalDbContext` (EF Core) registered but unused; all data
  access is raw `SqlClient` in the license service.

---

## 2. Base URL & versioning

|                 |                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production base | `https://intercard.swflpassport.com/Api_External`                                                                                                                                        |
| Route template  | `/api/v{version:apiVersion}/tpi/{operation}`                                                                                                                                             |
| Current version | `1.0` → path segment `v1`                                                                                                                                                                |
| Version readers | URL segment (`/v1/`), header `x-api-version`, or media-type param `x-api-version`. Default `1.0` is assumed if unspecified; `api-supported-versions: 1.0` is returned on every response. |

**Swagger:**

- UI: `GET /Api_External/swagger/index.html`
- JSON: `GET /Api_External/swagger/v1/swagger.json`

(The Swagger doc lists the 31 operations but declares **no** security scheme and **no**
parameter/body detail for most operations — this document fills those gaps.)

---

## 3. Authentication & licensing

There is **no** `Authorization: Bearer` / OAuth on these endpoints. (The
`Microsoft.AspNetCore.Authentication.JwtBearer` assembly ships with the app but the TPI
endpoints are **not** `[Authorize]`-gated.) Instead every call is gated by
`TpiController.IsValidLicenseInfo`, which requires **four values that must all match a
licensed row** held in memory:

| Value        | Sent as                                             | Example        |
| ------------ | --------------------------------------------------- | -------------- |
| Location ID  | HTTP header `LocID` (parsed with `Convert.ToInt32`) | `12`           |
| Product code | HTTP header `ProductCode` (exact string)            | `API-0331`     |
| Client token | HTTP header `ClientToken` (exact string)            | the JWT        |
| MAC address  | **JSON body** `transactionRequest.macAddress`       | `00155D56DE02` |

The `LicsenseInfoValidationService` background service reloads the valid rows **every 5
minutes** by calling stored proc `dbo.ST_SEC_ProdDataCorp` on the `SEC_00001` database,
building `AuthorizationItem(ProductCode, LocationID, MACID, AuthorizationToken)`. A request
passes only if `ProductCode`, `LocationID` (int-equal), `MACID`, **and** `AuthorizationToken`
all equal a loaded row. Any mismatch → `401 {"error":"ETPI requires up to date Licensing."}`
(the message is generic — it is the same for a wrong token, wrong MAC, wrong product code,
wrong location, or an empty lookup).

### 3.1 ⚠ The MAC-format gotcha (this is the one that bites)

The DB comparison is a plain `string.Equals` — the loaded value is only `.Trim()`-med,
with **no separator stripping and no case folding**. The admin UI displays the MAC in
colon form (`00:15:5D:56:DE:02`), but the value stored in `ST_SEC_ProdDataCorp` (and
therefore the value you must send) is **no separators, uppercase**:

| `transactionRequest.macAddress` sent | Result                                    |
| ------------------------------------ | ----------------------------------------- |
| `00:15:5D:56:DE:02` (UI form)        | `401 ETPI requires up to date Licensing.` |
| `00-15-5D-56-DE-02`                  | `401`                                     |
| `00:15:5d:56:de:02`                  | `401`                                     |
| **`00155D56DE02`**                   | **`200` ✅**                              |

Rule: strip `:`/`-`/space and uppercase the MAC before putting it in the body.

### 3.2 Client token (JWT) anatomy

The `ClientToken` is an HS256 JWT (`iss: INTERCARD`, `aud: API`) issued by Intercard and
shown on the venue's Intercard connection-settings screen. `Api_External` does **not**
cryptographically validate it — it only string-compares it to the `AuthorizationToken`
column. Its claims are informational to the caller:

| Claim                | Meaning                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `check-value`        | base64, 64 bytes (server-side integrity value; not checked by this API)  |
| `token-last-changed` | epoch ms the token was last rotated                                      |
| `license-exp`        | epoch ms the license expires                                             |
| `nbf` / `exp`        | JWT not-before / expiry (the provisioned token: 2026-06-29 → 2027-06-29) |

If the token is rotated on the Intercard side, `ST_SEC_ProdDataCorp` is updated and the
in-memory lookup refreshes within 5 minutes — an old token then stops working.

---

## 4. Request envelope

Every operation takes a JSON body whose root has a `transactionRequest` object plus (for
mutating operations) one operation-specific object. Field casing is camelCase on the wire
(ASP.NET default) — e.g. `transactionRequest`, `macAddress`, `lT_DateTime`.

### 4.1 `transactionRequest` (shared by every operation)

| Field           | Type     | Required         | Notes                                                          |
| --------------- | -------- | ---------------- | -------------------------------------------------------------- |
| `requestType`   | string   | —                | Free-text label, e.g. `"GameList"`. Not validated server-side. |
| `macAddress`    | string   | ✅ (for auth)    | See §3.1. Feeds the license MAC check.                         |
| `transactionID` | string   | recommended      | Your idempotency/correlation id. Echoed in logs.               |
| `sessionID`     | string   | ✅ **non-empty** | `[Required]`; empty/omitted → `400`.                           |
| `employeeID`    | string   | ✅ **non-empty** | `[Required]`; empty/omitted → `400`.                           |
| `employeeName`  | object   | —                | `{ "firstName": string, "lastName": string }`                  |
| `lT_DateTime`   | DateTime | —                | Local time, ISO-8601 (`2026-08-27T03:51:20`).                  |
| `utC_DateTime`  | DateTime | —                | UTC, ISO-8601.                                                 |

> **Model validation runs before the license check.** Because the controller is
> `[ApiController]`, a malformed body returns `400` (RFC 9110 problem+json) _before_
> `IsValidLicenseInfo` is reached. `sessionID` and `employeeID` are the two `[Required]`
> string fields — the most common cause of an unexpected `400`.

### 4.2 GET-with-body

Several read operations are declared `[HttpGet]` yet bind the payload `[FromBody]`. You
must send a request body on a GET:

```bash
curl -X GET ".../api/v1/tpi/gamelist" -H "Content-Type: application/json" --data '{...}'
```

Most HTTP clients allow a GET body; some (browsers `fetch`) do not. If your client blocks
it, note the server does not care about the verb semantically — but the route is
registered for GET only, so you cannot switch to POST for these.

### 4.3 Value types

- **Money** fields are C# `decimal`. Send invariant-culture decimals as JSON numbers or
  strings (`12.50`). Do not localize.
- **Account numbers** (`AccountNumber`, `SourceAccount`, `TargetAccount`, …) are C#
  `long` (SQL bigint). They can exceed JavaScript's `Number.MAX_SAFE_INTEGER` (2^53).
  In JS, carry them as **strings** end-to-end to avoid rounding, consistent with the
  BMI id-precision rule in this repo.
- **Dates** in payloads (`ActivationDate`, `ExpirationDate`, `HistoryStartDate`, …) are
  `DateTime` → ISO-8601 strings.

---

## 5. Authentication headers (summary)

```
Content-Type: application/json
Accept:       application/json
LocID:        12
ProductCode:  API-0331
ClientToken:  <CLIENT_TOKEN>
```

(plus `macAddress` in the body). No other headers are required. `x-api-version: 1.0` is
optional.

---

## 6. Response envelope & response codes

On a successful relay round-trip the HTTP status is `200` and the body is whatever the
on-site client returned, consistently shaped as:

```json
{ "responseCode": 0, "responseDescription": "Success", "<payloadKey>": ... }
```

`responseCode` follows Intercard's convention (same as the SOAP TPI):

| `responseCode` | Meaning                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| `0`            | Success                                                                      |
| `-1`           | Exception during processing (details in server log only)                     |
| `-2`           | Could not resolve / downstream exception (e.g. observed on `gateaccesslist`) |

> **Important:** `responseCode` is a _body_ field, independent of the HTTP status. A
> `200 OK` can still carry `responseCode: -2` with a null payload. Always check both.

The `<payloadKey>` differs per operation (`gameList`, `packageList`, `membershipList`,
`blockedAccessList`, `reasonCodes`, `gateAccessList`, …). See each operation in §9.

---

## 7. Error responses (from the relay itself)

| HTTP  | Body                                                                                                      | When                                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `400` | `{"type":".../rfc9110...","title":"One or more validation errors occurred.","status":400,"errors":{...}}` | Model validation failed (e.g. missing `sessionID`/`employeeID`). Runs before auth.                    |
| `401` | `{"error":"ETPI requires up to date Licensing."}`                                                         | License 4-tuple did not match a loaded row (wrong token/MAC/product/loc, or empty lookup).            |
| `400` | `{"error":"LocID header is missing or invalid."}`                                                         | `LocID` header missing/empty. (Only reachable if licensing somehow passed with a blank LocID — rare.) |
| `404` | `{"error":"No SignalR client connected for LocID 12."}`                                                   | Auth OK, but no on-site client is connected for that location.                                        |
| `500` | `{"error":"Failed to track transaction."}`                                                                | Internal: could not register the pending transaction.                                                 |
| `504` | `{"error":"Transaction timed out waiting for client response."}`                                          | On-site client did not answer within 30 s.                                                            |
| `500` | `{"error":"Failed to process transaction."}`                                                              | Unhandled exception while relaying.                                                                   |

There is **no** `WWW-Authenticate` header on the `401` (it is a custom `Unauthorized(...)`,
not the JwtBearer challenge).

---

## 8. SignalR hub (`/transactionHub`) — the on-site client contract

This is what the **on-premise** side implements; documented here so both ends are covered.

- **Connect:** open a SignalR connection to `wss://intercard.swflpassport.com/transactionHub?LocID=12`.
  On connect, the hub stores `LocationConnections[LocID] = ConnectionId`. One connection
  per LocID (last writer wins).
- **Receive work:** the server invokes client method **`ReceiveTransaction`** with a single
  argument:
  ```json
  { "TransactionId": "<guid>", "Action": "gamelist", "Transaction": { "TransactionRequest": {...}, "<payload>": {...} } }
  ```
  `Action` is the operation name (the last path segment). `Transaction` is the exact object
  the REST caller sent (envelope + operation payload).
- **Return result:** the client invokes hub method **`TransactionResponse`** with:
  ```json
  { "transactionId": "<same guid>", "response": { "responseCode": 0, "responseDescription": "Success", ... } }
  ```
  The relay resolves the pending REST call with `response` (verbatim) and returns it as the
  `200` body. Property names `transactionId` and `response` are **case-sensitive** here.
- **Disconnect:** the hub removes the LocID→ConnectionId mapping.

> There is also a dead/legacy REST endpoint `POST /api/v1/tpi/response` that writes to a
> _separate_ `PendingResponses` dictionary which `HandleTransaction` never awaits. The live
> response path is the SignalR `TransactionResponse` method above; do not use `/response`.

---

## 9. Endpoint catalog (all 31 TPI operations)

All paths are prefixed `/api/v1/tpi`. All require the §5 headers + body MAC. All bodies
wrap `transactionRequest` (§4.1) plus the operation object named below. Payload field types
are from the decompiled models.

### 9.1 Read / list operations (safe, no state change)

#### `GET /gamelist` — list card-reader devices/games

Body: `{ transactionRequest }` only.
Response: `{ responseCode, responseDescription, gameList: [ { deviceName, deviceTag } ] }`
Live sample: 98 devices, e.g. `{"deviceName":"CardReader","deviceTag":627}`.

#### `GET /reasoncodelists` — reason-code lookups

Body: `{ transactionRequest }` only.
Response: `{ responseCode, responseDescription, reasonCodes: { lockReasonCodeList: [ { reasonCodeID, description, order } ], ... } }`

#### `GET /packagelist` — sellable packages

Body: `{ transactionRequest }` only.
Response: `{ responseCode, responseDescription, packageList: [ { packageID:int, productTag:int, packageDescription:string, suggestedPrice:decimal } ] }`
Live sample (center 12, 2026-08-27): `{"packageID":52,"productTag":103,"packageDescription":"100 Tokens","suggestedPrice":10}` (6 packages, $5–$100).
`packageID` is the value passed to `POST /packagesale`. Returned in `packageID` order.
Note: this list reflects Intercard back-office package config exposed to the API interface — it read empty earlier the same day until packages were provisioned/enabled, so a blank `packageList` with `responseCode:0` means "none configured for this interface," not an error.

#### `GET /membershiplist` — membership tiers

Body: `{ transactionRequest }` only.
Response: `{ responseCode, responseDescription, membershipList: [ { membershipID, membershipTitle, membershipDiscountPercentage } ] }`
Live sample: `{"membershipID":8,"membershipTitle":"Employee Discount","membershipDiscountPercentage":50}`.

#### `GET /blockedaccesslist` — blocked-access profiles

Body: `{ transactionRequest }` only.
Response: `{ responseCode, responseDescription, blockedAccessList: [ { blockedAccessID, blockedAccessDescription } ] }`
Live sample: `{"blockedAccessID":25,"blockedAccessDescription":"Allow Rides (waiver signed)"}`.

#### `GET /gateaccesslist` — gate-access products

Body: `{ transactionRequest }` only.
Response: `{ responseCode, responseDescription, gateAccessList: [...] }`
Live: returned `responseCode:-2` (downstream exception) at this site — feature may be unconfigured.

#### `GET /balanceinquiry` — account balance

Body: `{ transactionRequest, balanceInquiry: { accountNumber:long } }`
Returns the account's cash/bonus/token/point balances (payload defined by the on-site client).

#### `GET /accounthistory` — account transaction history

Body: `{ transactionRequest, accountHistoryRequest: { accountNumber:long, historyStartDate:DateTime, historyEndDate:DateTime, localUTCOffset:int } }`

### 9.2 Credit / add-value operations (money-moving — POST)

#### `POST /creditaccounts` — credit one or more accounts

Body object `creditAccounts: { creditAccountsList: [ CreditAccount ] }` where **CreditAccount** =
`{ accountNumber:long, blockedAccessID:int, cash:decimal, cashBonus:decimal, tokens:int, tokenBonus:int, points:int, tP_Duration:int, tP_ActiveImmediate:bool, activationDate:DateTime, expirationDate:DateTime }`

#### `POST /compcard` — comp value onto a card

Body `compCard: { accountNumber:long, cash:decimal, cashBonus:decimal, tokens:int, tokenBonus:int, points:int, reasonCode:int }`

#### `POST /encodecards` — encode/initialize card(s) with value

Body `encodeCards: { encodeDescription:string, encodeTenderAmount:decimal, accountNumbersList:{accountNumbers:[long]}, creditCash:decimal, creditCashBonus:decimal, creditTokens:int, creditTokenBonus:int, creditPoints:int, tP_Duration:int, activationDate:DateTime, expirationtionDate:DateTime, blockedAccessID:int, packageID:int }`
(Note the misspelling `expirationtionDate` is in the wire contract.)

#### `POST /packagesale` — sell a package onto an account

Body `packageSale: { accountNumber:long, packageID:int, packageCost:decimal, tP_ActiveImmediate:bool }`

#### `POST /gateaccesssale` — sell gate-access products

Body `gateAccessSale: { gateAccessCreditList: [ { accountNumber:long, gateAccessProductList:[ { gateProductTag:int, gateProductCost:decimal } ] } ] }`

#### `POST /creditdebitescrowpoints` — adjust escrow points

Body `creditDebitEscrowPoints: { accountNumber:long, pointAmount:int }` (positive credit / negative debit).

### 9.3 Debit / payment operations (money-moving — POST)

#### `POST /paymentviacustomercard` — take payment from card balance

Body `paymentViaCustomerCard: { customerCardPaymentList: [ { accountNumber:long, debitCash:decimal, debitCashBonus:decimal } ] }`
(The relay forwards this under the key `DebitAccounts`.)

#### `POST /readerdebitcredittransaction` — reader-driven debit/credit

Body `readerDebitCreditTransaction: { accountNumber:long, deviceTag:long, points:int }`

### 9.4 Card lifecycle / value-movement operations (POST)

#### `POST /clearcard` — zero out card(s)

Body `clearCard: { accountNumbersList: { accountNumbers:[long] } }`

#### `POST /lockcard` — lock an account

Body `lockCard: { accountNumber:long, reasonCode:int }`

#### `POST /pausetimeplay` — pause time-play on an account

Body `pauseTimePlay: { accountNumber:long }`

#### `POST /splitcard` — split value from one card to targets

Body `splitCard`: source starting/debit values + target credit values —
`{ sourceAccount:long, sourceStartingCashValue:decimal, sourceStartingBonusCashValue:decimal, sourceStartingTokenValue:int, sourceStartingTokenBonusValue:int, sourceStartingPointsValue:int, sourceDebitCashValue:decimal, sourceDebitBonusCashValue:decimal, sourceDebitTokenValue:int, sourceDebitBonusTokenValue:int, sourceDebitPointsValue:int, targetAccountsList:[long], targetCreditCashValue:decimal, targetCreditBonusCashValue:decimal, targetCreditTokenValue:int, targetCreditTokenBonusValue:int, targetCreditPointsValue:int }`

#### `POST /consolidatecards` — merge source cards into a target

Body `consolidateCards: { targetAccount:long, consolidateSourceAccountList:{accountNumbers:[long]} }`

#### `POST /transferaccount` — transfer an account

Body `transferAccount: { targetAccount:long, sourceAccount:long, reasonCode:int }`

#### `POST /entitlementsclaim` — claim entitlements/products

Body `entitlementClaim: { accountNumber:long, claimedEntitlementList:[ { productTag:int, qtyCreditDebit:int } ] }`

#### `POST /removegateaccess` — remove a gate-access product from an account

Body `removeGateAccess: { accountNumber:long, gateProductTag:int }`

### 9.5 Customer / membership (POST)

#### `POST /updatecustomerinfo` — update customer profile

Body `updateCustomerInfo: { accountNumber:long, firstName:string, lastName:string, phone:string, email:string, postalCode:string, dateOfBirth:string, gender:string }`

#### `POST /updatemembership` — set an account's membership

Body `updateMembership: { accountNumber:long, membershipID:int }`

### 9.6 Refund / void (money-reversing — POST)

#### `POST /refundcard` — refund value from a card

Body `refundCard: { accountNumber:long, authorizationEmployeeID:string, authorizationEmployeeName:{firstName,lastName}, reasonCode:int, debitCash:decimal, debitCashBonus:decimal, debitToken:int, debitTokenBonus:int, debitDuration:int }`

#### `POST /voidcardtransaction` — void a prior card transaction

Body `voidCardTransaction: { authorizationEmployeeID:string, authorizationEmployeeName:{...}, voidedTransactionID:string, voidedCardsList:[ { accountNumber:long, creditedCash:decimal, creditedBonusCash:decimal, creditedTokens:int, creditedTokenBonus:int, creditedPoints:int, creditedDuration:int } ] }`

#### `POST /voidpackagesale` — void a package sale

Body `voidPackageSale: { accountNumber:long, packageID:int }`

#### `POST /voidpaymentviacustomercard` — void a card-payment

Body `voidPaymentViaCustomerCardTransaction: { authorizationEmployeeID:string, authorizationEmployeeName:{...}, voidedTransactionID:string, voidedPaymentCardsList:[ { accountNumber:long, paymentCreditCash:decimal, paymentCreditCashBonus:decimal } ] }`

### 9.7 Internal / do-not-use

#### `POST /response` — **legacy, non-functional**

Writes to a `PendingResponses` dictionary that nothing awaits. The real response path is
the SignalR `TransactionResponse` hub method (§8). Do not call.

---

## 10. Idempotency & safety notes

- Send a unique `transactionID` per call for correlation. The relay itself keys pending
  work by a server-generated GUID, not your `transactionID`, and does **no** dedup — a
  retried money-moving call will be forwarded again. Dedup, if any, is the on-site
  client's / Transaction Server's responsibility. Treat `504`/`500` as _ambiguous_ on
  money moves: re-query balance (`GET /balanceinquiry`) before retrying, per the standing
  BMI/Intercard "don't blind-retry money" rule.
- `responseCode` is authoritative for business success even on `200` — always check it.
- The 30-second relay timeout bounds every call; design callers with ≥35 s client timeouts.

---

## 11. Working example (verified 2026-08-27, `200 Success`)

```bash
BASE="https://intercard.swflpassport.com/Api_External"
TOKEN="<CLIENT_TOKEN>"

curl -X GET "$BASE/api/v1/tpi/gamelist" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "LocID: 12" \
  -H "ProductCode: API-0331" \
  -H "ClientToken: $TOKEN" \
  --data '{
    "transactionRequest": {
      "requestType": "GameList",
      "macAddress": "00155D56DE02",
      "transactionID": "example-001",
      "sessionID": "1",
      "employeeID": "1",
      "employeeName": { "firstName": "API", "lastName": "Probe" },
      "lT_DateTime": "2026-08-27T03:51:20",
      "utC_DateTime": "2026-08-27T07:51:20"
    }
  }'
# → 200 {"responseCode":0,"responseDescription":"Success","gameList":[{"deviceName":"Balance Checker","deviceTag":547}, ... 98 devices ]}
```

---

## 12. Known site values (HeadPinz Fort Myers — center 12)

_Tested location. Other centers are not yet verified against this API._

| Field                     | Value                                                       |
| ------------------------- | ----------------------------------------------------------- |
| Server URL                | `https://intercard.swflpassport.com/Api_External/api/v1`    |
| MAC (as stored / to send) | `00155D56DE02` (UI shows `00:15:5D:56:DE:02`)               |
| Product Code              | `API-0331`                                                  |
| Location ID               | `12`                                                        |
| Client Token              | on the Intercard connection-settings screen (do not commit) |

---

_Generated 2026-08-27 from `Api_External.dll` v5.4.1.0.20250929 + live verification._
