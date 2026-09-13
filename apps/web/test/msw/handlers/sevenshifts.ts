/**
 * 7shifts — the B2 port of the portal's `api/lib/7shifts-client.ts` (brief
 * §1.9, portal facts F1.2–F1.11).
 *
 *   GET https://api.7shifts.com/v2/company/265994/shifts?location_id=&start[gte]=&start[lte]=&limit=500&include_draft=true
 *       → {data:[{id, user_id, location_id, department_id, role_id, start, end, open, publish_status, draft, deleted, breaks[]}], meta:{cursor:{next}}}
 *   GET …/users?status=active&limit=
 *       → {data:[{id, punch_id, employee_id, first_name, last_name, email, …}], meta}
 *
 * The shifts fixture carries the two traps: a `published_deleted` row (must be
 * filtered) and an open shift (`user_id: null`). Times are local-with-offset.
 */

import { http, rawJson } from "../server";
import { fixtureText } from "./fixture";

export const SEVEN_SHIFTS_COMPANY_ID = "265994";
export const SEVEN_SHIFTS_BASE = `https://api.7shifts.com/v2/company/${SEVEN_SHIFTS_COMPANY_ID}`;

export const sevenShiftsFixtures = {
  shifts: () => fixtureText("sevenshifts-shifts.json.txt"),
  users: () => fixtureText("sevenshifts-users.json.txt"),
};

export const sevenShiftsHandlers = [
  http.get(`${SEVEN_SHIFTS_BASE}/shifts`, () => rawJson(sevenShiftsFixtures.shifts())),
  http.get(`${SEVEN_SHIFTS_BASE}/users`, () => rawJson(sevenShiftsFixtures.users())),
];
