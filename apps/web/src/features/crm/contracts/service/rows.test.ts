import { describe, expect, it } from "vitest";
import { BMI_ID_FIELDS, parseWithRawIds } from "@ft/db";
import type { CrmRep } from "../../core/types";
import { centreForCenterCode, repIndexByEmail, toContractRow, type QuoteRowSource } from "./rows";

/**
 * The `group_function_quotes` → `ContractRow` projection: ids stay STRINGS,
 * money stays in CENTS, the planner joins to a rep by email, and the centre
 * comes from the `center_code` slug (FT and HPFM share one Office tenant, so
 * the clientKey cannot identify a centre).
 */
const NOW = new Date("2026-09-13T16:30:00.000Z");

/**
 * A 17-DIGIT BMI project id as RAW TEXT, which is how Office sends it. The
 * negative control below proves the fixture is still the ugly case: a plain
 * `JSON.parse` rounds it, so a projection that ever let a project id through a
 * number would fail here (memory `feedback_fixture_must_match_the_ugly_case`).
 */
const RAW_PROJECT = '{"projectId":63000000009561437,"personId":63000000009561440}';

const rep: CrmRep = {
  id: "3",
  slug: "kelsea",
  displayName: "Kelsea Kosco",
  firstName: "Kelsea",
  initials: "KK",
  role: "rep",
  email: "Kelsea@HeadPinz.com",
  ssoSub: null,
  bmiUserId: "28267036",
  bmiUsername: "Kelsea Kosco",
  sevenShiftsUserId: 10832991,
  voxDid: null,
  threecxExtension: null,
  teamsChatId: null,
  phoneE164: null,
  centres: ["HPFM", "FT"],
  active: true,
  sortOrder: 10,
};

const quote: QuoteRowSource = {
  id: 4821,
  contract_short_id: "7Hx2Qk",
  bmi_reservation_id: "63000000009561437",
  center_code: "fasttrax",
  center_name: "FastTrax Fort Myers",
  event_name: "Storm Smart — Install crews",
  event_number: "DH2879",
  event_date: "2026-09-18",
  guest_count: 42,
  guest_first_name: "Rick",
  guest_last_name: "Alvarez",
  guest_email: "rick@stormsmart.test",
  guest_phone: "2395551234",
  status: "contract_sent",
  approval_required: false,
  is_tax_exempt: false,
  total_cents: 189_000,
  tax_cents: 11_750,
  deposit_due_cents: 100_375,
  balance_cents: 100_375,
  collected_cents: 0,
  contract_sent_at: "2026-09-01T13:00:00.000Z",
  contract_signed_at: null,
  deposit_paid_at: null,
  balance_paid_at: null,
  balance_link_sent_at: null,
  square_dayof_order_id: "kQx93f",
  square_settled_order_id: null,
  square_gift_card_gan: null,
  saved_card_brand: null,
  saved_card_last4: null,
  signed_pdf_url: null,
  planner_email: "kelsea@headpinz.com",
  planner_first: "Kelsea",
  planner_last: "Kosco",
  created_at: "2026-08-20T13:00:00.000Z",
  updated_at: "2026-09-01T13:00:00.000Z",
};

const ctx = {
  now: NOW,
  repsByEmail: repIndexByEmail([rep]),
  leadByShortId: new Map([["7Hx2Qk", "L-1048"]]),
  leadByProjectId: new Map<string, string>(),
};

describe("toContractRow", () => {
  it("keeps the BMI project id a string and never touches it as a number", () => {
    const row = toContractRow(quote, ctx);
    expect(row.projectId).toBe("63000000009561437");
    expect(typeof row.projectId).toBe("string");

    // NEGATIVE CONTROL — an ordinary parse of the same id rounds it.
    const naive = JSON.parse(RAW_PROJECT) as { projectId: number };
    expect(String(naive.projectId)).not.toBe("63000000009561437");
    const guarded = parseWithRawIds<{ projectId: string }>(RAW_PROJECT, [
      ...BMI_ID_FIELDS,
      "projectId",
    ]);
    expect(guarded.projectId).toBe("63000000009561437");
  });

  it("joins the planner to a rep by LOWERCASED email", () => {
    const row = toContractRow(quote, ctx);
    expect(row.rep).toEqual({
      slug: "kelsea",
      displayName: "Kelsea Kosco",
      firstName: "Kelsea",
      initials: "KK",
    });
    expect(row.plannerEmail).toBe("kelsea@headpinz.com");
  });

  it("falls back to the planner's own name when no rep row matches", () => {
    const row = toContractRow(
      { ...quote, planner_email: "someone@else.test" },
      { ...ctx, repsByEmail: repIndexByEmail([rep]) },
    );
    expect(row.rep).toBeNull();
    expect(row.plannerName).toBe("Kelsea Kosco");
  });

  it("reads the centre from the center_code SLUG", () => {
    expect(toContractRow(quote, ctx).centre).toBe("FT");
    expect(toContractRow({ ...quote, center_code: "fort-myers" }, ctx).centre).toBe("HPFM");
    expect(toContractRow({ ...quote, center_code: "naples" }, ctx).centre).toBe("HPN");
    expect(toContractRow({ ...quote, center_code: "sarasota" }, ctx).centre).toBeNull();
    expect(centreForCenterCode("fasttrax")).toBe("FT");
  });

  it("titles the row by event name, then by the guest, then by the reference", () => {
    expect(toContractRow(quote, ctx).title).toBe("Storm Smart — Install crews");
    expect(toContractRow({ ...quote, event_name: null }, ctx).title).toBe("Rick Alvarez");
    expect(
      toContractRow({ ...quote, event_name: null, guest_first_name: "", guest_last_name: "" }, ctx)
        .title,
    ).toBe("Event DH2879");
  });

  it("links to the CRM deal by short id, else by project id, else not at all", () => {
    expect(toContractRow(quote, ctx).leadPublicId).toBe("L-1048");
    expect(
      toContractRow(quote, {
        ...ctx,
        leadByShortId: new Map(),
        leadByProjectId: new Map([["63000000009561437", "L-1099"]]),
      }).leadPublicId,
    ).toBe("L-1099");
    expect(
      toContractRow(quote, { ...ctx, leadByShortId: new Map(), leadByProjectId: new Map() })
        .leadPublicId,
    ).toBeNull();
  });

  it("computes daysOut, sentAgoDays and the attention pills from the SAME clock", () => {
    const row = toContractRow(quote, ctx);
    expect(row.daysOut).toBe(5);
    // The banner's day count is dated here, next to the pills, so the two can
    // never disagree — and no component has to call Date.now() in a render.
    expect(row.sentAgoDays).toBe(12);
    expect(row.reasons.map((r) => r.t)).toEqual(["unsigned 12 d", "event in 5 d, unsigned"]);
    expect(toContractRow({ ...quote, contract_sent_at: null }, ctx).sentAgoDays).toBeNull();
  });

  it("normalises Date columns the driver may hand back as objects", () => {
    const row = toContractRow(
      {
        ...quote,
        event_date: new Date("2026-09-18T00:00:00.000Z") as unknown as string,
        contract_sent_at: new Date("2026-09-01T13:00:00.000Z") as unknown as string,
      },
      ctx,
    );
    expect(row.eventDate).toBe("2026-09-18");
    expect(row.sentAt).toBe("2026-09-01T13:00:00.000Z");
  });
});
