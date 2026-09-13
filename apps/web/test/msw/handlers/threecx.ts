/**
 * 3CX (bma.3cx.us) — the surfaces the CRM actually uses, with the payload
 * shapes CAPTURED FROM THE LIVE PBX on 2026-09-13 (`docs/crm/3cx.md`), not
 * invented:
 *
 *   POST /connect/token                                  form {client_id, client_secret, grant_type} → {access_token, expires_in: 60, token_type}
 *   GET  /callcontrol                                    [{dn, type:"Wextension"|"Wqueue"|…, devices[], participants[]}]
 *   GET  /callcontrol/{dn}                               one DN object
 *   POST /callcontrol/{dn}/makecall                      {finalstatus, reason, result{…}}
 *   GET  /xapi/v1/Users                                  {value:[{Id, Number, FirstName, LastName, EmailAddress}]}
 *   GET  /xapi/v1/ReportCallLogData/Pbx.GetCallLogData(…) {value:[Pbx.CallLogData]}  ← the ONLY form that answers
 *
 * `participants[]` is where a live call shows. Every 3CX id is a small int
 * (`CallId`, `SegmentId`) or a GUID string (`CdrId`, `CallHistoryId`) — there
 * are no 17-digit ids on this transport, so `JSON.parse` is safe here; the
 * raw-text fixture discipline is about Office and Pandora.
 *
 * The call-log fixture is five REAL rows with the guests' numbers replaced by
 * the test numbers `+12395551234` / `+12395550199` / `+12395552277`, and it
 * carries the ugly case on purpose: three of the rows share ONE
 * `CallHistoryId` and only one of them is the answered extension leg.
 */

import { HttpResponse, http, rawJson } from "../server";
import { fixtureText } from "./fixture";

export const THREECX_BASE = "https://bma.3cx.us";

/** The one call in the fixture that spans an IVR leg, a queue leg and an extension leg. */
export const THREECX_ANSWERED_CALL_ID = "00000000-01dd-43ab-25e4-c24300000ic5";
/** The missed inbound from a number nobody in the CRM knows. */
export const THREECX_MISSED_CALL_ID = "00000000-01dd-43a1-4edb-b26800000ib1";
/** The outbound answered call from Kelsea's extension. */
export const THREECX_OUTBOUND_CALL_ID = "00000000-01dd-43a9-4b44-627e000002c2";

export const threecxFixtures = {
  token: () => fixtureText("threecx-token.json.txt"),
  callcontrol: () => fixtureText("threecx-callcontrol.json.txt"),
  users: () => fixtureText("threecx-users.json.txt"),
  callLog: () => fixtureText("threecx-calllog.json.txt"),
  makeCall: () => fixtureText("threecx-makecall.json.txt"),
};

/** Every `makecall` MSW saw, so a test can assert what was dialled without dialling. */
export const threecxDialled: { extension: string; body: unknown }[] = [];

export const threecxHandlers = [
  http.post(`${THREECX_BASE}/connect/token`, () => rawJson(threecxFixtures.token())),
  http.get(`${THREECX_BASE}/callcontrol`, () => rawJson(threecxFixtures.callcontrol())),
  http.post(`${THREECX_BASE}/callcontrol/:dn/makecall`, async ({ params, request }) => {
    threecxDialled.push({ extension: String(params.dn), body: await request.json() });
    return rawJson(threecxFixtures.makeCall());
  }),
  http.get(`${THREECX_BASE}/callcontrol/:dn`, ({ params }) => {
    const all = JSON.parse(threecxFixtures.callcontrol()) as { dn: string }[];
    const one = all.find((d) => d.dn === params.dn);
    return one ? HttpResponse.json(one) : new HttpResponse("Not Found", { status: 404 });
  }),
  http.get(`${THREECX_BASE}/xapi/v1/Users`, () => rawJson(threecxFixtures.users())),
  // The bound OData function carries its arguments INSIDE the path segment, so
  // the pattern has to be a wildcard — msw cannot match `(a=1,b=2)` as a param.
  http.get(`${THREECX_BASE}/xapi/v1/ReportCallLogData/*`, () => rawJson(threecxFixtures.callLog())),
];
