/**
 * BMI Office — the READ endpoints the CRM mirror (B1) uses, on top of
 * `./office` (auth token, metadata, project 58454076, PUT project):
 *
 *   GET /api/{clientKey}/dayPlanner?resourceIds=…&from&till&showAll=true  → a September 2025 window
 *   GET /api/{clientKey}/liveReservations?from&until&projectStates=…      → two changed projects
 *   GET /api/{clientKey}/project/58454077                                  → an ONLINE booking (kindId -10)
 *   GET /api/{clientKey}/person/{id}                                       → the two hosts (17-digit ids)
 *
 * Raw text fixtures with bare 17-digit ids, like every Office fixture. The
 * project handler falls through (returns nothing) for ids it does not own,
 * so `./office`'s handler still answers 58454076 and 404s the rest.
 *
 * `officeMirrorCalls` records every request's path + the `x-session-id`
 * header so a test can assert the tag (`crm-backfill-<ck>`) and the
 * concurrency ceiling.
 */

import { HttpResponse, http, rawJson } from "../server";
import { fixtureText } from "./fixture";
import { OFFICE_BASE } from "./office";

export const OFFICE_ONLINE_PROJECT_ID = "58454077";
export const OFFICE_HOST_PERSON_ID = "63000000009561437";
export const OFFICE_ONLINE_PERSON_ID = "63000000009561440";

export const officeMirrorFixtures = {
  dayPlanner: () => fixtureText("office-dayplanner-2025-09.json.txt"),
  liveReservations: () => fixtureText("office-livereservations.json.txt"),
  onlineProject: () => fixtureText("office-project-58454077.json.txt"),
  hostPerson: () => fixtureText("office-person-63000000009561437.json.txt"),
  onlinePerson: () => fixtureText("office-person-63000000009561440.json.txt"),
};

export interface RecordedOfficeCall {
  path: string;
  sessionId: string | null;
  search: URLSearchParams;
}

export const officeMirrorCalls: RecordedOfficeCall[] = [];

function record(request: Request): void {
  const url = new URL(request.url);
  officeMirrorCalls.push({
    path: url.pathname,
    sessionId: request.headers.get("x-session-id"),
    search: url.searchParams,
  });
}

export const officeMirrorHandlers = [
  http.get(`${OFFICE_BASE}/api/:clientKey/dayPlanner`, ({ request }) => {
    record(request);
    return rawJson(officeMirrorFixtures.dayPlanner());
  }),
  http.get(`${OFFICE_BASE}/api/:clientKey/liveReservations`, ({ request }) => {
    record(request);
    return rawJson(officeMirrorFixtures.liveReservations());
  }),
  http.get(`${OFFICE_BASE}/api/:clientKey/project/:id`, ({ request, params }) => {
    if (params.id !== OFFICE_ONLINE_PROJECT_ID) return undefined;
    record(request);
    return rawJson(officeMirrorFixtures.onlineProject());
  }),
  http.get(`${OFFICE_BASE}/api/:clientKey/person/:id`, ({ request, params }) => {
    record(request);
    if (params.id === OFFICE_HOST_PERSON_ID) return rawJson(officeMirrorFixtures.hostPerson());
    if (params.id === OFFICE_ONLINE_PERSON_ID) return rawJson(officeMirrorFixtures.onlinePerson());
    return new HttpResponse("Not found", { status: 404 });
  }),
];
