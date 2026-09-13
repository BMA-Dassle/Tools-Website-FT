/**
 * Pandora (`bma-pandora-api.azurewebsites.net/v2`) — `lib/pandora-party-lead.ts`
 * and the `/bmi/reservation/state` write in `lib/bmi-office-actions.ts`.
 *
 *   POST /v2/bmi/party-lead          {success, message, data:{projectID, projectNumber, personID, assignedAgent}}
 *   POST /v2/bmi/reservation/state   {success:true}
 *
 * The party-lead fixture carries `projectID` / `personID` as BARE 17-digit
 * numbers. Live Pandora strings them server-side today (`bmi.utils.ts:1538`),
 * which is exactly why `res.json()` has not bitten yet — the fixture is the
 * ugly case so the guard (`parseWithRawIds(text, [...BMI_ID_FIELDS, "projectID"])`)
 * is exercised. Note `projectID` (capital D) is NOT in `BMI_ID_FIELDS`.
 */

import { HttpResponse, http, rawJson } from "../server";
import { fixtureText } from "./fixture";

export const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";

export const PANDORA_PROJECT_ID = "63000000009561437";
export const PANDORA_PERSON_ID = "63000000009561438";

export const pandoraFixtures = {
  partyLead: () => fixtureText("pandora-party-lead.json.txt"),
};

export const pandoraHandlers = [
  http.post(`${PANDORA_BASE}/bmi/party-lead`, () => rawJson(pandoraFixtures.partyLead())),
  http.post(`${PANDORA_BASE}/bmi/reservation/state`, () => HttpResponse.json({ success: true })),
];
