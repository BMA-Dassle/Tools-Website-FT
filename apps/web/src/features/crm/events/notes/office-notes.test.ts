import { describe, expect, it, vi } from "vitest";
import { http, installMsw, rawJson } from "@/test/msw/server";
import { fixtureText } from "@/test/msw/handlers/fixture";
import { OFFICE_BASE, officeFixtures } from "@/test/msw/handlers/office";

/**
 * The notes read through the REAL Office transport against MSW.
 *
 * The fixture is RAW JSON TEXT with BARE 17-digit ids, so `parseWithRawIds`
 * inside `officeGet` is actually exercised — with the NEGATIVE CONTROL beside
 * it naming the rounded value an ordinary `JSON.parse` produces (memory
 * `feedback_fixture_must_match_the_ugly_case`). A `: string` annotation would
 * not have caught this; only the ugly fixture does.
 *
 * The memo in that fixture is the NESTED shape a real project carries after
 * `syncBmiNotes` has run: staff text, the Portal Staff separator, and the
 * website's `── FastTrax Web ──` block after it.
 */

vi.mock("@/lib/redis", () => ({
  default: {
    get: async () => null,
    setex: async () => "OK",
    set: async () => "OK",
    on: () => undefined,
  },
}));

const PROJECT_ID = "58454078";
const PERSON_ID = "63000000009561437";
const COMPANY_ID = "63000000009561999";
const LOG_ID = "63000000009562001";

const notesFixture = () => fixtureText("office-project-notes-58454078.json.txt");

installMsw(
  http.post(`${OFFICE_BASE}/auth/token`, () => rawJson(officeFixtures.token())),
  http.get(`${OFFICE_BASE}/api/:clientKey/project/:id`, ({ params }) =>
    params.id === PROJECT_ID
      ? rawJson(notesFixture())
      : rawJson('{"error":"nope"}', { status: 404 }),
  ),
);

const { readNotes, defaultNotesDeps } = await import("./service");

/** Only the Neon halves are stubbed; the Office read is the real transport. */
function deps() {
  return {
    ...defaultNotesDeps(),
    getSettingValue: async () => undefined,
    listTimeline: async () => ({ activities: [], nextCursor: null }),
    getEventMetadata: async () => ({
      foodOutTime: "4:45 PM",
      foodOutSource: "manual" as const,
      foodOutConfidence: "high",
      foodOutReasoning: null,
      metadata: {},
      updatedAt: "2026-09-12T12:00:00.000Z",
    }),
  };
}

describe("readNotes over the real Office transport", () => {
  it("NEGATIVE CONTROL — an ordinary JSON.parse rounds the fixture's ids", () => {
    const naive = JSON.parse(notesFixture()) as {
      personId: number;
      companyId: number;
      logs: { id: number }[];
    };
    expect(String(naive.personId)).not.toBe(PERSON_ID);
    expect(String(naive.companyId)).not.toBe(COMPANY_ID);
    expect(String(naive.logs[0].id)).not.toBe(LOG_ID);
  });

  it("splits the nested memo into staff / web / portal and keeps the public notes", async () => {
    const body = await readNotes(
      { centre: "HPFM", projectId: PROJECT_ID, leadId: null, date: "2026-09-19" },
      deps(),
    );

    expect(body.projectId).toBe(PROJECT_ID);
    expect(body.publicNotes).toContain("Arrive 15 minutes early");
    expect(body.sections.map((s) => s.key)).toEqual(["staff", "web", "portal"]);
    expect(body.sections[0].text).toContain("cake table by the mezzanine");
    expect(body.sections[1].text).toContain("Contract: https://headpinz.com/contract/7Hx2Qk");
    expect(body.sections[1].text).toContain("Waiver Organizer:");
    expect(body.sections[2].text).toBe("Food Out: 4:45 PM");
    // The web block must NOT bleed into the Portal Staff slice.
    expect(body.sections[2].text).not.toContain("FastTrax Web");
    expect(body.foodOut).toMatchObject({ time: "4:45 PM", source: "manual" });
    // No row in crm_settings means writes are ON (R4).
    expect(body.writesEnabled).toBe(true);
  });
});
