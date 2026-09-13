/**
 * QubicaAMF bowling reservations — `lib/qamf-bowling.ts` + `lib/qamf-bowling-auth.ts`.
 *
 *   POST https://api.qubicaamf.com/oauth2/token                          form → {access_token, expires_in, scope}
 *   GET  …/bowling-reservations/centers/{id}/lanes                        {Lanes:[{LaneNumber, Status, ClosedAt?, Reservation?}]}
 *   POST …/bowling-reservations/centers/{id}/reservations/search          {Reservations:[Reservation]} (api-version "1.4")
 *
 * Ids here are strings by design (`X…` web, `C…` Conqueror, `K…` kiosk), so
 * there is no 17-digit trap — the fixtures pin the FIELD shapes the
 * availability grid reads (`Lanes[].StartTime` local offset, `Type.Description`,
 * `Source`).
 */

import { http, rawJson } from "../server";
import { fixtureText } from "./fixture";

export const QAMF_BASE = "https://api.qubicaamf.com/bowling-reservations";
export const QAMF_TOKEN_URL = "https://api.qubicaamf.com/oauth2/token";

export const qamfFixtures = {
  token: () => fixtureText("qamf-token.json.txt"),
  lanes: () => fixtureText("qamf-lanes.json.txt"),
  search: () => fixtureText("qamf-reservations-search.json.txt"),
};

export const qamfHandlers = [
  http.post(QAMF_TOKEN_URL, () => rawJson(qamfFixtures.token())),
  http.get(`${QAMF_BASE}/centers/:centerId/lanes`, () => rawJson(qamfFixtures.lanes())),
  http.post(`${QAMF_BASE}/centers/:centerId/reservations/search`, () =>
    rawJson(qamfFixtures.search()),
  ),
];
