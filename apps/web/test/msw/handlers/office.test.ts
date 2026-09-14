import { describe, expect, it } from "vitest";
import { BMI_ID_FIELDS, parseWithRawIds } from "@ft/db";
import { installMsw } from "../server";
import {
  OFFICE_BASE,
  OFFICE_PROJECT_BILL_ID,
  OFFICE_PROJECT_ID,
  OFFICE_PROJECT_PERSON_ID,
  officeHandlers,
} from "./office";

/**
 * Office transport: the fake serves raw text whose 17-digit ids survive
 * `parseWithRawIds` — with the NEGATIVE CONTROL that proves the fixture is
 * still the ugly case (memory `feedback_fixture_must_match_the_ugly_case`).
 */

installMsw(...officeHandlers);

const OFFICE_ID_FIELDS = [
  ...BMI_ID_FIELDS,
  "resourceId",
  "stateId",
  "kindId",
  "userId",
  "productId",
];

describe("msw: BMI Office", () => {
  it("GET project — parseWithRawIds keeps personId / bills[].id; JSON.parse does not", async () => {
    const res = await fetch(`${OFFICE_BASE}/api/headpinzftmyers/project/${OFFICE_PROJECT_ID}`);
    expect(res.status).toBe(200);
    const text = await res.text();

    // NEGATIVE CONTROL — the ordinary parse rounds the id.
    const naive = JSON.parse(text) as { personId: number; bills: { id: number }[] };
    expect(String(naive.personId)).not.toBe(OFFICE_PROJECT_PERSON_ID);
    expect(String(naive.bills[0].id)).not.toBe(OFFICE_PROJECT_BILL_ID);

    const parsed = parseWithRawIds<{
      id: string;
      personId: string;
      stateId: string;
      userId: string;
      bills: { id: string }[];
      projectPersons: { id: string; personId: string }[];
    }>(text, OFFICE_ID_FIELDS);
    expect(parsed.id).toBe(OFFICE_PROJECT_ID);
    expect(parsed.personId).toBe(OFFICE_PROJECT_PERSON_ID);
    expect(parsed.bills[0].id).toBe(OFFICE_PROJECT_BILL_ID);
    expect(parsed.projectPersons[0].personId).toBe(OFFICE_PROJECT_PERSON_ID);
    expect(parsed.stateId).toBe("49130082");
    expect(parsed.userId).toBe("28267036");
  });

  it("GET metadata — states carry {id, name}; auth token mints", async () => {
    const tok = await fetch(`${OFFICE_BASE}/auth/token`, {
      method: "POST",
      body: "grant_type=password",
    });
    expect((JSON.parse(await tok.text()) as { access_token: string }).access_token).toBe(
      "msw-office-token",
    );

    const res = await fetch(`${OFFICE_BASE}/api/headpinznaples/metadata`);
    const meta = parseWithRawIds<{ states: { id: string; name: string }[] }>(
      await res.text(),
      OFFICE_ID_FIELDS,
    );
    const names = meta.states.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "New Lead",
        "Contacted",
        // "Pending Quote", not "Quote" — the fixture used to name a state
        // neither tenant has, which is precisely why the status map's phantom
        // "Quote" entry survived every test run. See `bmi-states.ts`.
        "Pending Quote",
        "Send Contract",
        "Pending Signed Contract",
        "Cancellation",
      ]),
    );
    expect(meta.states.find((s) => s.name === "Send Contract")?.id).toBe("49130082");
  });

  it("PUT project — echoes the body so a caller can assert what it sent", async () => {
    const body = '{"id":58454076,"stateId":49130082,"confirm":false}';
    const res = await fetch(`${OFFICE_BASE}/api/headpinzftmyers/project`, { method: "PUT", body });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });

  it("an unknown project is a 404, not a fixture", async () => {
    const res = await fetch(`${OFFICE_BASE}/api/headpinzftmyers/project/1`);
    expect(res.status).toBe(404);
  });
});
