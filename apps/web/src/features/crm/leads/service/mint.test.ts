import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { delay } from "msw";
import { HttpResponse, http, installMsw, rawJson } from "@/test/msw/server";
import {
  PANDORA_BASE,
  PANDORA_PERSON_ID,
  PANDORA_PROJECT_ID,
  pandoraFixtures,
  pandoraHandlers,
} from "@/test/msw/handlers/pandora";
import type { EnqueueInput } from "~/features/crm/jobs";
import { QUEUE_LEADS, makeLead } from "../test-support";

/**
 * The mint policy (brief §4 B3) against the MSW Pandora: the raw-text
 * fixture with a bare 17-digit `projectID` (capital D), the timeout through
 * `signal`, the 500 path, the event-type table, and the missing-email path
 * that never calls Pandora. Neon is mocked at the data modules.
 */

const bag = vi.hoisted(() => ({
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  bumps: [] as { id: string; patch: Record<string, unknown> }[],
  activities: [] as Record<string, unknown>[],
  enqueued: [] as EnqueueInput[],
}));

vi.mock("../data/leads-db", () => ({
  updateLeadFields: async (id: string, patch: Record<string, unknown>) => {
    bag.updates.push({ id, patch });
    return null;
  },
  bumpMintAttempt: async (id: string, patch: Record<string, unknown>) => {
    bag.bumps.push({ id, patch });
  },
  getLead: async () => null,
}));
vi.mock("~/features/crm/activities", () => ({
  recordActivity: async (a: Record<string, unknown>) => {
    bag.activities.push(a);
    return "1";
  },
}));
vi.mock("~/features/crm/jobs", () => ({
  neonJobStore: {
    enqueue: async (input: EnqueueInput) => {
      bag.enqueued.push(input);
      return { job: { id: "1" }, created: true };
    },
  },
}));

const {
  EVENT_TYPE_TO_PANDORA,
  FIRST_AVAILABLE,
  NEEDS_EMAIL_OR_TIME,
  buildMintInput,
  mintBlocker,
  mintLead,
  mintProject,
  pandoraEventTypeFor,
  defaultMintDeps,
} = await import("./mint");

const server = installMsw(...pandoraHandlers);
const L1061 = QUEUE_LEADS[0]!;

beforeEach(() => {
  process.env.SWAGGER_ADMIN_KEY = "test-key";
  bag.updates = [];
  bag.bumps = [];
  bag.activities = [];
  bag.enqueued = [];
});
afterEach(() => {
  delete process.env.SWAGGER_ADMIN_KEY;
});

describe("the event-type map (policy (c))", () => {
  it("is the tested constant: corporate / team / holiday → Company Event; school / fundraiser → Other Event", () => {
    expect(EVENT_TYPE_TO_PANDORA).toEqual({
      corporate: "Company Event",
      team: "Company Event",
      holiday: "Company Event",
      school: "Other Event",
      fundraiser: "Other Event",
    });
  });
  it("a birthday is Child Birthday ONLY when kids is true (Pandora force-routes that string to Guest Services)", () => {
    expect(pandoraEventTypeFor("birthday", true)).toBe("Child Birthday");
    expect(pandoraEventTypeFor("birthday", false)).toBe("Adult Birthday");
    expect(pandoraEventTypeFor("corporate", true)).toBe("Company Event");
  });
});

describe("buildMintInput", () => {
  it("sends agent = the picked rep's Office name, else 'First Available' — never undefined (policy (a)/(b))", () => {
    expect(buildMintInput(L1061).agent).toBe(FIRST_AVAILABLE);
    expect(buildMintInput(L1061, { agent: "" }).agent).toBe(FIRST_AVAILABLE);
    expect(buildMintInput(L1061, { agent: null }).agent).toBe(FIRST_AVAILABLE);
    expect(buildMintInput(L1061, { agent: "Kelsea Kosco" }).agent).toBe("Kelsea Kosco");
  });
  it("maps the centre to Pandora's location key and carries the lead's fields", () => {
    const i = buildMintInput(L1061);
    expect(i).toMatchObject({
      location: "fasttrax",
      firstName: "Marcus",
      lastName: "Bellamy",
      email: "marcus.bellamy@gulfcoastlogistics.com",
      phone: "+12395552710",
      eventType: "Company Event",
      eventDate: "2026-10-16",
      eventTime: "17:30",
      estimatedGuests: "42",
      specialRequests: L1061.notes,
    });
    expect(buildMintInput(makeLead({ id: "1", centre: "HPFM" })).location).toBe("headpinz");
    expect(buildMintInput(makeLead({ id: "1", centre: "HPN" })).location).toBe("naples");
    expect(buildMintInput(QUEUE_LEADS[1]!).eventType).toBe("Child Birthday");
  });
  it("the web form's blob beats the notes as specialRequests; package / contact prefs ride along", () => {
    const i = buildMintInput(L1061, {
      specialRequests: "Package interested in: VIP",
      packageType: "VIP",
      preferredContact: "text",
      preferredTime: "Evening",
    });
    expect(i.specialRequests).toBe("Package interested in: VIP");
    expect(i.packageType).toBe("VIP");
    expect(i.preferredContact).toBe("text");
    expect(i.preferredTime).toBe("Evening");
  });
});

describe("mintBlocker (policy (d))", () => {
  it("needs_email_or_time when either is missing; prospect for cold rows; null otherwise", () => {
    expect(mintBlocker(L1061)).toBeNull();
    expect(mintBlocker({ ...L1061, guest: { ...L1061.guest, email: null } })).toBe(
      NEEDS_EMAIL_OR_TIME,
    );
    expect(mintBlocker({ ...L1061, eventTime: null })).toBe(NEEDS_EMAIL_OR_TIME);
    expect(mintBlocker({ ...L1061, isProspect: true })).toBe("prospect");
  });
});

describe("mintProject against Pandora (MSW)", () => {
  it("success: projectId / personId are the fixture's 17-digit strings (negative control: JSON.parse rounds them)", async () => {
    const naive = JSON.parse(pandoraFixtures.partyLead()) as { data: { projectID: number } };
    expect(String(naive.data.projectID)).not.toBe(PANDORA_PROJECT_ID);

    const out = await mintProject(L1061);
    expect(out.status).toBe("minted");
    if (out.status !== "minted") return;
    expect(out.projectId).toBe(PANDORA_PROJECT_ID);
    expect(out.personId).toBe(PANDORA_PERSON_ID);
    expect(out.projectNumber).toBe("DH3249");
    expect(out.assignedAgent?.name).toBe("Kelsea Kosco");
  });

  it("missing email → status none, and Pandora is NOT called", async () => {
    let calls = 0;
    server.use(
      http.post(`${PANDORA_BASE}/bmi/party-lead`, () => {
        calls++;
        return rawJson(pandoraFixtures.partyLead());
      }),
    );
    const out = await mintProject({ ...L1061, guest: { ...L1061.guest, email: null } });
    expect(out).toEqual({ status: "none", error: NEEDS_EMAIL_OR_TIME });
    expect(calls).toBe(0);
  });

  it("500 → failed with Pandora's message and the status", async () => {
    server.use(
      http.post(`${PANDORA_BASE}/bmi/party-lead`, () =>
        HttpResponse.json(
          { success: false, message: "Failed to assign an agent" },
          { status: 500 },
        ),
      ),
    );
    const out = await mintProject(L1061, { agent: "Nobody Here" });
    expect(out).toEqual({ status: "failed", error: "Failed to assign an agent", httpStatus: 500 });
  });

  it("timeout: the signal aborts a slow Pandora and the outcome is a 504 failure", async () => {
    server.use(
      http.post(`${PANDORA_BASE}/bmi/party-lead`, async () => {
        await delay(300);
        return rawJson(pandoraFixtures.partyLead());
      }),
    );
    const out = await mintProject(L1061, {}, { ...defaultMintDeps, timeoutMs: 30 });
    expect(out).toEqual({ status: "failed", error: "Pandora timed out", httpStatus: 504 });
  });
});

describe("mintLead — the outcome lands on the row", () => {
  const deps = () => ({
    ...defaultMintDeps,
    jobs: {
      enqueue: async (i: EnqueueInput) => {
        bag.enqueued.push(i);
        return { job: { id: "1" } as never, created: true };
      },
    },
    now: () => new Date("2026-09-12T23:30:00Z"),
  });

  it("minted → bmi ids + mint_status minted on the lead, a bmi activity keyed by the project id", async () => {
    const { outcome } = await mintLead(
      L1061,
      { agent: "Kelsea Kosco" },
      deps(),
      "eric@headpinz.com",
    );
    expect(outcome.status).toBe("minted");
    expect(bag.updates).toHaveLength(1);
    expect(bag.updates[0]).toMatchObject({
      id: "1061",
      patch: {
        bmiProjectId: PANDORA_PROJECT_ID,
        bmiProjectNumber: "DH3249",
        bmiPersonId: PANDORA_PERSON_ID,
        mintStatus: "minted",
        mintError: null,
      },
    });
    expect(bag.activities[0]).toMatchObject({
      kind: "bmi",
      externalKind: "pandora-party-lead",
      externalRef: PANDORA_PROJECT_ID,
      actorEmail: "eric@headpinz.com",
    });
    expect(bag.enqueued).toHaveLength(0);
  });

  it("failed → mint_attempts bumped, mint_status failed, ONE retry job with the per-lead key", async () => {
    server.use(
      http.post(`${PANDORA_BASE}/bmi/party-lead`, () =>
        HttpResponse.json({ message: "boom" }, { status: 500 }),
      ),
    );
    const { outcome } = await mintLead(L1061, {}, deps(), null);
    expect(outcome.status).toBe("failed");
    expect(bag.bumps).toEqual([{ id: "1061", patch: { mintStatus: "failed", mintError: "boom" } }]);
    expect(bag.enqueued).toHaveLength(1);
    expect(bag.enqueued[0]).toMatchObject({
      kind: "mint-bmi-project",
      idempotencyKey: "mint-bmi-project:1061:mint",
      payload: { leadId: "1061", task: "mint" },
    });
    expect(bag.activities[0]).toMatchObject({ kind: "system" });
    expect(String(bag.activities[0]!.body)).toContain("queued for retry");
  });

  it("none (missing time) → mint_status none with the reason, no job, no Pandora", async () => {
    const { outcome } = await mintLead({ ...L1061, eventTime: null }, {}, deps());
    expect(outcome).toEqual({ status: "none", error: NEEDS_EMAIL_OR_TIME });
    expect(bag.updates).toEqual([
      { id: "1061", patch: { mintStatus: "none", mintError: NEEDS_EMAIL_OR_TIME } },
    ]);
    expect(bag.enqueued).toHaveLength(0);
  });
});
