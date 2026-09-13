import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { delay } from "msw";
import { HttpResponse, http, installMsw, rawJson } from "@/test/msw/server";
import {
  PANDORA_BASE,
  PANDORA_PERSON_ID,
  PANDORA_PROJECT_ID,
  pandoraFixtures,
  pandoraHandlers,
} from "@/test/msw/handlers/pandora";
import {
  PANDORA_PARTY_LEAD_ID_FIELDS,
  parsePartyLeadBody,
  submitPartyLead,
  type PartyLeadInput,
} from "../pandora-party-lead";

/**
 * `submitPartyLead` after B3's R1 fix (brief §4 B3): the response is read as
 * RAW TEXT through `parseWithRawIds` with an explicit `projectID` field, and
 * the caller's `signal` reaches `fetch`. The fixture carries a BARE 17-digit
 * `projectID` and `personID` — the negative control proves the fixture is the
 * ugly case (memory `feedback_fixture_must_match_the_ugly_case`).
 */

const server = installMsw(...pandoraHandlers);

const INPUT: PartyLeadInput = {
  location: "fasttrax",
  firstName: "CRM",
  lastName: "Test",
  email: "crm-test@example.com",
  phone: "(239) 555-1234",
  eventType: "Company Event",
  eventDate: "2026-10-16",
  eventTime: "17:30",
  estimatedGuests: 42,
  agent: "First Available",
};

beforeEach(() => {
  process.env.SWAGGER_ADMIN_KEY = "test-key";
});
afterEach(() => {
  delete process.env.SWAGGER_ADMIN_KEY;
});

describe("parsePartyLeadBody", () => {
  it("keeps projectID (capital D) and personID as 17-digit strings; JSON.parse does not", () => {
    const text = pandoraFixtures.partyLead();
    // NEGATIVE CONTROL — the ordinary parse rounds both ids.
    const naive = JSON.parse(text) as { data: { projectID: number; personID: number } };
    expect(String(naive.data.projectID)).not.toBe(PANDORA_PROJECT_ID);
    expect(String(naive.data.personID)).not.toBe(PANDORA_PERSON_ID);

    const parsed = parsePartyLeadBody(text) as { data: { projectID: string; personID: string } };
    expect(parsed.data.projectID).toBe(PANDORA_PROJECT_ID);
    expect(parsed.data.personID).toBe(PANDORA_PERSON_ID);
    expect(PANDORA_PARTY_LEAD_ID_FIELDS).toContain("projectID");
    expect(PANDORA_PARTY_LEAD_ID_FIELDS).toContain("personID");
  });

  it("a non-JSON or empty body is null, never a throw", () => {
    expect(parsePartyLeadBody("")).toBeNull();
    expect(parsePartyLeadBody("<html>Bad gateway</html>")).toBeNull();
    expect(parsePartyLeadBody("[1,2]")).toBeNull();
  });
});

describe("submitPartyLead", () => {
  it("success: projectID / personID survive end to end as strings", async () => {
    const r = await submitPartyLead(INPUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projectID).toBe(PANDORA_PROJECT_ID);
    expect(r.personID).toBe(PANDORA_PERSON_ID);
    expect(r.projectNumber).toBe("DH3249");
    expect(r.assignedAgent).toEqual({ userId: "28267036", name: "Kelsea Kosco" });
  });

  it("sends the body Pandora expects (digits-only phone, string guests, agent) with the caller's signal", async () => {
    let seen: Record<string, unknown> | null = null;
    let aborted = false;
    server.use(
      http.post(`${PANDORA_BASE}/bmi/party-lead`, async ({ request }) => {
        seen = (await request.json()) as Record<string, unknown>;
        request.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return rawJson(pandoraFixtures.partyLead());
      }),
    );
    const controller = new AbortController();
    const r = await submitPartyLead(INPUT, { signal: controller.signal });
    expect(r.ok).toBe(true);
    expect(seen).toMatchObject({
      locationID: "LAB52GY480CJF",
      phone: "2395551234",
      estimatedGuests: "42",
      eventTime: "17:30",
      agent: "First Available",
    });
    expect(aborted).toBe(false);
  });

  it("timeout: an AbortSignal.timeout that fires becomes a 504 result, not a throw", async () => {
    server.use(
      http.post(`${PANDORA_BASE}/bmi/party-lead`, async () => {
        await delay(400);
        return rawJson(pandoraFixtures.partyLead());
      }),
    );
    const r = await submitPartyLead(INPUT, { signal: AbortSignal.timeout(40) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(504);
    expect(r.error).toBe("Pandora timed out");
  });

  it("a 500 with a JSON message surfaces the message and the status", async () => {
    server.use(
      http.post(`${PANDORA_BASE}/bmi/party-lead`, () =>
        HttpResponse.json(
          { success: false, message: "Failed to assign an agent" },
          { status: 500 },
        ),
      ),
    );
    const r = await submitPartyLead(INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(500);
    expect(r.error).toBe("Failed to assign an agent");
  });

  it("a 502 with a non-JSON body still yields a failure result", async () => {
    server.use(
      http.post(
        `${PANDORA_BASE}/bmi/party-lead`,
        () => new HttpResponse("<html>Bad gateway</html>", { status: 502 }),
      ),
    );
    const r = await submitPartyLead(INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(502);
    expect(r.error).toBe("Pandora returned 502");
  });

  it("validates before it calls Pandora", async () => {
    let calls = 0;
    server.use(
      http.post(`${PANDORA_BASE}/bmi/party-lead`, () => {
        calls++;
        return rawJson(pandoraFixtures.partyLead());
      }),
    );
    const r = await submitPartyLead({ ...INPUT, email: undefined, eventTime: undefined });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(400);
    expect(r.error).toBe("Missing required fields: email, eventTime");
    expect(calls).toBe(0);
  });
});
