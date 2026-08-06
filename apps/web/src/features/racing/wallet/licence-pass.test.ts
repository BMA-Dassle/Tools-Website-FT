/**
 * Regression pins for the two ways a live racing licence lost its fields on
 * 2026-08-05. Both were invisible to tsc, eslint and the whole unit suite,
 * because both are about WHICH KEYS reach a PUT — not about types.
 *
 * `PUT /members/member` REPLACES metaData. Every test here exists to make that
 * one undocumented fact impossible to forget.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const passkit = vi.fn();
const getRacerPass = vi.fn();
const saveMeta = vi.fn();
const markPushed = vi.fn();
const recordRacerPass = vi.fn();

class FakePassKitError extends Error {
  constructor(readonly status: number) {
    super(`PassKit ${status}`);
  }
  get isDuplicate() {
    return this.status === 409;
  }
  get isNotFound() {
    return this.status === 404;
  }
}

vi.mock("~/lib/api/passkit", () => ({
  passkit: (...a: unknown[]) => passkit(...a),
  passUrls: (id: string) => ({ apple: `a/${id}`, google: `g/${id}`, landing: `l/${id}` }),
  isPassKitConfigured: () => true,
  PassKitError: FakePassKitError,
}));

vi.mock("~/features/racing/data/racer-wallet-db", () => ({
  getRacerPass: (...a: unknown[]) => getRacerPass(...a),
  getRacerPasses: vi.fn(),
  saveMeta: (...a: unknown[]) => saveMeta(...a),
  markPushed: (...a: unknown[]) => markPushed(...a),
  recordRacerPass: (...a: unknown[]) => recordRacerPass(...a),
}));

const { issueLicencePass, updateLicencePass } = await import("./licence-pass");

/** The shape a real pass carries — 13 keys. The template binds several of
 *  these directly, so a missing key renders as a blank field on the pass. */
const FULL_META = {
  code: "mgrm2g8o42wxc",
  memberName: "ERIC OSBORN",
  memberQr: "https://smstim.in/908/authenticate/?login_code=mgrm2g8o42wxc",
  licenceUrl: "https://headpinz.com/r/mgrm2g8o42wxc",
  tier: "Pro",
  races: "31",
  validUntil: "Oct 31st, 2026",
  waiver: "Signed · Jan 16th, 2027",
  lastVisit: "Aug 5th, 2026",
  nextRace: "Aug 5 · 10:12 PM · Red",
  nextRaceLong: "Wednesday, Aug 5 · 10:12 PM · Red · Heat 57",
  raceLabel: "Heat 57",
  checkinStatus: "Not checking in yet",
};

const putBody = () => {
  const call = passkit.mock.calls.find((c) => c[0] === "PUT");
  return call?.[2] as { id: string; metaData: Record<string, string> } | undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PASSKIT_SYNC;
});

describe("issueLicencePass — re-tap on an existing pass", () => {
  it("MERGES over stored meta instead of replacing it", async () => {
    // The caller (`/r/{code}/wallet`) knows the racer's identity but NOT their
    // heat, so it supplies a deliberate SUBSET.
    const callerMeta = {
      code: "mgrm2g8o42wxc",
      memberName: "ERIC OSBORN",
      memberQr: FULL_META.memberQr,
      licenceUrl: FULL_META.licenceUrl,
      tier: "Pro",
      races: "31",
    };

    passkit.mockImplementation(async (method: string) => {
      if (method === "POST") throw new FakePassKitError(409); // already a member
      if (method === "GET") return { id: "MEMBER1" };
      return {};
    });
    getRacerPass.mockResolvedValue({ memberId: "MEMBER1", meta: { ...FULL_META } });

    const res = await issueLicencePass({ personId: "409523", meta: callerMeta });
    expect(res.ok).toBe(true);

    const body = putBody();
    expect(body).toBeDefined();
    // The five keys the caller never sends must SURVIVE the re-tap. Sending
    // callerMeta bare deleted exactly these from a live pass.
    expect(body!.metaData.raceLabel).toBe("Heat 57");
    expect(body!.metaData.nextRaceLong).toBe(FULL_META.nextRaceLong);
    expect(body!.metaData.validUntil).toBe("Oct 31st, 2026");
    expect(body!.metaData.waiver).toBe("Signed · Jan 16th, 2027");
    expect(body!.metaData.lastVisit).toBe("Aug 5th, 2026");
    // …and the barcode source, which is what stops the pass scanning at all.
    expect(body!.metaData.code).toBe("mgrm2g8o42wxc");
    expect(Object.keys(body!.metaData).length).toBe(Object.keys(FULL_META).length);
  });

  it("persists the MERGED meta, so the next cron push cannot re-truncate", async () => {
    passkit.mockImplementation(async (method: string) => {
      if (method === "POST") throw new FakePassKitError(409);
      if (method === "GET") return { id: "MEMBER1" };
      return {};
    });
    getRacerPass.mockResolvedValue({ memberId: "MEMBER1", meta: { ...FULL_META } });

    await issueLicencePass({
      personId: "409523",
      meta: {
        code: "mgrm2g8o42wxc",
        memberName: "ERIC OSBORN",
        memberQr: FULL_META.memberQr,
        licenceUrl: FULL_META.licenceUrl,
      },
    });

    const saved = saveMeta.mock.calls.at(-1)?.[1] as Record<string, string>;
    expect(saved.raceLabel).toBe("Heat 57");
    expect(saved.nextRaceLong).toBe(FULL_META.nextRaceLong);
  });
});

describe("updateLicencePass — the three renderings of one heat", () => {
  beforeEach(() => {
    passkit.mockResolvedValue({});
  });

  it("refreshes raceLabel and nextRaceLong alongside nextRace", async () => {
    getRacerPass.mockResolvedValue({
      memberId: "MEMBER1",
      nextRace: FULL_META.nextRace,
      checkinStatus: FULL_META.checkinStatus,
      meta: { ...FULL_META },
    });

    const ok = await updateLicencePass("409523", {
      nextRace: "Aug 5 · 10:48 PM · Red",
      raceLabel: "Heat 60",
      nextRaceLong: "Wednesday, Aug 5 · 10:48 PM · Red · Heat 60",
    });

    expect(ok).toBe(true);
    const body = putBody()!;
    // Previously only `nextRace` moved, leaving a pass that read 10:48 PM
    // beside "Heat 57" — a self-contradicting credential.
    expect(body.metaData.nextRace).toBe("Aug 5 · 10:48 PM · Red");
    expect(body.metaData.raceLabel).toBe("Heat 60");
    expect(body.metaData.nextRaceLong).toBe("Wednesday, Aug 5 · 10:48 PM · Red · Heat 60");
  });

  it("pushes when ONLY a meta-only field changed", async () => {
    // nextRace identical, heat number different — possible when a heat is
    // renumbered on the same slot. Must not be mistaken for "nothing to say".
    getRacerPass.mockResolvedValue({
      memberId: "MEMBER1",
      nextRace: FULL_META.nextRace,
      checkinStatus: FULL_META.checkinStatus,
      meta: { ...FULL_META },
    });

    const ok = await updateLicencePass("409523", {
      nextRace: FULL_META.nextRace,
      raceLabel: "Heat 61",
    });

    expect(ok).toBe(true);
    expect(putBody()!.metaData.raceLabel).toBe("Heat 61");
  });

  it("still no-ops when nothing at all changed", async () => {
    getRacerPass.mockResolvedValue({
      memberId: "MEMBER1",
      nextRace: FULL_META.nextRace,
      checkinStatus: FULL_META.checkinStatus,
      meta: { ...FULL_META },
    });

    const ok = await updateLicencePass("409523", {
      nextRace: FULL_META.nextRace,
      raceLabel: FULL_META.raceLabel,
      nextRaceLong: FULL_META.nextRaceLong,
    });

    expect(ok).toBe(false);
    expect(passkit).not.toHaveBeenCalled();
  });

  it("refuses to push at all when there is no stored meta", async () => {
    getRacerPass.mockResolvedValue({ memberId: "MEMBER1", nextRace: "old", meta: null });

    const ok = await updateLicencePass("409523", { nextRace: "new", raceLabel: "Heat 60" });

    expect(ok).toBe(false);
    expect(passkit).not.toHaveBeenCalled();
  });
});
