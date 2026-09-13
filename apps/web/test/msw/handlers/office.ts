/**
 * BMI Office (sms-timing) — the shapes `~/features/daily-events/data/bmi-office.ts`
 * and `lib/bmi-office-actions.ts` actually see.
 *
 *   POST /auth/token                          form body → {access_token, expires_in}
 *   GET  /api/{clientKey}/metadata            {states, kinds, users, resources, products, payMethods}
 *   GET  /api/{clientKey}/project/{id}        the project entity (17-DIGIT personId / bills[].id / projectPersons[].id)
 *   PUT  /api/{clientKey}/project             echoes the body back (200); a test overrides it for the 403 prompt
 *
 * Every body is RAW TEXT from `../fixtures` — the ids are bare numbers, so a
 * reader that `JSON.parse`s them gets the rounded value. The metadata fixture's
 * `9000000x` state ids are TEST PLACEHOLDERS for the four states whose real
 * ids are unknown (brief §1.8); the known ones (49130082, 48952154, 3274635,
 * 55397028, 55466363, -3, -4) are the Fort Myers values.
 *
 * Both `fetch` (undici) and node `https.request` are intercepted by msw/node.
 */

import { HttpResponse, http, rawJson } from "../server";
import { fixtureText } from "./fixture";

export const OFFICE_BASE = "https://office-api22.sms-timing.com";

export const OFFICE_PROJECT_ID = "58454076";
export const OFFICE_PROJECT_PERSON_ID = "63000000009561437";
export const OFFICE_PROJECT_BILL_ID = "63000000009561438";

export const officeFixtures = {
  token: () => fixtureText("office-auth-token.json.txt"),
  metadata: () => fixtureText("office-metadata.json.txt"),
  project: () => fixtureText("office-project-58454076.json.txt"),
};

/** The 403 soft-refusal envelope our API2 login gets (project 58454076, 2026-08-12). */
export const OFFICE_OVERBOOK_REFUSAL = {
  IsQuestion: false,
  Kind: 4,
  Message:
    "Total persons (12) is higher than the capacity (0) in HP Arena: " +
    "8/15/2026 6:30:00 PM - 8/15/2026 6:45:00 PM, overbooking is not allowed.",
  OperationId: "8389cf8a268af9b19134286e9ae39f06",
};

export const officeHandlers = [
  http.post(`${OFFICE_BASE}/auth/token`, () => rawJson(officeFixtures.token())),
  http.get(`${OFFICE_BASE}/api/:clientKey/metadata`, () => rawJson(officeFixtures.metadata())),
  http.get(`${OFFICE_BASE}/api/:clientKey/project/:id`, ({ params }) =>
    params.id === OFFICE_PROJECT_ID
      ? rawJson(officeFixtures.project())
      : new HttpResponse("Not found", { status: 404 }),
  ),
  http.put(`${OFFICE_BASE}/api/:clientKey/project`, async ({ request }) =>
    rawJson(await request.text()),
  ),
];
