/**
 * 3CX (bma.3cx.us) — the Call Control API as `Tools-Call-Center/api/3cx/*`
 * proxies it (`token.js`, `callcontrol/index.js`, `extension-status.js`).
 *
 *   POST /connect/token            form {client_id, client_secret, grant_type=client_credentials} → {access_token, expires_in, token_type}
 *   GET  /callcontrol              [{dn, type:"Wextension"|"Wqueue"|…, devices[], participants[]}]
 *   GET  /callcontrol/{dn}         one DN object
 *
 * `participants[]` is where a live call shows: `{id, status, party_caller_id,
 * party_dn, party_did, direct_control, callid, legid}`. Ids are small ints.
 */

import { HttpResponse, http, rawJson } from "../server";
import { fixtureText } from "./fixture";

export const THREECX_BASE = "https://bma.3cx.us";

export const threecxFixtures = {
  token: () => fixtureText("threecx-token.json.txt"),
  callcontrol: () => fixtureText("threecx-callcontrol.json.txt"),
};

export const threecxHandlers = [
  http.post(`${THREECX_BASE}/connect/token`, () => rawJson(threecxFixtures.token())),
  http.get(`${THREECX_BASE}/callcontrol`, () => rawJson(threecxFixtures.callcontrol())),
  http.get(`${THREECX_BASE}/callcontrol/:dn`, ({ params }) => {
    const all = JSON.parse(threecxFixtures.callcontrol()) as { dn: string }[];
    const one = all.find((d) => d.dn === params.dn);
    return one ? HttpResponse.json(one) : new HttpResponse("Not Found", { status: 404 });
  }),
];
