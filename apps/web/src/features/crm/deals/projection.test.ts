import { describe, expect, it } from "vitest";
import {
  ALL_STATE_STATUS,
  buildRepIndex,
  repFromProject,
  statusFromBmiState,
  toDeal,
  type DealRowRaw,
  type RepMatchRow,
} from "./projection";

/**
 * The projection is where "one record" is actually decided: which table wins
 * each field, what a deal with no lead row is worth, and whether a row can
 * ever vanish. No Neon — every rule here is a pure function of one joined row.
 */

const REPS: RepMatchRow[] = [
  {
    id: "1",
    slug: "kelsea",
    displayName: "Kelsea Kosco",
    firstName: "Kelsea",
    initials: "KK",
    email: "kelsea@headpinz.com",
    bmiUserId: "28267036",
    bmiUsername: "Kelsea Kosco",
  },
  {
    id: "3",
    slug: "stephanie",
    displayName: "Stephanie Wegman",
    firstName: "Stephanie",
    initials: "SW",
    email: "stephanie@headpinz.com",
    bmiUserId: "465242",
    bmiUsername: "Stephanie Wegman",
  },
  {
    id: "4",
    slug: "gs",
    displayName: "Guest Services",
    firstName: "Guest Services",
    initials: "GS",
    email: "guestservices@headpinz.com",
    bmiUserId: "30080112",
    bmiUsername: "Guest Services",
  },
];

const index = buildRepIndex(REPS);
const ctx = { reps: index };

/** A joined row with nothing in it; each test fills in only what it is about. */
const EMPTY: DealRowRaw = {
  spine: "project",
  key_project_id: null,
  key_quote_id: null,
  key_lead_id: null,
  p_project_id: null,
  p_client_key: null,
  p_location_id: null,
  p_number: null,
  p_name: null,
  p_state_id: null,
  p_state_name: null,
  p_kind_id: null,
  p_responsible_user_id: null,
  p_responsible_name: null,
  p_event_date: null,
  p_event_time: null,
  p_event_start: null,
  p_persons: null,
  p_total_value_cents: null,
  p_balance_cents: null,
  p_person_id: null,
  p_person_name: null,
  p_person_phone: null,
  p_person_email: null,
  p_synced_at: null,
  l_id: null,
  l_public_id: null,
  l_status_id: null,
  l_assigned_rep_id: null,
  l_assigned_at: null,
  l_first_touch_at: null,
  l_next_action_kind: null,
  l_next_action_due: null,
  l_next_action_label: null,
  l_value_cents: null,
  l_source: null,
  l_created_by: null,
  l_created_at: null,
  l_event_date: null,
  l_event_time: null,
  l_centre: null,
  l_guests: null,
  l_rep_slug: null,
  l_rep_name: null,
  l_guest_first: null,
  l_guest_last: null,
  l_guest_phone: null,
  l_guest_email: null,
  l_account_name: null,
  q_id: null,
  q_contract_short_id: null,
  q_status: null,
  q_center_code: null,
  q_center_name: null,
  q_event_name: null,
  q_event_number: null,
  q_event_date: null,
  q_guest_count: null,
  q_guest_first_name: null,
  q_guest_last_name: null,
  q_guest_email: null,
  q_guest_phone: null,
  q_approval_required: null,
  q_is_tax_exempt: null,
  q_total_cents: null,
  q_tax_cents: null,
  q_deposit_due_cents: null,
  q_balance_cents: null,
  q_collected_cents: null,
  q_contract_sent_at: null,
  q_contract_signed_at: null,
  q_deposit_paid_at: null,
  q_balance_paid_at: null,
  q_balance_link_sent_at: null,
  q_square_dayof_order_id: null,
  q_square_settled_order_id: null,
  q_square_gift_card_gan: null,
  q_saved_card_brand: null,
  q_saved_card_last4: null,
  q_signed_pdf_url: null,
  q_planner_email: null,
  q_planner_first: null,
  q_planner_last: null,
  q_created_at: null,
  q_updated_at: null,
};

const row = (patch: Partial<DealRowRaw>): DealRowRaw => ({ ...EMPTY, ...patch });

/** A mirrored Fort Myers project in Confirmation, the commonest shape. */
const PROJECT: Partial<DealRowRaw> = {
  spine: "project",
  key_project_id: "47357477",
  p_project_id: "47357477",
  p_client_key: "headpinzftmyers",
  p_location_id: 332160,
  p_number: "H2892",
  p_name: "Juniper Landscaping",
  p_state_id: "-3",
  p_state_name: "Confirmation",
  p_kind_id: "-1",
  p_event_date: "2026-10-02",
  p_event_time: "18:00",
  p_persons: 60,
  p_total_value_cents: "464879",
};

describe("BMI state → our status, when no lead row exists", () => {
  it("maps the open sales states per tenant", () => {
    expect(statusFromBmiState("headpinzftmyers", "48952154")).toBe("contract");
    expect(statusFromBmiState("headpinznaples", "8007473")).toBe("contract");
    expect(statusFromBmiState("headpinzftmyers", "-2")).toBe("quote");
  });

  it("maps the won states, so Booked is never empty", () => {
    expect(statusFromBmiState("headpinzftmyers", "-3")).toBe("confirmed");
    expect(statusFromBmiState("headpinznaples", "-106")).toBe("deposit");
  });

  it("maps Cancellation to lost in BOTH tenants — a cancelled deal is an ANSWER", () => {
    expect(statusFromBmiState("headpinzftmyers", "-4")).toBe("lost");
    expect(statusFromBmiState("headpinznaples", "-4")).toBe("lost");
  });

  it("answers null for a state nobody has mapped, rather than guessing `new`", () => {
    expect(statusFromBmiState("headpinzftmyers", "999999")).toBeNull();
    expect(statusFromBmiState(null, "-3")).toBeNull();
    expect(statusFromBmiState("headpinzftmyers", null)).toBeNull();
  });

  it("covers both tenants and never lets one drift", () => {
    expect(Object.keys(ALL_STATE_STATUS).sort()).toEqual(["headpinzftmyers", "headpinznaples"]);
  });
});

describe("Office `responsible` → a rep on the roster", () => {
  it("matches on the Fort Myers office id", () => {
    expect(repFromProject(index, "28267036", null)?.slug).toBe("kelsea");
  });

  it("matches a NAPLES id through the per-tenant alias table", () => {
    // 6338800 is Kelsea at Naples; `crm_reps.bmi_user_id` only holds Fort Myers.
    expect(repFromProject(index, "6338800", null)?.slug).toBe("kelsea");
    expect(repFromProject(index, "6400642", null)?.slug).toBe("gs");
  });

  it("matches Office's bare first name when exactly one rep answers to it", () => {
    expect(repFromProject(index, null, "Kelsea")?.slug).toBe("kelsea");
    expect(repFromProject(index, null, "  stephanie  ")?.slug).toBe("stephanie");
  });

  it("matches the CallCenter bucket Office does not call Guest Services", () => {
    expect(repFromProject(index, null, "CallCenter")?.slug).toBe("gs");
  });

  it("returns null rather than picking somebody at random", () => {
    expect(repFromProject(index, "1", "Nobody At All")).toBeNull();
  });
});

describe("the merge — BMI is the spine, the overlays fill in", () => {
  it("a project with no lead and no quote is still a deal", () => {
    const deal = toDeal(row(PROJECT), ctx);
    expect(deal.key).toBe("47357477");
    expect(deal.projectId).toBe("47357477");
    expect(deal.spine).toBe("project");
    expect(deal.hasLead).toBe(false);
    expect(deal.hasQuote).toBe(false);
    expect(deal.status).toBe("confirmed");
    expect(deal.statusSource).toBe("bmi");
    expect(deal.centre).toBe("HPFM");
    expect(deal.eventDate).toBe("2026-10-02");
    expect(deal.title).toBe("Juniper Landscaping");
    expect(deal.valueCents).toBe(464879);
  });

  it("the lead's status WINS when a planner owns the deal", () => {
    const deal = toDeal(
      row({
        ...PROJECT,
        l_id: "225",
        l_public_id: "L-225",
        l_status_id: "contract",
        l_created_by: "crm-adopt",
        l_created_at: "2026-09-13T03:00:00.000Z",
      }),
      ctx,
    );
    expect(deal.status).toBe("contract");
    expect(deal.statusSource).toBe("lead");
    expect(deal.lead?.publicId).toBe("L-225");
    expect(deal.lead?.adopted).toBe(true);
  });

  it("the quote joins by PROJECT ID, which is how Juniper finds its contract", () => {
    const deal = toDeal(
      row({
        ...PROJECT,
        l_id: "225",
        l_public_id: "L-225",
        l_status_id: "confirmed",
        l_created_at: "2026-09-13T03:00:00.000Z",
        q_id: "412",
        q_contract_short_id: "e41b6fdf",
        q_status: "balance_link_sent",
        q_total_cents: "464879",
        q_deposit_due_cents: "239724",
        q_deposit_paid_at: "2026-08-28T11:13:36.328Z",
        q_balance_cents: "225155",
        q_event_date: "2026-10-02",
        q_center_code: "fort-myers",
        q_guest_first_name: "Amy",
        q_guest_last_name: "Rivera",
      }),
      ctx,
    );
    expect(deal.hasQuote).toBe(true);
    expect(deal.quote?.shortId).toBe("e41b6fdf");
    expect(deal.quote?.depositPaidAt).toBe("2026-08-28T11:13:36.328Z");
    expect(deal.quote?.balanceCents).toBe(225155);
    // The deal is worth what the CONTRACT says once there is one.
    expect(deal.valueCents).toBe(464879);
    expect(deal.guestName).toBe("Amy Rivera");
  });

  it("BMI's date wins over the contract's — a reschedule moves Office first", () => {
    const deal = toDeal(
      row({ ...PROJECT, p_event_date: "2026-09-19", q_id: "7", q_event_date: "2026-09-13" }),
      ctx,
    );
    expect(deal.eventDate).toBe("2026-09-19");
    expect(deal.quote?.eventDate).toBe("2026-09-13");
  });

  it("the owner is the lead's rep, else Office's responsible, else the planner", () => {
    const fromLead = toDeal(
      row({
        ...PROJECT,
        l_id: "1",
        l_public_id: "L-1",
        l_created_at: "2026-09-01T00:00:00.000Z",
        l_assigned_rep_id: "3",
        p_responsible_user_id: "28267036",
      }),
      ctx,
    );
    expect(fromLead.rep?.slug).toBe("stephanie");
    expect(fromLead.repSource).toBe("lead");

    const fromBmi = toDeal(row({ ...PROJECT, p_responsible_user_id: "28267036" }), ctx);
    expect(fromBmi.rep?.slug).toBe("kelsea");
    expect(fromBmi.repSource).toBe("bmi");

    const fromPlanner = toDeal(
      row({ ...PROJECT, q_id: "9", q_planner_email: "Stephanie@HeadPinz.com" }),
      ctx,
    );
    expect(fromPlanner.rep?.slug).toBe("stephanie");
    expect(fromPlanner.repSource).toBe("planner");
  });
});

describe("nothing is ever silently dropped", () => {
  it("a contract whose project the mirror has never seen still arrives", () => {
    const deal = toDeal(
      row({
        spine: "quote",
        key_project_id: "59675170",
        key_quote_id: "512",
        q_id: "512",
        q_contract_short_id: "1454ef37",
        q_status: "contract_sent",
        q_event_date: "2026-12-12",
        q_center_code: "fort-myers",
        q_center_name: "HeadPinz Fort Myers",
        q_event_name: "Holiday party",
        q_total_cents: "120000",
      }),
      ctx,
    );
    expect(deal.spine).toBe("quote");
    expect(deal.project).toBeNull();
    expect(deal.projectId).toBe("59675170");
    expect(deal.key).toBe("59675170");
    expect(deal.hasQuote).toBe(true);
    expect(deal.centre).toBe("HPFM");
    expect(deal.eventDate).toBe("2026-12-12");
    // No project and no lead means no sales status — an honest blank, not a guess.
    expect(deal.status).toBeNull();
    expect(deal.statusSource).toBe("quote");
  });

  it("a lead minted without a project keys on its own row and is still a deal", () => {
    const deal = toDeal(
      row({
        spine: "lead",
        key_lead_id: "2",
        l_id: "2",
        l_public_id: "L-2",
        l_status_id: "new",
        l_centre: "HPN",
        l_event_date: "2026-11-15",
        l_event_time: "17:30",
        l_guest_first: "Dana",
        l_guest_last: "Cruz",
        l_value_cents: "0",
        l_created_at: "2026-09-10T00:00:00.000Z",
      }),
      ctx,
    );
    expect(deal.key).toBe("l:2");
    expect(deal.spine).toBe("lead");
    expect(deal.projectId).toBeNull();
    expect(deal.centre).toBe("HPN");
    expect(deal.eventDate).toBe("2026-11-15");
    expect(deal.eventTime).toBe("17:30");
    expect(deal.guestName).toBe("Dana Cruz");
    expect(deal.status).toBe("new");
    expect(deal.statusSource).toBe("lead");
  });
});

describe("ids and money stay exact", () => {
  it("a 17-digit project id is carried as TEXT, never through a number", () => {
    const big = "63000000009561437";
    const deal = toDeal(row({ ...PROJECT, key_project_id: big, p_project_id: big }), ctx);
    expect(deal.projectId).toBe(big);
    expect(deal.key).toBe(big);
    expect(deal.project?.projectId).toBe(big);
  });

  it("money arrives as BIGINT text and becomes an exact cent count", () => {
    const deal = toDeal(row({ ...PROJECT, q_id: "1", q_total_cents: "464879" }), ctx);
    expect(deal.quote?.totalCents).toBe(464879);
  });

  it("the event time comes from Postgres, never from slicing a UTC instant", () => {
    const deal = toDeal(
      row({ ...PROJECT, p_event_time: "14:00", p_event_start: "2026-10-02T18:00:00.000Z" }),
      ctx,
    );
    expect(deal.eventTime).toBe("14:00");
  });
});
