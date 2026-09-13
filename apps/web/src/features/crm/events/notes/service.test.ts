import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotesDeps } from "./service";

vi.mock("@/lib/redis", () => ({
  default: {
    get: async () => null,
    setex: async () => "OK",
    set: async () => "OK",
    on: () => undefined,
  },
}));

const {
  BmiWritesPausedError,
  appendPrivateNote,
  previewPublicNotes,
  privateNoteLine,
  readNotes,
  saveFoodOut,
  savePublicNotes,
  sendWaiverLinks,
} = await import("./service");

/**
 * The two write rails (R6) and the three promises made about them:
 *   R2 — the rep's text is in `crm_activities` BEFORE Office is called
 *   R5 — a 200 is not proof; the public save re-reads and compares
 *   R4 — the director's kill switch refuses the write, it does not "succeed"
 * Plus: the preview NEVER writes.
 */

const PRIVATE_MEMO =
  "Host wants the cake table by the mezzanine.\n\n" +
  "----- Portal Staff -----\nFood Out: 4:45 PM\n\n" +
  "── FastTrax Web ──\nContract: https://headpinz.com/contract/7Hx2Qk\n── End FastTrax Web ──";

interface Trace {
  order: string[];
  activities: Array<{ kind: string; outcome?: string | null; body?: string | null }>;
  audits: Array<{ action: string; actorEmail: string }>;
  publicWrites: string[];
  privateWrites: string[];
}

let trace: Trace;
let publicMemo: string;
let appendOk: boolean;
let writesSetting: unknown;

function deps(over: Partial<NotesDeps> = {}): NotesDeps {
  return {
    readProject: async () => {
      trace.order.push("read");
      return {
        id: 58454078,
        logs: [
          { id: 1, public: false, kind: 1, memo: PRIVATE_MEMO },
          { id: 2, public: true, kind: 1, memo: publicMemo },
        ],
      };
    },
    updatePublic: async ({ notes }) => {
      trace.order.push("office-public");
      trace.publicWrites.push(notes);
      publicMemo = notes;
    },
    appendPrivate: async ({ note }) => {
      trace.order.push("office-private");
      trace.privateWrites.push(note);
      return appendOk;
    },
    cleanup: async (text: string) =>
      text
        .replace(/\bi\b/g, "I")
        .replace(/\s{2,}/g, " ")
        .trim(),
    cleanupAvailable: () => true,
    saveFoodOut: async ({ foodOutTime }) => {
      trace.order.push("food-out");
      return {
        foodOutTime,
        foodOutSource: "manual" as const,
        foodOutConfidence: "high",
        foodOutReasoning: null,
        metadata: {},
        updatedAt: "2026-09-12T12:00:00.000Z",
      };
    },
    getEventMetadata: async () => ({
      foodOutTime: "4:45 PM",
      foodOutSource: "ai" as const,
      foodOutConfidence: "0.82",
      foodOutReasoning: "pizza after racing",
      metadata: {},
      updatedAt: "2026-09-12T12:00:00.000Z",
    }),
    getQuote: async () => null,
    waiverLinks: async () => ({ organizerUrl: "https://hp/o/1", signUrl: "https://hp/s/1" }),
    notifyWaiver: async () => {
      trace.order.push("notify-waiver");
    },
    listTimeline: async () => ({
      activities: [
        {
          id: "9",
          leadId: "1048",
          contactId: null,
          repId: null,
          actorEmail: "kelsea@headpinz.com",
          kind: "note" as const,
          direction: null,
          occurredAt: "2026-09-11T15:00:00.000Z",
          durationSeconds: null,
          outcome: null,
          subject: null,
          body: "Mum called back",
          externalKind: null,
          externalRef: null,
          meta: null,
        },
        {
          id: "8",
          leadId: "1048",
          contactId: null,
          repId: null,
          actorEmail: null,
          kind: "assign" as const,
          direction: null,
          occurredAt: "2026-09-10T15:00:00.000Z",
          durationSeconds: null,
          outcome: null,
          subject: null,
          body: null,
          externalKind: null,
          externalRef: null,
          meta: null,
        },
      ],
      nextCursor: null,
    }),
    recordActivity: async (a) => {
      trace.order.push(`neon-${a.kind}`);
      trace.activities.push({ kind: a.kind, outcome: a.outcome ?? null, body: a.body ?? null });
      return "1";
    },
    writeAudit: async (e) => {
      trace.audits.push({ action: e.action, actorEmail: e.actorEmail });
    },
    getSettingValue: async () => writesSetting,
    now: () => new Date("2026-09-12T16:00:00.000Z"),
    ...over,
  };
}

const TARGET = {
  centre: "HPFM" as const,
  projectId: "58454078",
  leadId: "1048",
  date: "2026-09-19",
};

beforeEach(() => {
  trace = { order: [], activities: [], audits: [], publicWrites: [], privateWrites: [] };
  publicMemo = "Arrive 15 minutes early.";
  appendOk = true;
  writesSetting = undefined; // NO ROW = writes enabled (R4)
});

describe("readNotes", () => {
  it("splits the private memo, keeps the public text, and lists only CRM notes", async () => {
    const body = await readNotes(TARGET, deps());
    expect(body.publicNotes).toBe("Arrive 15 minutes early.");
    expect(body.sections.map((s) => s.key)).toEqual(["staff", "web", "portal"]);
    expect(body.crmNotes).toHaveLength(1);
    expect(body.crmNotes[0].body).toBe("Mum called back");
    expect(body.writesEnabled).toBe(true);
    expect(trace.order).not.toContain("office-public");
  });

  it("shows BMI's own food-out line with our provenance", async () => {
    const body = await readNotes(TARGET, deps());
    expect(body.foodOut.time).toBe("4:45 PM");
    expect(body.foodOut.source).toBe("ai");
    expect(body.foodOut.confidence).toBe("0.82");
  });

  it("reports the kill switch rather than hiding it", async () => {
    writesSetting = { enabled: false };
    expect((await readNotes(TARGET, deps())).writesEnabled).toBe(false);
  });
});

describe("previewPublicNotes", () => {
  it("returns the cleaned text and writes NOTHING", async () => {
    const d = deps();
    const out = await previewPublicNotes("please arrive early  and i will meet you", d);
    expect(out.original).toBe("please arrive early  and i will meet you");
    expect(out.cleaned).toBe("please arrive early and I will meet you");
    expect(out.changed).toBe(true);
    expect(out.available).toBe(true);
    expect(trace.publicWrites).toEqual([]);
    expect(trace.order).toEqual([]);
  });

  it("says so when the AI gateway key is absent — the text comes back untouched", async () => {
    const out = await previewPublicNotes(
      "i will meet you",
      deps({ cleanupAvailable: () => false }),
    );
    expect(out.available).toBe(false);
    expect(out.cleaned).toBe("i will meet you");
    expect(out.changed).toBe(false);
  });
});

describe("savePublicNotes", () => {
  it("cleans, writes Neon BEFORE Office, then proves the write by a re-read", async () => {
    const out = await savePublicNotes(
      { ...TARGET, notes: "i will meet you at  the desk", clean: true, actor: "eric@headpinz.com" },
      deps(),
    );
    expect(out.publicNotes).toBe("I will meet you at the desk");
    expect(out.cleaned).toBe(true);
    expect(out.verified).toBe(true);

    // R2: the note row exists before the Office call.
    const neonAt = trace.order.indexOf("neon-note");
    const officeAt = trace.order.indexOf("office-public");
    expect(neonAt).toBeGreaterThanOrEqual(0);
    expect(neonAt).toBeLessThan(officeAt);
    // R5: a read AFTER the write is what decides `verified`.
    expect(trace.order.lastIndexOf("read")).toBeGreaterThan(officeAt);
    expect(trace.audits).toEqual([{ action: "public_notes", actorEmail: "eric@headpinz.com" }]);
  });

  it("a write that did not land comes back verified:false, not a green toast", async () => {
    const out = await savePublicNotes(
      { ...TARGET, notes: "new text", clean: false, actor: "eric@headpinz.com" },
      // Pandora's classic lie: 200, and the memo never changed.
      deps({
        updatePublic: async () => {
          trace.order.push("office-public");
        },
      }),
    );
    expect(out.verified).toBe(false);
    expect(trace.activities.map((a) => a.outcome)).toContain("public_notes_unverified");
  });

  it("clean:false writes the rep's text verbatim", async () => {
    const out = await savePublicNotes(
      { ...TARGET, notes: "i meant it  like this", clean: false, actor: "eric@headpinz.com" },
      deps(),
    );
    expect(out.publicNotes).toBe("i meant it  like this");
    expect(out.cleaned).toBe(false);
    expect(trace.publicWrites).toEqual(["i meant it  like this"]);
  });

  it("REFUSES when the director has paused BMI writes — nothing reaches Office", async () => {
    writesSetting = { enabled: false };
    await expect(
      savePublicNotes({ ...TARGET, notes: "x", clean: false, actor: "eric@headpinz.com" }, deps()),
    ).rejects.toBeInstanceOf(BmiWritesPausedError);
    expect(trace.publicWrites).toEqual([]);
    expect(trace.order).not.toContain("neon-note");
  });

  it("a pause on the OTHER tenant leaves this one writing", async () => {
    writesSetting = { enabled: true, offCentres: ["headpinznaples"] };
    await expect(
      savePublicNotes({ ...TARGET, notes: "x", clean: false, actor: "e@h.com" }, deps()),
    ).resolves.toMatchObject({ verified: true });
  });
});

describe("appendPrivateNote", () => {
  it("stamps and attributes the line, writes Neon first, and returns the re-parsed sections", async () => {
    const out = await appendPrivateNote(
      { ...TARGET, note: "  Mum wants the cake at 5  ", actor: "kelsea@headpinz.com" },
      deps(),
    );
    expect(out.appended).toBe(true);
    expect(out.sections.map((s) => s.key)).toEqual(["staff", "web", "portal"]);
    expect(trace.privateWrites[0]).toMatch(/Mum wants the cake at 5 — kelsea@headpinz\.com$/);
    expect(trace.privateWrites[0]).toMatch(/^\[.+\] /);
    expect(trace.order.indexOf("neon-note")).toBeLessThan(trace.order.indexOf("office-private"));
  });

  it("a BMI refusal is reported, and the note still exists on the timeline", async () => {
    appendOk = false;
    const out = await appendPrivateNote({ ...TARGET, note: "x", actor: "k@h.com" }, deps());
    expect(out.appended).toBe(false);
    expect(trace.activities[0]).toMatchObject({ kind: "note", body: "x" });
    expect(trace.activities.map((a) => a.outcome)).toContain("private_note_failed");
  });

  it("is refused by the kill switch before anything is written", async () => {
    writesSetting = { enabled: false };
    await expect(
      appendPrivateNote({ ...TARGET, note: "x", actor: "k@h.com" }, deps()),
    ).rejects.toBeInstanceOf(BmiWritesPausedError);
    expect(trace.privateWrites).toEqual([]);
  });

  it("privateNoteLine is the shape the desk reads", () => {
    expect(privateNoteLine("  hello  ", "eric@headpinz.com", "Sep 12, 2026 12:00 PM")).toBe(
      "[Sep 12, 2026 12:00 PM] hello — eric@headpinz.com",
    );
  });
});

describe("saveFoodOut", () => {
  it("goes through saveManualFoodOut (which syncs the Portal Staff section) and audits it", async () => {
    const out = await saveFoodOut({ ...TARGET, foodOutTime: "5:30 PM", actor: "e@h.com" }, deps());
    expect(out).toMatchObject({ time: "5:30 PM", source: "manual" });
    expect(trace.order).toContain("food-out");
    expect(trace.audits).toEqual([{ action: "food_out", actorEmail: "e@h.com" }]);
    expect(trace.activities.map((a) => a.outcome)).toContain("food_out_set");
  });

  it("null clears it, and the kill switch refuses", async () => {
    await expect(
      saveFoodOut({ ...TARGET, foodOutTime: null, actor: "e@h.com" }, deps()),
    ).resolves.toMatchObject({ time: null });
    writesSetting = { enabled: false };
    await expect(
      saveFoodOut({ ...TARGET, foodOutTime: "5:30 PM", actor: "e@h.com" }, deps()),
    ).rejects.toBeInstanceOf(BmiWritesPausedError);
  });
});

describe("sendWaiverLinks", () => {
  it("with no contract row it mints the links to copy and sends nothing", async () => {
    const out = await sendWaiverLinks({ ...TARGET, actor: "e@h.com" }, deps());
    expect(out).toMatchObject({ sent: false, reason: "no_contract" });
    expect(out.organizerUrl).toBe("https://hp/o/1");
    expect(trace.order).not.toContain("notify-waiver");
  });

  it("a contract with no waiver products is not a send either", async () => {
    const out = await sendWaiverLinks(
      { ...TARGET, actor: "e@h.com" },
      deps({
        getQuote: async () => ({ line_items: [{ name: "Pizza & Wings Buffet" }] }) as never,
      }),
    );
    expect(out).toMatchObject({ sent: false, reason: "no_waiver_products" });
  });

  it("racing on the event sends through the EXISTING waiver-reminder rail", async () => {
    const out = await sendWaiverLinks(
      { ...TARGET, actor: "e@h.com" },
      deps({
        getQuote: async () => ({ line_items: [{ name: "Racing — 2 heats" }] }) as never,
      }),
    );
    expect(out).toMatchObject({ sent: true, reason: null });
    expect(trace.order).toContain("notify-waiver");
    expect(trace.activities.map((a) => a.outcome)).toContain("waiver_link_sent");
  });
});
