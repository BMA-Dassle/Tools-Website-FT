import { describe, expect, it } from "vitest";
import { bmiUserIdFor, bmiUsernameFor, hasTenantUserId } from "./bmi-user-id";

/**
 * OFFICE IDENTITY IS PER TENANT — both halves of it, and both have now caused
 * a production failure.
 *
 * Read off `crm_bmi_projects` grouped by `client_key`, 2026-09-14/15:
 *
 *              headpinzftmyers                headpinznaples
 *   Kelsea     28267036 "Kelsea Kosco"        6338800 "Kelsea"
 *   Stephanie    465242 "Stephanie Wegman"    1559644 "Stephanie"
 *   Guest Svcs 30080112 "Guest Services"      6400642 "CallCenter"
 */

const STEPH = {
  bmiUserId: "465242",
  bmiUserIds: { headpinzftmyers: "465242", headpinznaples: "1559644" },
  bmiUsername: "Stephanie Wegman",
  bmiUsernames: { headpinzftmyers: "Stephanie Wegman", headpinznaples: "Stephanie" },
};

describe("bmiUserIdFor", () => {
  it("sends the id that EXISTS on the tenant being written to", () => {
    // The Fort Myers id on a Naples project is refused with
    // `violation of FOREIGN KEY constraint "FK_PRJ_US_ID"`.
    expect(bmiUserIdFor(STEPH, "headpinzftmyers")).toBe("465242");
    expect(bmiUserIdFor(STEPH, "headpinznaples")).toBe("1559644");
  });

  it("falls back to the single id for a tenant nobody has mapped", () => {
    // Deliberate: refusing to write would stop every hand-off at a centre
    // whose map is not filled in. The failure is parked, not retried forever.
    expect(bmiUserIdFor(STEPH, "somewhere-new")).toBe("465242");
    expect(hasTenantUserId(STEPH, "somewhere-new")).toBe(false);
    expect(hasTenantUserId(STEPH, "headpinznaples")).toBe(true);
  });

  it("a rep with no id at all resolves to null, never to a guess", () => {
    expect(bmiUserIdFor({ bmiUserId: null, bmiUserIds: null }, "headpinznaples")).toBeNull();
  });
});

describe("bmiUsernameFor", () => {
  /**
   * THE ONE THAT TOOK NAPLES OFF THE AIR. Pandora picks the salesperson with
   * `name.includes(agent)`, so "Stephanie" never contains "Stephanie Wegman":
   * every Naples non-kids web lead died with 500 "Failed to assign an agent
   * for this lead.", and because the guest's text, the guest's email AND the
   * planner's Teams card are all gated on having a project, nobody was told.
   */
  it("sends the name PANDORA knows on that tenant", () => {
    expect(bmiUsernameFor(STEPH, "headpinzftmyers")).toBe("Stephanie Wegman");
    expect(bmiUsernameFor(STEPH, "headpinznaples")).toBe("Stephanie");
  });

  it("the Naples name is a PREFIX of the Fort Myers one — which is why it failed one way only", () => {
    // Pandora matches `officeName.includes(agent)`. Fort Myers' "Stephanie
    // Wegman" contains "Stephanie", so a Naples name would have matched at
    // Fort Myers; the reverse never could. That asymmetry is exactly why this
    // looked like "Naples is flaky" rather than a mapping bug.
    const ftName = "Stephanie Wegman";
    const hpnName = "Stephanie";
    expect(ftName.includes(hpnName)).toBe(true);
    expect(hpnName.includes(ftName)).toBe(false);
  });

  it("Guest Services is called something else entirely at Naples", () => {
    const gs = {
      bmiUsername: "Guest Services",
      bmiUsernames: { headpinzftmyers: "Guest Services", headpinznaples: "CallCenter" },
    };
    expect(bmiUsernameFor(gs, "headpinznaples")).toBe("CallCenter");
  });

  it("falls back to the single name, and to null when there is none", () => {
    expect(bmiUsernameFor(STEPH, "somewhere-new")).toBe("Stephanie Wegman");
    expect(bmiUsernameFor({ bmiUsername: null, bmiUsernames: null }, "headpinznaples")).toBeNull();
  });
});
