/**
 * `pandoraOnboardGuest` must not mint a person twice for the same human.
 *
 * The 2026-08-12 HeadPinz Naples incident, as tests. Mattis Poeter (age 6) ended
 * up with FIVE BMI person records and no waiver:
 *
 *   …906317  dob 2019-08-16   ┐
 *   …906319  dob 2019-08-16   ├ byte-identical input, three separate records
 *   …906321  dob 2019-08-16   ┘
 *   …907988  dob 2018-08-16   ┐ the guest "corrected" the birth YEAR and
 *   …908989  dob 2018-08-16   ┘ resubmitted, minting two more
 *
 * Cause: Naples' BMI waiver templates start at age 8, so the age-6 template
 * lookup 404'd AFTER the mint had already succeeded. The guest saw a generic
 * error, retried, and step 1 minted again. Under cloud-first the Office create
 * never resolves an existing record, so every retry is a guaranteed duplicate.
 *
 * Two properties are locked in here: a retry reuses the minted id, and a retry
 * carrying a corrected birthdate PATCHES that record instead of minting a twin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls = { create: 0, patch: [] as unknown[], template: 0 };

/** One fresh module instance per test — the memo is module-level state, and a
 *  leaked entry would make these tests pass for the wrong reason. */
async function freshModule() {
  vi.resetModules();
  return import("../pandora");
}

beforeEach(() => {
  calls.create = 0;
  calls.patch = [];
  calls.template = 0;
  let nextId = 906317;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      if (url.startsWith("/api/pandora") && method === "POST") {
        calls.create++;
        // Cloud mint: a NEW id every time, which is the whole hazard.
        return new Response(
          JSON.stringify({ personId: `63000000000${nextId++}`, rail: "office-cloud" }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/pandora") && method === "PATCH") {
        calls.patch.push(JSON.parse((init as { body: string }).body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/waiver/template") || url.includes("/api/pandora/waiver?")) {
        calls.template++;
        // Naples for a 6-year-old: no template exists.
        if (url.includes("age=6")) {
          return new Response(JSON.stringify({ error: "No waiver template found" }), {
            status: 404,
          });
        }
        return new Response(
          JSON.stringify({ id: "1", contentID: "5958734", name: "Minor", duration: 1, body: "x" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/**
 * A birthdate that is ALWAYS exactly `age` today.
 *
 * The ages are what this file is about — Naples' waiver templates start at 8, so
 * only an under-8 guest reproduces the 404-after-mint that created five records.
 * The dates were hardcoded 2019-08-16 / 2018-08-16 to mean 6 and 7, and on
 * 2026-08-16 Mattis's birthday came round: he read as 7, the age-6 lookup found a
 * template, the mint never failed, and the test went red for the calendar rather
 * than for the code. Derive the dates so the case under test outlives the year.
 * (One day back, so "birthday today" can never round down on any clock.)
 */
function dobForAge(age: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear() - age, now.getUTCMonth(), now.getUTCDate() - 1))
    .toISOString()
    .slice(0, 10);
}

/** Under Naples' age-8 template floor: the lookup 404s after the mint. */
const DOB_NO_TEMPLATE = dobForAge(6);
/** The guest's "corrected" birth year — still under 8, as in the real incident. */
const DOB_CORRECTED = dobForAge(7);

const mattis = {
  firstName: "Mattis",
  lastName: "Poeter",
  birthdate: DOB_NO_TEMPLATE, // age 6 — no Naples template
};

describe("pandoraOnboardGuest — one human, one person record", () => {
  it("a retry after the template 404 reuses the minted id (was: 3 records)", async () => {
    const { pandoraOnboardGuest } = await freshModule();

    const first = await pandoraOnboardGuest(mattis, "naples").catch((e) => e as Error);
    expect(first).toBeInstanceOf(Error);
    expect(calls.create).toBe(1);

    // Guest taps "try again" twice more with the SAME data.
    await pandoraOnboardGuest(mattis, "naples").catch(() => null);
    await pandoraOnboardGuest(mattis, "naples").catch(() => null);

    // The mint happened ONCE. Before the memo this was three person records.
    expect(calls.create).toBe(1);
  });

  it("a corrected birthdate PATCHES the record instead of minting a twin", async () => {
    const { pandoraOnboardGuest } = await freshModule();

    await pandoraOnboardGuest(mattis, "naples").catch(() => null);
    expect(calls.create).toBe(1);

    // The guest changes the birth YEAR (exactly what happened: 2019 → 2018).
    await pandoraOnboardGuest({ ...mattis, birthdate: DOB_CORRECTED }, "naples").catch(() => null);

    expect(calls.create).toBe(1);
    expect(calls.patch).toHaveLength(1);
    expect(calls.patch[0]).toMatchObject({
      personId: "63000000000906317",
      birthdate: DOB_CORRECTED,
    });
  });

  it("different people still get their own records", async () => {
    const { pandoraOnboardGuest } = await freshModule();
    await pandoraOnboardGuest({ ...mattis, firstName: "Jonah", birthdate: "2016-06-01" }, "naples");
    await pandoraOnboardGuest({ ...mattis, firstName: "Marco", birthdate: "1979-10-05" }, "naples");
    expect(calls.create).toBe(2);
  });

  it("the same name at a DIFFERENT center is a different record", async () => {
    const { pandoraOnboardGuest } = await freshModule();
    await pandoraOnboardGuest({ ...mattis, birthdate: "2016-06-01" }, "naples");
    await pandoraOnboardGuest({ ...mattis, birthdate: "2016-06-01" }, "fasttrax");
    expect(calls.create).toBe(2);
  });

  it("name matching ignores case and stray spaces", async () => {
    const { pandoraOnboardGuest } = await freshModule();
    await pandoraOnboardGuest({ ...mattis, birthdate: "2016-06-01" }, "naples");
    await pandoraOnboardGuest(
      { firstName: " mattis ", lastName: "POETER", birthdate: "2016-06-01" },
      "naples",
    );
    expect(calls.create).toBe(1);
  });

  /**
   * Cloud-first mints in the vendor CLOUD; `pandoraCheckWaiver` reads the
   * center's LOCAL server, where the record does not exist for ~10-32s. Reading
   * it can only fail, and a fresh record has nothing to refresh from anyway.
   */
  it("does NOT read Pandora local for a person the cloud just minted", async () => {
    const { pandoraOnboardGuest } = await freshModule();
    const r = await pandoraOnboardGuest({ ...mattis, birthdate: "2016-06-01" }, "naples");
    expect(r.personId).toBe("63000000000906317");
    // Typed values are carried through untouched.
    expect(r.firstName).toBe("Mattis");
    expect(r.birthdate).toBe("2016-06-01");
    expect(r.waiverValid).toBe(false);
  });
});

describe("waiver template 404 says what is wrong", () => {
  it("names the age and points at the desk, in EN and ES", async () => {
    const { pandoraFetchWaiverTemplate } = await freshModule();
    const en = await pandoraFetchWaiverTemplate(6, "naples", "en").catch((e) => e as Error);
    expect((en as Error).message).toContain("age 6");
    expect((en as Error).message).toContain("front desk");

    const es = await pandoraFetchWaiverTemplate(6, "naples", "es").catch((e) => e as Error);
    expect((es as Error).message).toContain("edad 6");
    expect((es as Error).message).toContain("mostrador");
  });
});
