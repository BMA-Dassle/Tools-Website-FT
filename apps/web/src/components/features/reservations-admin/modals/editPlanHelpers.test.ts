/**
 * Edit Reservation modal logic tests.
 *
 * NOTE: this repo has NO component-test infrastructure (vitest runs in the
 * node environment; jsdom / @testing-library are not installed), so per the
 * PR-5 test plan these cover the modal's behavior at the logic layer —
 * editPlanHelpers (which the modal and useEditPlan are thin React shells
 * over) with a mocked global fetch: mount-gate classification, spec
 * assembly, diff-table pairing, execute gating, execute-failure handling
 * (plan_stale auto-refresh, not_enabled, payment fallback), and success
 * summaries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EditCurrentState,
  EditPlan,
  EditPlanLeg,
  PlanLine,
} from "~/features/reservation-edit/plan";
import type { EditResult } from "~/features/reservation-edit/service";
import {
  buildDiffRows,
  buildSpec,
  classifyExecuteFailure,
  classifyMountOutcome,
  emptyForm,
  executeGate,
  isEmptySpec,
  planNeedsManagerAck,
  postEdit,
  resultSummary,
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
  newNeonLines: null,
  newPlayerCount: 5,
  newLaneCount: null,
  removedHeats: null,
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
  ...over,
});

const makePlan = (over: Partial<EditPlan> = {}): EditPlan => ({
  anchorId: 101,
  legIds: [101],
  isCombo: false,
  phase: "pre",
  spec: { playerCount: 5 },
  legs: [makeLeg()],
  diffCents: 1000,
  settlement: "charge",
  chargeCard: { cardId: "ccof:abc", brand: "VISA", last4: "4242" },
  giftCard: null,
  steps: [],
  warnings: [],
  current: makeCurrent(),
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

  it("maps a 409 to a typed error (mount blocked on cancelled)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "cancelled", detail: "cancelled" }, 409));
    const out = await postEdit("t", { neonId: 1, spec: {}, dryRun: true });
    expect(out).toEqual({
      kind: "error",
      error: { status: 409, code: "cancelled", detail: "cancelled" },
    });
    if (out.kind !== "error") throw new Error("expected error");
    expect(classifyMountOutcome(out)).toEqual({ kind: "blocked", message: "cancelled" });
  });

  it("treats the mount probe's no_changes as 'editable, form from detail'", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "no_changes" }, 400));
    const out = await postEdit("t", { neonId: 1, spec: {}, dryRun: true });
    if (out.kind !== "error") throw new Error("expected error");
    expect(classifyMountOutcome(out)).toEqual({ kind: "edit" });
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

  it("returns status 0 on transport failure → retryable mount error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    const out = await postEdit("t", { neonId: 1, spec: {}, dryRun: true });
    if (out.kind !== "error") throw new Error("expected error");
    expect(out.error.status).toBe(0);
    expect(classifyMountOutcome(out)).toEqual({ kind: "error", message: "boom" });
  });

  it("returns the EditResult on execute (dryRun:false)", async () => {
    const result = makeResult();
    fetchMock.mockResolvedValueOnce(jsonResponse(result));
    const out = await postEdit("t", {
      neonId: 101,
      spec: { playerCount: 5 },
      dryRun: false,
      planHash: "hash-1",
      notifyGuest: true,
    });
    expect(out).toEqual({ kind: "result", result });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body.dryRun).toBe(false);
    expect(body.planHash).toBe("hash-1");
    expect(body.notifyGuest).toBe(true);
    // managerOverride omitted entirely when not given:
    expect("managerOverride" in body).toBe(false);
  });

  it("flags a dry-run 200 without a plan as bad_response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const out = await postEdit("t", { neonId: 1, spec: {}, dryRun: true });
    if (out.kind !== "error") throw new Error("expected error");
    expect(out.error.code).toBe("bad_response");
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
    if (a.kind === "blocked") expect(a.message).toMatch(/not enabled/i);
  });

  it("payment_required on an increase → error with payment-link fallback", () => {
    const a = classifyExecuteFailure(
      { status: 400, code: "payment_required", detail: "card declined" },
      1500,
    );
    expect(a).toEqual({ kind: "error", message: "card declined", offerPaymentLink: true });
  });

  it("edit_failed 502 on a decrease → retryable error, no link offer", () => {
    const a = classifyExecuteFailure({ status: 502, code: "edit_failed", detail: "boom" }, -500);
    expect(a).toEqual({ kind: "error", message: "boom", offerPaymentLink: false });
  });

  it("other 409s (phase moved under us) → blocked", () => {
    const a = classifyExecuteFailure(
      { status: 409, code: "phase_conflict", detail: "order moved" },
      1000,
    );
    expect(a).toEqual({ kind: "blocked", message: "order moved" });
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

/* ── Execute gating (delta states + manager ack) ──────────────────────── */

describe("executeGate", () => {
  const gate = (plan: EditPlan | null, over: Partial<Parameters<typeof executeGate>[0]> = {}) =>
    executeGate({
      plan,
      planLoading: false,
      refundDest: null,
      needsManagerAck: false,
      managerAcked: false,
      ...over,
    });

  it("disabled without a plan or while repricing", () => {
    expect(gate(null).enabled).toBe(false);
    expect(gate(makePlan(), { planLoading: true }).enabled).toBe(false);
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

  it("manager warning requires the acknowledgment checkbox", () => {
    const plan = makePlan({
      phase: "post_complete",
      warnings: [
        { severity: "manager", code: "post_complete_no_external_sync", message: "no QAMF/BMI" },
      ],
    });
    expect(planNeedsManagerAck(plan)).toBe(true);
    const blocked = gate(plan, { needsManagerAck: true });
    expect(blocked.enabled).toBe(false);
    expect(blocked.reason).toMatch(/acknowledge/i);
    expect(gate(plan, { needsManagerAck: true, managerAcked: true }).enabled).toBe(true);
  });
});

/* ── Success summaries ────────────────────────────────────────────────── */

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
    expect(resultSummary("Ann", makeResult({ state: "pending_payment", paymentIds: [] }))).toBe(
      "Ann: edit pending payment — link created (edit-101-a1)",
    );
    expect(resultSummary("Ann", makeResult({ diffCents: 0 }))).toBe("Ann: reservation updated");
  });
});
