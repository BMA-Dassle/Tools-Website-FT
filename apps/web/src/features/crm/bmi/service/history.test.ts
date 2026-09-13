import { describe, expect, it, vi } from "vitest";
import type { MirrorProject } from "../data/projects-mirror-db";

/**
 * The wire projection of a mirror row: the rep chip is joined from
 * `responsible_user_id` → `crm_reps.bmi_user_id`, the centre from the
 * location, and nothing on the wire is a number that was an id.
 */

vi.mock("~/features/crm/reps", () => ({
  listReps: async () => [
    { slug: "kelsea", firstName: "Kelsea", initials: "KK", bmiUserId: "28267036" },
    { slug: "jacob", firstName: "Jacob", initials: "J", bmiUserId: null },
  ],
}));

const { repIndex, toMirrorEvent } = await import("./history");

const ROW: MirrorProject = {
  projectId: "58454076",
  clientKey: "headpinzftmyers",
  locationId: 467486,
  number: "DH2320",
  name: "Storm Smart — Install crews",
  stateId: "-3",
  stateName: "Confirmation",
  kindId: "-1",
  responsibleUserId: "28267036",
  responsibleName: "Kelsea Kosco",
  eventDate: "2025-10-25",
  eventStart: "2025-10-25T22:00:00.000Z",
  persons: 64,
  totalValueCents: 496_000,
  balanceCents: 0,
  personId: "63000000009561437",
  personName: "Pat Storm",
  personPhone: "+12395551602",
  personEmail: "pat@stormsmart.com",
  products: null,
  source: "backfill",
  bmiCreatedAt: null,
  bmiUpdatedAt: null,
  syncedAt: "2026-09-12T23:00:00.000Z",
  accountId: "7",
  contactId: "8",
};

describe("toMirrorEvent", () => {
  it("joins the rep by bmi_user_id and maps the FastTrax location to FT", async () => {
    const reps = await repIndex();
    expect(reps.size).toBe(1); // a rep without a BMI user id cannot be attributed
    const e = toMirrorEvent(ROW, reps);
    expect(e).toMatchObject({
      projectId: "58454076",
      centre: "FT",
      number: "DH2320",
      rep: { slug: "kelsea", firstName: "Kelsea", initials: "KK" },
      totalValueCents: 496_000,
      accountId: "7",
    });
    expect(toMirrorEvent({ ...ROW, responsibleUserId: "1" }, reps).rep).toBeNull();
    expect(toMirrorEvent({ ...ROW, locationId: null }, reps).centre).toBeNull();
  });
});
