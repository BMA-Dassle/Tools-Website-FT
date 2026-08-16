import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const office = { fetchOfficePerson: vi.fn<(id: string, ck?: string) => Promise<unknown>>() };
vi.mock("@/lib/bmi-office-actions", () => ({
  fetchOfficePerson: (...a: unknown[]) =>
    (office.fetchOfficePerson as (...a: unknown[]) => unknown)(...a),
}));

import { personLocalBarrier, personCloudBarrier, projectLocalBarrier } from "../bmi-sync-barriers";

const reply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SWAGGER_ADMIN_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── the rule the whole cloud-first design rests on ──────────────────────────
// Measured live 2026-08-12: a cloud-minted person answers 500 "Response
// Validator Error" while its birthdate is null — it IS present locally. Only a
// 404 means absent. A barrier that waited for 200 would wait forever on a row
// that had already landed (and would starve the repair handler that fixes the
// very 500 it is looking at).
describe("personLocalBarrier — 404 vs 500 vs 200", () => {
  it("404 is the ONLY absent verdict → closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(404, { success: false, message: "No person found with that ID." })),
    );
    const r = await personLocalBarrier("LAB52GY480CJF", "63000000009999999");
    expect(r.verdict).toBe("closed");
    expect(r.detail).toMatch(/404/);
  });

  /**
   * 2026-08-12: a `push-waiver-signature` row for Nadine Poeter (person
   * …8163542) was aimed at Naples, but that person was minted at FORT MYERS —
   * 200 there, 404 at Naples. BMI person ids do not cross centers, so the
   * barrier would have sat "closed: not on the local server yet" until its
   * 02:43 give-up, describing a data mismatch as slow sync.
   */
  it("404 HERE but present on ANOTHER SERVER → impossible, not closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("LAB52GY480CJF")
          ? reply(200, { success: true, data: { id: "63000000008163542" } })
          : reply(404, { success: false, message: "No person found with that ID." }),
      ),
    );
    const r = await personLocalBarrier("PPTR5G2N0QXF7", "63000000008163542");
    expect(r.verdict).toBe("impossible");
    expect(r.detail).toContain("Fort Myers");
    expect(r.detail).toMatch(/never sync/i);
  });

  /**
   * THE 2026-08-15 PRODUCTION BUG, pinned.
   *
   * FastTrax and HeadPinz Fort Myers are two location ids on ONE server, so a
   * FastTrax-aimed row that 404s can never legitimately be told "they are at
   * HeadPinz Fort Myers" — that is the same box answering under its other name
   * after a transient miss. The old code re-probed it and issued `impossible`,
   * which parked all five `add-membership` rows (bought racing licences, never
   * granted) at attempts=0 and settled waiver pushes `failed` for guests who
   * were sitting right there.
   *
   * The only correct verdict is `closed`: keep waiting.
   */
  it("FT ≡ FM: a 404 at FastTrax is NEVER 'they are at Fort Myers'", async () => {
    const f = vi.fn(async (url: string) =>
      url.includes("TXBSQN0FEKQ11")
        ? reply(200, { success: true, data: { id: "63000000008485469" } })
        : reply(404, { success: false, message: "No person found with that ID." }),
    );
    vi.stubGlobal("fetch", f);
    const r = await personLocalBarrier("LAB52GY480CJF", "63000000008485469");
    expect(r.verdict).toBe("closed");
    expect(r.detail).toMatch(/not on the local server yet/i);
    // And it must not have wasted a probe on its own server's other name.
    expect(f.mock.calls.every(([u]) => !String(u).includes("TXBSQN0FEKQ11"))).toBe(true);
  });

  /** ...and the mirror: a Fort Myers-aimed row is never "they are at FastTrax". */
  it("FT ≡ FM: a 404 at Fort Myers is NEVER 'they are at FastTrax'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("LAB52GY480CJF")
          ? reply(200, { success: true, data: { id: "63000000008534718" } })
          : reply(404, { success: false, message: "No person found with that ID." }),
      ),
    );
    const r = await personLocalBarrier("TXBSQN0FEKQ11", "63000000008534718");
    expect(r.verdict).toBe("closed");
  });

  /**
   * A terminal verdict may not rest on ONE read. `impossible` parks a row for a
   * human and settles a waiver `failed`, and Pandora hands out transient 404s —
   * out-waiting them is the whole reason this queue exists. So re-confirm the
   * absence before condemning the row.
   */
  it("re-reads before parking: present on the second look → open, not impossible", async () => {
    let aimedCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("PPTR5G2N0QXF7")) {
          aimedCalls += 1;
          // First look: a transient miss. Re-read: there all along.
          return aimedCalls === 1
            ? reply(404, { success: false, message: "No person found with that ID." })
            : reply(200, { success: true, data: { id: "17618396" } });
        }
        return reply(200, { success: true, data: { id: "17618396" } });
      }),
    );
    const r = await personLocalBarrier("PPTR5G2N0QXF7", "17618396");
    expect(r.verdict).toBe("open");
    expect(r.detail).toMatch(/transient/i);
    expect(aimedCalls).toBe(2);
  });

  /** If the re-read gets no answer we learned nothing about the guest — that is a
   *  statement about the vendor, so it must not burn the row's patience. */
  it("re-read that cannot reach the vendor is unreachable, not impossible", async () => {
    let aimedCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("PPTR5G2N0QXF7")) {
          aimedCalls += 1;
          if (aimedCalls === 1) return reply(404, { success: false });
          throw new Error("ETIMEDOUT");
        }
        return reply(200, { success: true, data: { id: "x" } });
      }),
    );
    const r = await personLocalBarrier("PPTR5G2N0QXF7", "x");
    expect(r.verdict).toBe("error");
    expect(r.unreachable).toBe(true);
  });

  it("404 everywhere stays CLOSED — a fresh mint has simply not landed yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(404, { success: false, message: "No person found with that ID." })),
    );
    const r = await personLocalBarrier("PPTR5G2N0QXF7", "63000000008999999");
    expect(r.verdict).toBe("closed");
  });

  /** A 500 elsewhere still means the record EXISTS there (the 404-vs-500 rule
   *  applies to the cross-center probe too). */
  it("a 500 at another center also proves residence → impossible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("LAB52GY480CJF")
          ? reply(500, { success: false, error: "Response Validator Error" })
          : reply(404, { success: false, message: "No person found with that ID." }),
      ),
    );
    const r = await personLocalBarrier("PPTR5G2N0QXF7", "63000000008163542");
    expect(r.verdict).toBe("impossible");
    expect(r.detail).toContain("FastTrax");
  });

  it("500 Response Validator Error is PRESENT → open (so the repair handler can run)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(500, { success: false, error: "Response Validator Error" })),
    );
    const r = await personLocalBarrier("LAB52GY480CJF", "63000000008158427");
    expect(r.verdict).toBe("open");
    expect(r.detail).toMatch(/birthdate null/i);
  });

  it("200 → open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { success: true, data: { id: "1" } })),
    );
    expect((await personLocalBarrier("LAB52GY480CJF", "1")).verdict).toBe("open");
  });

  it("other failures are 'error' (could not ask), never a false 'open'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(503)),
    );
    expect((await personLocalBarrier("LAB52GY480CJF", "1")).verdict).toBe("error");
  });

  it("a network throw is 'error', not 'open'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ECONNRESET"))),
    );
    const r = await personLocalBarrier("LAB52GY480CJF", "1");
    expect(r.verdict).toBe("error");
    expect(r.detail).toMatch(/ECONNRESET/);
  });

  it("missing creds is 'error' — never assume visibility", async () => {
    delete process.env.SWAGGER_ADMIN_KEY;
    expect((await personLocalBarrier("LAB52GY480CJF", "1")).verdict).toBe("error");
  });
});

describe("personCloudBarrier (local→cloud, the jam-prone direction)", () => {
  it("opens when the Office person resolves", async () => {
    office.fetchOfficePerson.mockResolvedValueOnce({ id: "63000000008163503" });
    expect((await personCloudBarrier("63000000008163503")).verdict).toBe("open");
  });
  it("closes when it does not (not synced up yet, or Office unwell — both mean wait)", async () => {
    office.fetchOfficePerson.mockResolvedValueOnce(null);
    expect((await personCloudBarrier("63000000008163503")).verdict).toBe("closed");
  });
  it("forwards the clientKey", async () => {
    office.fetchOfficePerson.mockResolvedValueOnce({ id: "x" });
    await personCloudBarrier("x", "headpinznaples");
    expect(office.fetchOfficePerson).toHaveBeenCalledWith("x", "headpinznaples");
  });
});

describe("projectLocalBarrier (cloud→local reservation sync)", () => {
  it("404 → closed (not synced down yet)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(404, { success: false })),
    );
    expect((await projectLocalBarrier("LAB52GY480CJF", "63000000008065144")).verdict).toBe(
      "closed",
    );
  });
  it("200 + success:true → open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { success: true, data: {} })),
    );
    expect((await projectLocalBarrier("LAB52GY480CJF", "63000000008065144")).verdict).toBe("open");
  });
  it("200 with success:false → closed, NOT open (the 200-is-not-success trap)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(200, { success: false })),
    );
    const r = await projectLocalBarrier("LAB52GY480CJF", "63000000008065144");
    expect(r.verdict).toBe("closed");
  });
  it("5xx → error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(500, {})),
    );
    expect((await projectLocalBarrier("LAB52GY480CJF", "1")).verdict).toBe("error");
  });
});

// ── partyReadyBarrier — the gate on the Confirmation Kiosk/Express flip ──────
// Owner 2026-08-12: the flip "should happen only when the rest of the party has
// sync'ed and we have verified all have the waivers". Staff read that state as
// "party is here and checked in", so it must never be stamped on a maybe. Note
// the deliberate asymmetry with personLocalBarrier: there a 500 is OPEN (present
// but unreadable is what the repair fixes); HERE a 500 is closed, because an
// unreadable record cannot prove a waiver and proving one is the whole job.
import { partyReadyBarrier } from "../bmi-sync-barriers";

const person = (waiverExpiry: string | null, status = 200) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({ success: status === 200, data: { waiverExpiry } }),
    text: async () => "",
  }) as unknown as Response;

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

describe("partyReadyBarrier", () => {
  beforeEach(() => {
    process.env.SWAGGER_ADMIN_KEY = "k";
  });

  it("opens only when EVERY member is local with a live waiver", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => person(future)),
    );
    const r = await partyReadyBarrier("LAB52GY480CJF", ["1", "2", "3"]);
    expect(r.verdict).toBe("open");
    expect(r.detail).toContain("3");
  });

  it("one member not yet synced closes the gate", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++n === 2 ? person(null, 404) : person(future))),
    );
    const r = await partyReadyBarrier("LAB52GY480CJF", ["1", "2", "3"]);
    expect(r.verdict).toBe("closed");
    expect(r.detail).toMatch(/not synced local/);
  });

  it("one member without a waiver closes the gate — the state would be a false claim", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++n === 3 ? person(null) : person(future))),
    );
    const r = await partyReadyBarrier("LAB52GY480CJF", ["1", "2", "3"]);
    expect(r.verdict).toBe("closed");
    expect(r.detail).toMatch(/without a valid waiver/);
  });

  it("an EXPIRED waiver is not a waiver", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => person(past)),
    );
    expect((await partyReadyBarrier("LAB52GY480CJF", ["1"])).verdict).toBe("closed");
  });

  it("a 500 (present but unreadable) closes HERE, unlike personLocalBarrier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => person(null, 500)),
    );
    const r = await partyReadyBarrier("LAB52GY480CJF", ["1"]);
    expect(r.verdict).toBe("closed");
    expect(r.detail).toMatch(/unreadable/);
  });

  it("an empty party list closes — stamping on nothing is the false claim we are preventing", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await partyReadyBarrier("LAB52GY480CJF", []);
    expect(r.verdict).toBe("closed");
    expect(f).not.toHaveBeenCalled();
  });

  it("dedupes members so one person on two rows is asked about once", async () => {
    const f = vi.fn(async () => person(future));
    vi.stubGlobal("fetch", f);
    await partyReadyBarrier("LAB52GY480CJF", ["7", "7", "7"]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

import { personsLocalBarrier } from "../bmi-sync-barriers";

/**
 * The guardian-signed waiver barrier (owner 2026-08-13: "with minors, we need to
 * make sure we wait for adult to end up local").
 *
 * Pandora's waiver write names BOTH the minor (`personID`) and the signing adult
 * (`sigPersonID`) and needs both resolvable locally. A family arriving together
 * has parent and child cloud-minted seconds apart, so barriering on the minor
 * alone let the write fire naming a signer the local server could not resolve.
 */
describe("personsLocalBarrier — every named person must be local", () => {
  const found = () => reply(200, { success: true, data: { waiverExpiry: null } });
  const absent = () => reply(404, { success: false, message: "No person found with that ID." });

  it("opens only when EVERY person is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => found()),
    );
    const r = await personsLocalBarrier("LAB52GY480CJF", ["minor-1", "guardian-1"]);
    expect(r.verdict).toBe("open");
    expect(r.detail).toMatch(/all 2/);
  });

  it("stays CLOSED when the guardian has not landed yet, and names them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (String(url).includes("guardian-1") ? absent() : found())),
    );
    const r = await personsLocalBarrier("LAB52GY480CJF", ["minor-1", "guardian-1"], {
      diagnoseElsewhere: false,
    });
    expect(r.verdict).toBe("closed");
    expect(r.detail).toContain("guardian-1");
    expect(r.detail).not.toContain("minor-1");
  });

  it("stays CLOSED when the MINOR has not landed but the guardian has", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (String(url).includes("minor-1") ? absent() : found())),
    );
    const r = await personsLocalBarrier("LAB52GY480CJF", ["minor-1", "guardian-1"], {
      diagnoseElsewhere: false,
    });
    expect(r.verdict).toBe("closed");
    expect(r.detail).toContain("minor-1");
  });

  /**
   * `impossible` outranks `closed`: one person who can never appear at this
   * center makes the row futile no matter how the others read, and parking it now
   * beats waiting out a give-up window that cannot help.
   */
  it("impossible on ONE person outranks closed on another", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        // The guardian lives at Naples: 404 at the target, present elsewhere.
        if (u.includes("guardian-1")) return u.includes("PPTR5G2N0QXF7") ? found() : absent();
        return absent(); // the minor is merely not synced yet
      }),
    );
    const r = await personsLocalBarrier("LAB52GY480CJF", ["minor-1", "guardian-1"]);
    expect(r.verdict).toBe("impossible");
    expect(r.detail).toContain("guardian-1");
  });

  it("a self-sign collapses to one lookup", async () => {
    const f = vi.fn(async () => found());
    vi.stubGlobal("fetch", f);
    const r = await personsLocalBarrier("LAB52GY480CJF", ["solo-1", "solo-1"]);
    expect(r.verdict).toBe("open");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("an empty list is CLOSED, never open — a waiver with no named person is a bug", async () => {
    const f = vi.fn(async () => found());
    vi.stubGlobal("fetch", f);
    const r = await personsLocalBarrier("LAB52GY480CJF", []);
    expect(r.verdict).toBe("closed");
    expect(f).not.toHaveBeenCalled();
  });
});

// ── "BMI is down" is not "this row is bad" ───────────────────────────────────
// 2026-08-13: Pandora accepted connections and never answered. Every delivery
// through the hung barrier counted as a failed attempt, so rows reached 19-22
// tries within the hour and Vercel Queue dropped them at 20 deliveries — with
// the guest's signature captured in Neon and never filed with BMI. Recovering
// them took a hand-written script.
//
// A verdict of `error` therefore has to answer a second question: did we LEARN
// anything about this person? If we never reached the vendor we did not, and
// the row must keep its patience — the give-up deadline (12h for a waiver) is
// what is meant to bound the wait, exactly as it does for a closed barrier.
describe("barrier `unreachable` — vendor down must not spend a row's patience", () => {
  it("a timeout is unreachable — we learned nothing about the person", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.reject(
          new DOMException("The operation was aborted due to timeout", "TimeoutError"),
        ),
      ),
    );
    const r = await personLocalBarrier("LAB52GY480CJF", "1");
    expect(r.verdict).toBe("error");
    expect(r.unreachable).toBe(true);
  });

  it.each([502, 503, 504])("HTTP %i is the vendor being unwell, not an answer", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(status)),
    );
    const r = await personLocalBarrier("LAB52GY480CJF", "1");
    expect(r.verdict).toBe("error");
    expect(r.unreachable).toBe(true);
  });

  it.each([400, 401, 403, 418])(
    "HTTP %i IS an answer about this row, so it still counts",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => reply(status)),
      );
      const r = await personLocalBarrier("LAB52GY480CJF", "1");
      expect(r.verdict).toBe("error");
      expect(r.unreachable).toBeFalsy();
    },
  );

  it("missing creds is OUR fault, not the vendor's — it counts", async () => {
    delete process.env.SWAGGER_ADMIN_KEY;
    const r = await personLocalBarrier("LAB52GY480CJF", "1");
    expect(r.verdict).toBe("error");
    expect(r.unreachable).toBeFalsy();
  });

  it("personsLocalBarrier carries `unreachable` through the aggregate", async () => {
    // The guardian-signed waiver path. Flattening the flag here would put the
    // two-person barrier straight back to burning attempts during an outage.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("connect ETIMEDOUT"))),
    );
    const r = await personsLocalBarrier("LAB52GY480CJF", ["minor-1", "guardian-1"], {
      diagnoseElsewhere: false,
    });
    expect(r.verdict).toBe("error");
    expect(r.unreachable).toBe(true);
  });

  it("a real 'error' answer from one person is NOT marked unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(403)),
    );
    const r = await personsLocalBarrier("LAB52GY480CJF", ["minor-1", "guardian-1"], {
      diagnoseElsewhere: false,
    });
    expect(r.verdict).toBe("error");
    expect(r.unreachable).toBeFalsy();
  });
});
