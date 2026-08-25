/**
 * Edit Reservation modal logic tests.
 *
 * NOTE: this repo has NO component-test infrastructure (vitest runs in the
 * node environment; jsdom / @testing-library are not installed), so per the
 * PR-5 test plan these cover the modal's behavior at the logic layer —
 * editPlanHelpers (which the modal and useEditPlan are thin React shells
 * over) with a mocked global fetch: mount-gate classification, staff-facing
 * error copy, spec assembly, diff-table pairing, execute gating (per-code
 * acknowledgments + initials), execute-failure handling by code, and
 * success-screen derivations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EditCurrentState,
  EditPlan,
  EditPlanLeg,
  PlanLine,
} from "~/features/reservation-edit/plan";
import type { EditResult } from "~/features/reservation-edit/service";
import type { EditWarning } from "~/features/reservation-edit/types";
import {
  buildDiffRows,
  buildExecuteAck,
  buildSpec,
  classifyExecuteFailure,
  classifyMountOutcome,
  collectManualSteps,
  defaultNotifyGuest,
  describeEditError,
  emptyForm,
  executeGate,
  GUARD_COPY,
  isEmptySpec,
  isValidInitials,
  managerCodes,
  manualFixSuffix,
  missingAckCodes,
  notifyLabel,
  planNeedsManagerAck,
  POST_COMPLETE_ACK_CODE,
  postEdit,
  residualWarnings,
  resultSummary,
  splitEnvNote,
  type EditApiError,
  type EditFormState,
} from "./editPlanHelpers";

/* ── Fixtures ─────────────────────────────────────────────────────────── */

const line = (over: Partial<PlanLine> = {}): PlanLine => ({
  uid: null,
  catalogObjectId: null,
  name: "Open Bowling",
  quantity: 4,
  unitPriceCents: 1000,
  totalCents: 4000,
  note: null,
  ...over,
});

const makeLeg = (over: Partial<EditPlanLeg> = {}): EditPlanLeg => ({
  reservationId: 101,
  productKind: "open",
  dayofOrderId: "order_1",
  orderState: "OPEN",
  orderVersion: 3,
  orderLocationId: "LOC1",
  phase: "pre",
  oldLines: [line({ uid: "u1" })],
  newLines: [line({ uid: "u1", quantity: 5, totalCents: 5000 })],
  oldTotalCents: 4000,
  newTotalCents: 5000,
  returnedLines: [],
  newNeonLines: null,
  newPlayerCount: 5,
  newLaneCount: null,
  newDuration: null,
  resolvedStamp: null,
  removedHeats: null,
  raceAdds: null,
  attractionChanges: null,
  ...over,
});

const makeCurrent = (over: Partial<EditCurrentState> = {}): EditCurrentState => ({
  playerCount: 4,
  laneCount: 2,
  pricingMode: "per_lane",
  shoes: [{ squareProductId: 7, label: "Shoe Rental", quantity: 4, unitPriceCents: 500 }],
  shoeCatalog: [
    { squareProductId: 7, label: "Shoe Rental", priceCents: 500 },
    { squareProductId: 8, label: "Kids Shoe Rental", priceCents: 400 },
  ],
  players: [
    { slot: 1, name: "Ann", shoeSize: "8", bumpers: false },
    { slot: 2, name: "Bob", shoeSize: null, bumpers: true },
  ],
  heats: [],
  durationOptions: [],
  durationMultiplier: null,
  attractions: [],
  orderLines: [],
  ...over,
});

const makePlan = (over: Partial<EditPlan> = {}): EditPlan => ({
  anchorId: 101,
  legIds: [101],
  isCombo: false,
  phase: "pre",
  spec: { playerCount: 5 },
  legs: [makeLeg()],
  money: {
    payingLegId: null,
    dayofPaymentId: null,
    giftCardId: null,
    depositOrderId: "dep_1",
    storeCreditLegId: null,
    storeCreditGiftCardId: null,
    storeCreditGan: null,
    storeCreditCents: 0,
    closedUnpaid: false,
  },
  diffCents: 1000,
  guestOwedCents: 0,
  gcDecrementCents: 0,
  settlement: "charge",
  chargeCard: { cardId: "ccof:abc", brand: "VISA", last4: "4242" },
  giftCard: null,
  steps: [],
  warnings: [],
  current: makeCurrent(),
  executionBlocked: null,
  planHash: "hash-1",
  ...over,
});

const makeResult = (over: Partial<EditResult> = {}): EditResult => ({
  editId: "edit-101-a1",
  state: "completed",
  diffCents: 1000,
  paymentIds: ["pay_1"],
  refundIds: [],
  stepLog: [],
  warnings: [],
  manualSteps: [],
  ...over,
});

const managerWarning = (over: Partial<EditWarning> = {}): EditWarning => ({
  severity: "manager",
  code: "qamf_count_increase_manual",
  message: "Conqueror will not be updated for the extra bowler.",
  system: "conqueror",
  manualStep: "Add 1 bowler to Conqueror reservation X158469 by hand",
  ...over,
});

const apiError = (over: Partial<EditApiError> = {}): EditApiError => ({
  status: 409,
  code: "phase_conflict",
  detail: null,
  ...over,
});

/* ── postEdit + mount classification (mocked fetch) ───────────────────── */

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postEdit", () => {
  it("sends the token + body and returns the plan on a dry-run", async () => {
    const plan = makePlan();
    fetchMock.mockResolvedValueOnce(jsonResponse({ plan }));
    const out = await postEdit("tok/en", {
      neonId: 101,
      spec: { playerCount: 5 },
      dryRun: true,
      settlement: "store_credit",
      managerOverride: true,
    });
    expect(out).toEqual({ kind: "plan", plan });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/admin/reservations/edit?token=tok%2Fen");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      neonId: 101,
      spec: { playerCount: 5 },
      dryRun: true,
      settlement: "store_credit",
      managerOverride: true,
    });
  });

  it("maps a 409 to a typed error (mount blocked on cancelled) with staff copy", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "cancelled", detail: "cancelled" }, 409));
    const out = await postEdit("t", { neonId: 1, spec: {}, dryRun: true });
    expect(out).toEqual({
      kind: "error",
      error: { status: 409, code: "cancelled", detail: "cancelled", data: null },
    });
    if (out.kind !== "error") throw new Error("expected error");
    const mount = classifyMountOutcome(out);
    expect(mount.kind).toBe("blocked");
    if (mount.kind !== "blocked") throw new Error("expected blocked");
    // Never the bare code — the guard threw without a message, so the map speaks.
    expect(mount.copy.title).toMatch(/cancelled — nothing to edit/i);
    expect(mount.copy.body).toBe("");
    expect(mount.copy.supportDetail).toContain("cancelled");
  });

  it("carries the no_changes payload (current + capabilities) so the form hydrates on mount", async () => {
    // The mount probe's healthy answer ships `current`. Dropping it here left a
    // settled reservation with no day-of order lines rendered — which is the
    // ONLY refund control it has, so the Refund button opened to nothing.
    const current = { orderLines: [{ uid: "FOOD", name: "Soda", quantity: 1, editable: true }] };
    const capabilities = {
      edit: false,
      refund: true,
      preDecrease: true,
      blockedReason: "Editing is off (RESERVATION_EDIT_V2=false)",
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "no_changes", data: { current, capabilities } }, 400),
    );
    const out = await postEdit("t", { neonId: 1, spec: {}, dryRun: true });
    if (out.kind !== "error") throw new Error("expected error");
    expect(out.error.code).toBe("no_changes");
    expect(out.error.data?.current).toEqual(current);
    // Still classified as "editable" — the kill-switch state rides along.
    expect(classifyMountOutcome(out)).toEqual({ kind: "edit", capabilities });
  });

  it("treats the mount probe's no_changes as 'editable, form from detail'", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "no_changes" }, 400));
    const out = await postEdit("t", { neonId: 1, spec: {}, dryRun: true });
    if (out.kind !== "error") throw new Error("expected error");
    expect(classifyMountOutcome(out)).toEqual({ kind: "edit", capabilities: null });
    // …and the form the modal initializes from the board row starts clean:
    expect(isEmptySpec(buildSpec(emptyForm(), 4, null))).toBe(true);
  });

  it("routes post_complete_ack_required to the manager-ack gate", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: "post_complete_ack_required", detail: "post_complete_ack_required" },
        409,
      ),
    );
    const out = await postEdit("t", { neonId: 1, spec: {}, dryRun: true });
    if (out.kind !== "error") throw new Error("expected error");
    expect(classifyMountOutcome(out)).toEqual({ kind: "ack_required" });
  });

  it("returns status 0 on transport failure → retryable mount error with plain copy", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    const out = await postEdit("t", { neonId: 1, spec: {}, dryRun: true });
    if (out.kind !== "error") throw new Error("expected error");
    expect(out.error.status).toBe(0);
    const mount = classifyMountOutcome(out);
    expect(mount.kind).toBe("error");
    if (mount.kind !== "error") throw new Error("expected error");
    // The exception message is not staff copy — it goes to the support line.
    expect(mount.copy.title).toMatch(/couldn't reach/i);
    expect(mount.copy.body).not.toContain("boom");
    expect(mount.copy.supportDetail).toContain("boom");
  });

  it("returns the EditResult on execute (dryRun:false) and sends the acknowledgments", async () => {
    const result = makeResult();
    fetchMock.mockResolvedValueOnce(jsonResponse(result));
    const out = await postEdit("t", {
      neonId: 101,
      spec: { playerCount: 5 },
      dryRun: false,
      planHash: "hash-1",
      notifyGuest: true,
      acknowledgedCodes: ["qamf_count_increase_manual"],
      acknowledgedBy: "EO",
    });
    expect(out).toEqual({ kind: "result", result });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body.dryRun).toBe(false);
    expect(body.planHash).toBe("hash-1");
    expect(body.notifyGuest).toBe(true);
    expect(body.acknowledgedCodes).toEqual(["qamf_count_increase_manual"]);
    expect(body.acknowledgedBy).toBe("EO");
    // managerOverride omitted entirely when not given:
    expect("managerOverride" in body).toBe(false);
  });

  it("carries editId + failedStep from an execute failure body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: "edit_failed",
          detail: "orders/calculate failed (400)",
          editId: "edit-101-a3",
          failedStep: "charge_topup",
        },
        502,
      ),
    );
    const out = await postEdit("t", { neonId: 1, spec: {}, dryRun: false, planHash: "h" });
    if (out.kind !== "error") throw new Error("expected error");
    expect(out.error.editId).toBe("edit-101-a3");
    expect(out.error.failedStep).toBe("charge_topup");
  });

  it("flags a dry-run 200 without a plan as bad_response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const out = await postEdit("t", { neonId: 1, spec: {}, dryRun: true });
    if (out.kind !== "error") throw new Error("expected error");
    expect(out.error.code).toBe("bad_response");
  });
});

/* ── Staff-facing error copy ──────────────────────────────────────────── */

describe("describeEditError", () => {
  it("has a title for every code the client can receive, none of them a bare code", () => {
    for (const [code, entry] of Object.entries(GUARD_COPY)) {
      expect(entry.title.length).toBeGreaterThan(8);
      expect(entry.title).not.toBe(code);
      expect(entry.title).not.toMatch(/_/);
    }
  });

  it("uses the server's staff-directed detail as the body when it is a real sentence", () => {
    const copy = describeEditError(
      apiError({
        status: 400,
        code: "pricing_unresolvable",
        detail:
          "this booking's stored lines don't reconcile with its day-of order — refund a day-of charge instead, or adjust it directly in Square",
      }),
    );
    expect(copy.title).toMatch(/safe price/i);
    expect(copy.body).toMatch(/refund a day-of charge instead/i);
    expect(copy.supportDetail).toMatch(/^pricing_unresolvable · /);
  });

  it("falls back to the map body when the detail is just the code echoed back", () => {
    const copy = describeEditError(
      apiError({ code: "combo_phase_split", detail: "combo_phase_split" }),
    );
    expect(copy.title).toMatch(/charged at the venue and part has not/i);
    expect(copy.body).toMatch(/open the part that has NOT been charged/i);
  });

  it("never renders an unknown code as the title, and keeps it for support", () => {
    const copy = describeEditError(apiError({ status: 500, code: "http_500", detail: null }));
    expect(copy.title).toBe("This change cannot be made here");
    expect(copy.supportDetail).toBe("http_500 · HTTP 500");
  });

  it("puts editId and failedStep under the support detail, not in the body", () => {
    const copy = describeEditError(
      apiError({
        status: 502,
        code: "edit_failed",
        detail: "no lane-open payment id on the row",
        editId: "edit-24493-a2",
        failedStep: "refund_dayof_payment",
      }),
    );
    expect(copy.title).toMatch(/didn't finish/i);
    expect(copy.body).toBe("no lane-open payment id on the row");
    expect(copy.supportDetail).toContain("edit edit-24493-a2");
    expect(copy.supportDetail).toContain("failed at refund_dayof_payment");
  });

  it("splitEnvNote strips the env var from staff copy and keeps it aside", () => {
    expect(
      splitEnvNote(
        "Reservation editing has been switched off (RESERVATION_EDIT_V2=false) — only refunds are running. The preview above is accurate.",
      ),
    ).toEqual({
      text: "Reservation editing has been switched off — only refunds are running. The preview above is accurate.",
      envNote: "RESERVATION_EDIT_V2=false",
    });
    expect(splitEnvNote("plain")).toEqual({ text: "plain", envNote: null });
  });
});

/* ── Execute-failure classification ───────────────────────────────────── */

describe("classifyExecuteFailure", () => {
  it("plan_stale → automatic dry-run refresh", () => {
    expect(
      classifyExecuteFailure({ status: 409, code: "plan_stale", detail: "moved" }, 1000),
    ).toEqual({ kind: "refresh_plan" });
  });

  it("not_enabled (501) → blocked with the environment message", () => {
    const a = classifyExecuteFailure({ status: 501, code: "not_enabled", detail: "flag off" }, 0);
    expect(a.kind).toBe("blocked");
    if (a.kind === "blocked") expect(a.copy.title).toMatch(/switched off/i);
  });

  it("payment_required on an increase → error with payment-link fallback", () => {
    const a = classifyExecuteFailure(
      { status: 400, code: "payment_required", detail: "card declined" },
      1500,
    );
    expect(a.kind).toBe("error");
    if (a.kind !== "error") throw new Error("expected error");
    expect(a.offerPaymentLink).toBe(true);
    expect(a.copy.body).toBe("card declined");
  });

  it("edit_failed 502 on a decrease → retryable error, no link offer", () => {
    const a = classifyExecuteFailure({ status: 502, code: "edit_failed", detail: "boom" }, -500);
    expect(a.kind).toBe("error");
    if (a.kind !== "error") throw new Error("expected error");
    expect(a.offerPaymentLink).toBe(false);
    expect(a.copy.body).toBe("boom");
  });

  it("edit_failed on an increase offers a link ONLY once the charge step is what failed", () => {
    // Before the charge, a fatal external step (BMI heats, QAMF rebook) would
    // re-fail on the link path — the offer could never succeed.
    const early = classifyExecuteFailure(
      { status: 502, code: "edit_failed", detail: "bmi add failed", failedStep: "bmi_add_heats" },
      1500,
    );
    if (early.kind !== "error") throw new Error("expected error");
    expect(early.offerPaymentLink).toBe(false);
    const atCharge = classifyExecuteFailure(
      { status: 502, code: "edit_failed", detail: "charge failed", failedStep: "charge_topup" },
      1500,
    );
    if (atCharge.kind !== "error") throw new Error("expected error");
    expect(atCharge.offerPaymentLink).toBe(true);
    // No step info at all → no offer (the old behavior offered blindly).
    const unknown = classifyExecuteFailure({ status: 502, code: "edit_failed", detail: "x" }, 1500);
    if (unknown.kind !== "error") throw new Error("expected error");
    expect(unknown.offerPaymentLink).toBe(false);
  });

  it("other 409s (phase moved under us) → blocked with the server's sentence", () => {
    const a = classifyExecuteFailure(
      { status: 409, code: "phase_conflict", detail: "order moved" },
      1000,
    );
    expect(a.kind).toBe("blocked");
    if (a.kind === "blocked") expect(a.copy.body).toBe("order moved");
  });

  it("capacity / config refusals are blocked — no Retry, no payment link", () => {
    for (const code of [
      "heat_capacity",
      "qamf_availability",
      "bmi_line_unavailable",
      "conqueror_origin",
      "dayof_payment_unresolved",
      "unsupported_kind",
      "pricing_unresolvable",
    ]) {
      // These arrive as 400s (not in the route's CONFLICT_CODES) — the code,
      // not the status, has to drive the verdict.
      const a = classifyExecuteFailure({ status: 400, code, detail: null }, 1500);
      expect(a.kind, code).toBe("blocked");
    }
  });

  it("ack_required → back to the form with the codes the server still needs", () => {
    const a = classifyExecuteFailure(
      {
        status: 409,
        code: "ack_required",
        detail: "acknowledge the manager warnings first",
        data: { missing: ["qamf_count_decrease_manual"] },
      },
      -500,
    );
    expect(a).toMatchObject({ kind: "ack_required", missing: ["qamf_count_decrease_manual"] });
  });

  it("dayof_reason_required / reserved → back to the form", () => {
    for (const code of ["dayof_reason_required", "dayof_reason_reserved"]) {
      const a = classifyExecuteFailure({ status: 400, code, detail: null }, -500);
      expect(a.kind, code).toBe("fix_form");
    }
  });
});

/* ── buildSpec — desired END STATE from the sparse form ───────────────── */

describe("buildSpec", () => {
  const touch = (over: Partial<EditFormState>): EditFormState => ({ ...emptyForm(), ...over });

  it("empty form → empty spec (client-side no_changes)", () => {
    expect(buildSpec(emptyForm(), 4, makeCurrent())).toEqual({});
  });

  it("player count change is included; same value is not", () => {
    expect(buildSpec(touch({ playerCount: 5 }), 4, null)).toEqual({ playerCount: 5 });
    expect(buildSpec(touch({ playerCount: 4 }), 4, null)).toEqual({});
  });

  it("order-line edits send only moved, server-editable lines", () => {
    const current = makeCurrent({
      orderLines: [
        {
          uid: "food1",
          name: "Pizza",
          quantity: 2,
          unitPriceCents: 1499,
          totalCents: 2998,
          editable: true,
        },
        {
          uid: "u1",
          name: "Fun 4 All",
          quantity: 2,
          unitPriceCents: 1999,
          totalCents: 3998,
          editable: false,
        },
      ],
    });
    // Moved + editable → sent.
    expect(buildSpec(touch({ orderLines: { food1: 0 } }), 4, current)).toEqual({
      orderLines: { food1: 0 },
    });
    // Unchanged quantity → omitted.
    expect(buildSpec(touch({ orderLines: { food1: 2 } }), 4, current)).toEqual({});
    // Engine-owned line → never sent, even if the form somehow holds it.
    expect(buildSpec(touch({ orderLines: { u1: 0 } }), 4, current)).toEqual({});
  });

  it("lane count compares against plan.current, not zero", () => {
    const current = makeCurrent({ laneCount: 2 });
    expect(buildSpec(touch({ laneCount: 2 }), 4, current)).toEqual({});
    expect(buildSpec(touch({ laneCount: 3 }), 4, current)).toEqual({ laneCount: 3 });
  });

  it("shoes merge overrides over current and express removals as 0", () => {
    const current = makeCurrent();
    // bump kids shoes to 2, drop adult shoes entirely
    const spec = buildSpec(touch({ shoes: { 8: 2, 7: 0 } }), 4, current);
    expect(spec.shoes).toEqual({ 7: 0, 8: 2 });
    // overrides equal to current → no shoes key
    expect(buildSpec(touch({ shoes: { 7: 4 } }), 4, current)).toEqual({});
  });

  it("touched roster sends the FULL desired roster merged with current", () => {
    const current = makeCurrent();
    const spec = buildSpec(
      touch({ playersTouched: true, players: { 2: { name: "Robert" } }, playerCount: 3 }),
      4,
      current,
    );
    expect(spec.players).toEqual([
      { slot: 1, name: "Ann", shoeSize: "8", bumpers: false },
      { slot: 2, name: "Robert", shoeSize: null, bumpers: true },
      { slot: 3, name: null, shoeSize: null, bumpers: null },
    ]);
  });

  it("racers: blank names are dropped, remove indexes sorted", () => {
    const spec = buildSpec(
      touch({
        addRacers: [
          { firstName: "  ", category: "adult", isNew: false },
          { firstName: " Max ", category: "junior", isNew: true },
        ],
        removeHeatIndexes: [2, 0],
      }),
      1,
      null,
    );
    expect(spec.racers).toEqual({
      add: [{ firstName: "Max", category: "junior", isNew: true }],
      removeHeatIndexes: [0, 2],
    });
  });
});

/* ── Diff-table pairing (the dry-run rendering surface) ───────────────── */

describe("buildDiffRows", () => {
  it("pairs by uid, marks quantity/total changes, appends additions", () => {
    const oldLines = [
      line({ uid: "u1", name: "Open Bowling", quantity: 4, totalCents: 4000 }),
      line({ uid: "u2", name: "Shoe Rental", quantity: 4, totalCents: 2000 }),
    ];
    const newLines = [
      line({ uid: "u1", name: "Open Bowling", quantity: 5, totalCents: 5000 }),
      line({ uid: "u2", name: "Shoe Rental", quantity: 4, totalCents: 2000 }),
      line({ uid: null, name: "Kids Shoe Rental", quantity: 1, totalCents: 400 }),
    ];
    expect(buildDiffRows(oldLines, newLines)).toEqual([
      {
        name: "Open Bowling",
        oldQty: 4,
        oldTotalCents: 4000,
        newQty: 5,
        newTotalCents: 5000,
        changed: true,
      },
      {
        name: "Shoe Rental",
        oldQty: 4,
        oldTotalCents: 2000,
        newQty: 4,
        newTotalCents: 2000,
        changed: false,
      },
      {
        name: "Kids Shoe Rental",
        oldQty: null,
        oldTotalCents: null,
        newQty: 1,
        newTotalCents: 400,
        changed: true,
      },
    ]);
  });

  it("marks removed lines (no new counterpart) and falls back to catalog/name matching", () => {
    const oldLines = [
      line({
        uid: "u9",
        catalogObjectId: "CAT1",
        name: "Shoe Rental",
        quantity: 2,
        totalCents: 1000,
      }),
    ];
    // uid changes across a rebuild — catalog id still pairs them
    const paired = buildDiffRows(oldLines, [
      line({
        uid: null,
        catalogObjectId: "CAT1",
        name: "Shoe Rental",
        quantity: 1,
        totalCents: 500,
      }),
    ]);
    expect(paired[0]).toMatchObject({ newQty: 1, newTotalCents: 500, changed: true });
    // no counterpart at all → removal row
    const removed = buildDiffRows(oldLines, []);
    expect(removed[0]).toMatchObject({ newQty: null, newTotalCents: null, changed: true });
  });
});

/* ── Execute gating (delta states + per-code manager acks) ────────────── */

describe("executeGate", () => {
  const gate = (plan: EditPlan | null, over: Partial<Parameters<typeof executeGate>[0]> = {}) =>
    executeGate({
      plan,
      planLoading: false,
      refundDest: null,
      ackedCodes: new Set(),
      ackInitials: "",
      ...over,
    });

  it("disabled without a plan or while repricing", () => {
    expect(gate(null).enabled).toBe(false);
    expect(gate(makePlan(), { planLoading: true }).enabled).toBe(false);
  });

  it("a day-of refund needs a staff reason before Execute unlocks", () => {
    // The server refuses without one (the deposit journal key is reserved for
    // the cash leg) — block here rather than 400ing after everything else.
    const plan = makePlan({
      diffCents: -1605,
      steps: [{ kind: "refund_dayof_payment", fatal: true, amountCents: 1605 }],
    });
    const blocked = gate(plan, { refundDest: "card_refund" });
    expect(blocked.enabled).toBe(false);
    expect(blocked.reason).toMatch(/reason/i);

    // Whitespace does not count.
    expect(gate(plan, { refundDest: "card_refund", dayofRefundReason: "   " }).enabled).toBe(false);

    expect(
      gate(plan, { refundDest: "card_refund", dayofRefundReason: "Pizza returned" }).enabled,
    ).toBe(true);
  });

  it("an environment refusal blocks Execute and shows the reason WITHOUT the env var", () => {
    // The dry-run still returns the whole priced preview — only running it is
    // refused. Staff must learn that BEFORE filling in a destination + reason.
    const plan = makePlan({
      diffCents: -1605,
      steps: [{ kind: "refund_dayof_payment", fatal: true, amountCents: 1605 }],
      executionBlocked: {
        code: "refund_not_enabled",
        message: "Refunding a closed visit is not switched on yet (RESERVATION_EDIT_V2_POST).",
      },
    });
    const blocked = gate(plan, {
      refundDest: "card_refund",
      dayofRefundReason: "Guest left early",
    });
    expect(blocked.enabled).toBe(false);
    expect(blocked.reason).toMatch(/not switched on yet/i);
    // It outranks the reason prompt — otherwise staff chase a field that
    // cannot unblock anything.
    expect(gate(plan, { refundDest: "card_refund" }).reason).toMatch(/not switched on yet/i);
    // A "(VAR=false)" note is stripped from staff copy.
    const withVar = makePlan({
      executionBlocked: {
        code: "edit_not_enabled",
        message:
          "Reservation editing has been switched off (RESERVATION_EDIT_V2=false) — only refunds are running.",
      },
    });
    expect(gate(withVar).reason).not.toContain("RESERVATION_EDIT_V2");
    expect(gate(withVar).reason).toMatch(/switched off — only refunds/);
  });

  it("classifies the server's flag refusal as blocked, never as an ack prompt", () => {
    // No checkbox unlocks a flag, so this must not reuse the manager-ack path.
    const action = classifyExecuteFailure(
      { status: 409, code: "refund_not_enabled", detail: "refunds after the visit is closed…" },
      -1605,
    );
    expect(action.kind).toBe("blocked");
  });

  it("plans without a day-of leg do not ask for a reason", () => {
    const plan = makePlan({
      diffCents: -500,
      steps: [{ kind: "refund_tender", fatal: true, amountCents: 500 }],
    });
    expect(gate(plan, { refundDest: "card_refund" }).enabled).toBe(true);
  });

  it("delta > 0 with a card on file → charge_card, enabled", () => {
    expect(gate(makePlan({ diffCents: 1000 }))).toEqual({
      enabled: true,
      reason: null,
      mode: "charge_card",
    });
  });

  it("delta > 0 without a card → payment_link CTA", () => {
    expect(gate(makePlan({ diffCents: 1000, chargeCard: null })).mode).toBe("payment_link");
  });

  it("delta < 0 gates execute on a refund destination", () => {
    const plan = makePlan({ diffCents: -800, chargeCard: null, settlement: "card_refund" });
    const before = gate(plan);
    expect(before).toEqual({
      enabled: false,
      reason: "Pick where the refund goes",
      mode: "refund",
    });
    expect(gate(plan, { refundDest: "store_credit" }).enabled).toBe(true);
  });

  it("delta = 0 with line changes → plain confirm", () => {
    expect(gate(makePlan({ diffCents: 0, settlement: "none" })).mode).toBe("confirm");
  });

  it("every manager warning needs its OWN tick, plus initials", () => {
    const plan = makePlan({
      phase: "pre",
      warnings: [
        managerWarning(),
        managerWarning({
          code: "combo_conqueror_count",
          manualStep: "Set the Conqueror bowler count to 6 by hand",
        }),
        { severity: "warning", code: "no_card_on_file", message: "no card" },
      ],
    });
    expect(planNeedsManagerAck(plan)).toBe(true);
    expect(managerCodes(plan)).toEqual(["qamf_count_increase_manual", "combo_conqueror_count"]);

    const none = gate(plan);
    expect(none.enabled).toBe(false);
    expect(none.reason).toMatch(/tick every red item/i);

    // One of two ticked → still the tick prompt.
    const one = gate(plan, { ackedCodes: new Set(["qamf_count_increase_manual"]) });
    expect(one.enabled).toBe(false);
    expect(one.reason).toMatch(/tick every red item/i);
    expect(missingAckCodes(plan, new Set(["qamf_count_increase_manual"]))).toEqual([
      "combo_conqueror_count",
    ]);

    // Both ticked, no initials → the initials prompt.
    const all = new Set(["qamf_count_increase_manual", "combo_conqueror_count"]);
    const noInitials = gate(plan, { ackedCodes: all });
    expect(noInitials.enabled).toBe(false);
    expect(noInitials.reason).toMatch(/initials/i);
    expect(gate(plan, { ackedCodes: all, ackInitials: "E" }).enabled).toBe(false);
    expect(gate(plan, { ackedCodes: all, ackInitials: "E0" }).enabled).toBe(false);

    expect(gate(plan, { ackedCodes: all, ackInitials: "eo" }).enabled).toBe(true);
  });

  it("a refreshed plan with a NEW manager code arrives unticked", () => {
    // The old sticky boolean carried one ack onto a materially different plan.
    // Per-code state: a tick for the first code does nothing for the second.
    const acked = new Set(["qamf_count_increase_manual"]);
    const first = makePlan({ warnings: [managerWarning()] });
    expect(gate(first, { ackedCodes: acked, ackInitials: "EO" }).enabled).toBe(true);
    const refreshed = makePlan({
      planHash: "hash-2",
      warnings: [managerWarning(), managerWarning({ code: "qamf_count_decrease_manual" })],
    });
    expect(gate(refreshed, { ackedCodes: acked, ackInitials: "EO" }).enabled).toBe(false);
    expect(missingAckCodes(refreshed, acked)).toEqual(["qamf_count_decrease_manual"]);
  });

  it("stale ticks are never sent — buildExecuteAck intersects with the current plan", () => {
    const plan = makePlan({ warnings: [managerWarning({ code: POST_COMPLETE_ACK_CODE })] });
    const acked = new Set([POST_COMPLETE_ACK_CODE, "qamf_count_increase_manual"]);
    expect(buildExecuteAck(plan, acked, " eo ")).toEqual({
      acknowledgedCodes: [POST_COMPLETE_ACK_CODE],
      acknowledgedBy: "EO",
    });
    // Nothing to acknowledge → no initials sent either.
    expect(buildExecuteAck(makePlan(), acked, "EO")).toEqual({ acknowledgedCodes: [] });
  });

  it("initials are two to four letters", () => {
    expect(isValidInitials("EO")).toBe(true);
    expect(isValidInitials(" abcd ")).toBe(true);
    expect(isValidInitials("E")).toBe(false);
    expect(isValidInitials("ABCDE")).toBe(false);
    expect(isValidInitials("E1")).toBe(false);
    expect(isValidInitials("")).toBe(false);
  });

  it("a plan with no manager warnings never asks for initials", () => {
    expect(gate(makePlan({ diffCents: 1000 }), { ackInitials: "" }).enabled).toBe(true);
  });
});

/* ── Notify defaults ──────────────────────────────────────────────────── */

describe("notify checkbox", () => {
  it("defaults on for a pre-visit edit, off for refunds / closed visits / racing", () => {
    expect(defaultNotifyGuest({ intent: "edit", phase: "pre", isRace: false })).toBe(true);
    expect(defaultNotifyGuest({ intent: "edit", phase: null, isRace: false })).toBe(true);
    expect(defaultNotifyGuest({ intent: "refund", phase: "post_complete", isRace: false })).toBe(
      false,
    );
    expect(defaultNotifyGuest({ intent: "edit", phase: "post_complete", isRace: false })).toBe(
      false,
    );
    expect(defaultNotifyGuest({ intent: "edit", phase: "pre", isRace: true })).toBe(false);
  });

  it("only edits get the 'updated confirmation' label", () => {
    expect(notifyLabel({ intent: "edit", phase: "pre" })).toMatch(/updated confirmation/);
    expect(notifyLabel({ intent: "refund", phase: "post_complete" })).not.toMatch(
      /updated confirmation/,
    );
    expect(notifyLabel({ intent: "edit", phase: "post_complete" })).not.toMatch(
      /updated confirmation/,
    );
  });
});

/* ── Success-screen derivations ───────────────────────────────────────── */

describe("manual steps", () => {
  it("prefers the engine's typed manualSteps and de-duplicates legacy warnings", () => {
    const result = makeResult({
      manualSteps: [
        {
          system: "conqueror",
          code: "qamf_count_increase_manual",
          message: "Add 1 bowler to Conqueror reservation X158469",
          predicted: true,
        },
      ],
      warnings: [
        { severity: "warning", code: "qamf_players_failed", message: "roster sync failed" },
        { severity: "info", code: "price_held", message: "held" },
      ],
    });
    const steps = collectManualSteps(result);
    expect(steps).toEqual([
      {
        system: "conqueror",
        code: "qamf_count_increase_manual",
        message: "Add 1 bowler to Conqueror reservation X158469",
        predicted: true,
      },
      {
        system: "conqueror",
        code: "qamf_players_failed",
        message: "roster sync failed",
        predicted: false,
      },
    ]);
    // Info lines that are not by-hand steps stay ordinary warnings.
    expect(residualWarnings(result, steps).map((w) => w.code)).toEqual(["price_held"]);
  });

  it("derives steps from legacy warning codes when manualSteps is absent", () => {
    const result = makeResult({
      warnings: [
        { severity: "warning", code: "qamf_players_failed", message: "Conqueror NOT updated" },
        { severity: "warning", code: "bmi_remove_failed", message: "BMI line still booked" },
        { severity: "info", code: "resend_manual", message: "guest not notified" },
      ],
    });
    expect(collectManualSteps(result).map((s) => [s.system, s.code])).toEqual([
      ["conqueror", "qamf_players_failed"],
      ["bmi", "bmi_remove_failed"],
      ["guest", "resend_manual"],
    ]);
    expect(collectManualSteps(makeResult())).toEqual([]);
  });

  it("toast suffix names the system(s) that need a hand", () => {
    const step = (system: "conqueror" | "bmi" | "guest") => ({
      system,
      code: "x",
      message: "m",
      predicted: false,
    });
    expect(manualFixSuffix([])).toBe("");
    expect(manualFixSuffix([step("conqueror")])).toBe(" — Conqueror needs a manual fix");
    expect(manualFixSuffix([step("conqueror"), step("bmi")])).toBe(
      " — Conqueror/BMI needs a manual fix",
    );
    expect(manualFixSuffix([step("guest")])).toMatch(/NOT notified/);
  });
});

describe("resultSummary", () => {
  it("charged / refunded / gift card / pending-payment variants", () => {
    expect(resultSummary("Ann", makeResult({ diffCents: 1234 }))).toBe(
      "Ann: reservation updated — $12.34 charged",
    );
    expect(resultSummary("Ann", makeResult({ diffCents: -500, refundIds: ["r1"] }))).toBe(
      "Ann: reservation updated — $5.00 refunded",
    );
    expect(
      resultSummary("Ann", makeResult({ diffCents: -500, storeCreditGan: "7783320012345678" })),
    ).toBe("Ann: reservation updated — $5.00 gift card 7783-3200-1234-5678");
    expect(
      resultSummary(
        "Ann",
        makeResult({
          state: "pending_payment",
          paymentIds: [],
          paymentLinkUrl: "https://headpinz.com/pay/edit/edit-101-a1?t=abc",
        }),
      ),
    ).toBe("Ann: edit pending payment — send the guest the $10.00 payment link");
    expect(resultSummary("Ann", makeResult({ diffCents: 0 }))).toBe("Ann: reservation updated");
  });

  it("appends the manual-fix suffix when Conqueror/BMI still need a hand", () => {
    expect(
      resultSummary(
        "Ann",
        makeResult({
          diffCents: -1703,
          refundIds: ["r1"],
          warnings: [
            { severity: "warning", code: "qamf_players_failed", message: "Conqueror NOT updated" },
          ],
        }),
      ),
    ).toBe("Ann: reservation updated — $17.03 refunded — Conqueror needs a manual fix");
  });
});
