import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getBowlingReservation: vi.fn(),
  getBowlingReservationByBillId: vi.fn(),
  listCancelGroupReservations: vi.fn(),
  updateBowlingReservationNotes: vi.fn(),
  updateGuestContact: vi.fn(),
  buildQamfMemo: vi.fn(),
}));
const cancelLog = vi.hoisted(() => ({ listCancelEventsByAnchors: vi.fn() }));
const editLog = vi.hoisted(() => ({ listEditEventsByAnchors: vi.fn() }));
const editSquare = vi.hoisted(() => ({ fetchRefundFacts: vi.fn() }));
const qamf = vi.hoisted(() => ({ patchReservation: vi.fn() }));
const square = vi.hoisted(() => ({
  fetchOrderFacts: vi.fn(),
  fetchPaymentFacts: vi.fn(),
  fetchGiftCardFacts: vi.fn(),
}));
const audit = vi.hoisted(() => ({
  listAdminActions: vi.fn(),
  recordAdminAction: vi.fn(),
}));
const bmiNotes = vi.hoisted(() => ({ syncNoteToBmi: vi.fn() }));

vi.mock("@/lib/bowling-db", () => db);
vi.mock("@/lib/reservation-cancel-log", () => cancelLog);
vi.mock("@/lib/reservation-edit-log", () => editLog);
vi.mock("~/features/reservation-edit/square-actions", () => editSquare);
vi.mock("@/lib/qamf-bowling", () => qamf);
vi.mock("~/features/cancellation/square-actions", () => square);
vi.mock("./audit", () => audit);
vi.mock("./bmi-notes", () => bmiNotes);

import {
  firstOrderId,
  getPaymentTimeline,
  getReservationDetail,
  updateGuestContactService,
  updateReservationNotes,
} from "./service";
import { guestPatchSchema, notesPatchSchema, detailQuerySchema } from "./schemas";

const BILL_ID = "18014567890123456789"; // > MAX_SAFE_INTEGER — must survive as a string

function row(partial: Record<string, unknown> = {}) {
  return {
    id: 4211,
    centerCode: "fort-myers",
    productKind: "open",
    status: "confirmed",
    bookedAt: "2026-07-06T21:30:00.000Z",
    guestName: "Marcus Webb",
    guestEmail: "marcus@example.com",
    guestPhone: "2395550147",
    notes: "old note",
    depositCents: 4500,
    totalCents: 13792,
    refundCents: 0,
    storeCreditCents: 0,
    rewardDiscountCents: 0,
    promoSavingsCents: 0,
    qamfConfirmAttempts: 0,
    attractionBookings: [],
    insertedAt: "2026-07-01T00:00:00.000Z",
    qamfReservationId: "R55100",
    squareDepositOrderId: "DEP1",
    squareGiftCardId: "GC1",
    squareDayofOrderId: "DAYOF1",
    ...partial,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  audit.recordAdminAction.mockResolvedValue(undefined);
  bmiNotes.syncNoteToBmi.mockResolvedValue(false);
});

describe("getReservationDetail", () => {
  it("composes row + money group + merged history (newest first), BMI id stays a string", async () => {
    const anchor = row({ bmiBillId: BILL_ID });
    db.getBowlingReservation.mockResolvedValue({ ...anchor, lines: [{ label: "Lane" }] });
    db.listCancelGroupReservations.mockResolvedValue([
      anchor,
      row({ id: 4212, productKind: "race", bmiBillId: BILL_ID }),
    ]);
    cancelLog.listCancelEventsByAnchors.mockResolvedValue([
      { id: 1, createdAt: "2026-07-04T10:00:00.000Z", outcome: "store_credit" },
    ]);
    audit.listAdminActions.mockResolvedValue([
      { id: 9, createdAt: "2026-07-05T10:00:00.000Z", action: "resend" },
    ]);

    const detail = await getReservationDetail({ id: 4211 });
    expect(detail).not.toBeNull();
    expect(detail!.group.map((l) => l.id)).toEqual([4211, 4212]);
    expect(detail!.group[1].bmiBillId).toBe(BILL_ID);
    expect(typeof detail!.group[1].bmiBillId).toBe("string");
    // History: action (7/05) before cancel (7/04) — newest first, both sources.
    expect(detail!.history.map((h) => h.source)).toEqual(["action", "cancel"]);
    // Cancel-event lookup covers EVERY leg id, not just the anchor.
    expect(cancelLog.listCancelEventsByAnchors).toHaveBeenCalledWith([4211, 4212]);
  });

  it("resolves ?billId= as a string and 404s cleanly", async () => {
    db.getBowlingReservationByBillId.mockResolvedValue(row({ id: 77 }));
    db.getBowlingReservation.mockResolvedValue({ ...row({ id: 77 }), lines: [] });
    db.listCancelGroupReservations.mockResolvedValue([row({ id: 77 })]);
    cancelLog.listCancelEventsByAnchors.mockResolvedValue([]);
    audit.listAdminActions.mockResolvedValue([]);

    const detail = await getReservationDetail({ billId: BILL_ID });
    expect(db.getBowlingReservationByBillId).toHaveBeenCalledWith(BILL_ID);
    expect(detail?.reservation.id).toBe(77);

    db.getBowlingReservation.mockResolvedValue(null);
    expect(await getReservationDetail({ id: 999999 })).toBeNull();
  });
});

describe("firstOrderId", () => {
  it("handles bare ids, JSON arrays (combo legs), and null", () => {
    expect(firstOrderId("ABC123")).toBe("ABC123");
    expect(firstOrderId('["ORD1","ORD2"]')).toBe("ORD1");
    expect(firstOrderId(null)).toBeNull();
    expect(firstOrderId(undefined)).toBeNull();
  });
});

describe("getPaymentTimeline", () => {
  it("dedups a shared day-of order and captures per-node errors without failing the whole timeline", async () => {
    const legA = row({ id: 1, squareDayofOrderId: '["SHARED"]' });
    const legB = row({
      id: 2,
      productKind: "race",
      squareDayofOrderId: "SHARED",
      squareGiftCardId: undefined,
    });
    db.getBowlingReservation.mockResolvedValue({ ...legA, lines: [] });
    db.listCancelGroupReservations.mockResolvedValue([legA, legB]);
    square.fetchOrderFacts.mockImplementation(async (id: string) => {
      if (id === "DEP1")
        return {
          id,
          state: "COMPLETED",
          totalCents: 4500,
          netDueCents: 0,
          tenders: [{ paymentId: "PAY1", amountCents: 4500 }],
          version: 1,
          locationId: "L",
          tenderCount: 1,
        };
      throw new Error("order gone");
    });
    square.fetchPaymentFacts.mockResolvedValue({
      id: "PAY1",
      status: "COMPLETED",
      amountCents: 4500,
      refundedCents: 0,
    });
    square.fetchGiftCardFacts.mockResolvedValue({
      id: "GC1",
      gan: "7783901234567890",
      state: "ACTIVE",
      balanceCents: 4500,
    });

    const tl = await getPaymentTimeline(1);
    expect(tl).not.toBeNull();
    const kinds = tl!.nodes.map((n) => n.kind);
    expect(kinds).toEqual(["deposit", "funding_gift_card", "dayof_order"]); // SHARED deduped to ONE node
    const deposit = tl!.nodes[0];
    expect(deposit.order?.tenders[0]).toMatchObject({ status: "COMPLETED", refundedCents: 0 });
    const dayof = tl!.nodes[2];
    expect(dayof.error).toContain("order gone"); // node-level error, timeline intact
  });

  it("adds the store-credit node for cancelled-to-gift-card groups", async () => {
    const cancelled = row({
      status: "cancelled",
      storeCreditGiftCardId: "SCGC",
      squareDayofOrderId: undefined,
      squareGiftCardId: undefined,
      squareDepositOrderId: undefined,
    });
    db.getBowlingReservation.mockResolvedValue({ ...cancelled, lines: [] });
    db.listCancelGroupReservations.mockResolvedValue([cancelled]);
    square.fetchGiftCardFacts.mockResolvedValue({
      id: "SCGC",
      gan: "7783909999990000",
      state: "ACTIVE",
      balanceCents: 5200,
    });

    const tl = await getPaymentTimeline(1);
    expect(tl!.nodes).toHaveLength(1);
    expect(tl!.nodes[0]).toMatchObject({
      kind: "store_credit",
      giftCard: { balanceCents: 5200, state: "ACTIVE" },
    });
  });

  it("surfaces refunds from BOTH ledgers, including money still PENDING", async () => {
    // Owner requirement: the Payments tab reflects everything done to a
    // reservation. A gift-card credit posts asynchronously, so an in-flight
    // refund has to be visible rather than looking like nothing happened.
    const r = row({
      squareDayofOrderId: undefined,
      squareGiftCardId: undefined,
      squareDepositOrderId: undefined,
    });
    db.getBowlingReservation.mockResolvedValue({ ...r, lines: [] });
    db.listCancelGroupReservations.mockResolvedValue([r]);
    cancelLog.listCancelEventsByAnchors.mockResolvedValue([{ refundIds: ["RF_CANCEL"] }]);
    editLog.listEditEventsByAnchors.mockResolvedValue([
      { refundIds: ["RF_EDIT", "RF_CANCEL"] }, // duplicate id must collapse
    ]);
    editSquare.fetchRefundFacts.mockImplementation(async (id: string) =>
      id === "RF_CANCEL"
        ? { paymentId: "PAY1", amountCents: 4500, status: "COMPLETED" }
        : { paymentId: "PAY_DAYOF", amountCents: 1605, status: "PENDING" },
    );

    const tl = await getPaymentTimeline(1);
    const node = tl!.nodes.find((n) => n.kind === "refunds");
    expect(node?.refunds).toHaveLength(2);
    expect(node?.refunds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "RF_CANCEL", status: "COMPLETED", source: "cancel" }),
        expect.objectContaining({ id: "RF_EDIT", status: "PENDING", source: "edit" }),
      ]),
    );
  });

  it("omits the refunds node entirely when nothing was ever refunded", async () => {
    const r = row({
      squareDayofOrderId: undefined,
      squareGiftCardId: undefined,
      squareDepositOrderId: undefined,
    });
    db.getBowlingReservation.mockResolvedValue({ ...r, lines: [] });
    db.listCancelGroupReservations.mockResolvedValue([r]);
    cancelLog.listCancelEventsByAnchors.mockResolvedValue([]);
    editLog.listEditEventsByAnchors.mockResolvedValue([]);

    const tl = await getPaymentTimeline(1);
    expect(tl!.nodes.some((n) => n.kind === "refunds")).toBe(false);
  });

  it("an unreadable refund still gets a row rather than vanishing", async () => {
    const r = row({
      squareDayofOrderId: undefined,
      squareGiftCardId: undefined,
      squareDepositOrderId: undefined,
    });
    db.getBowlingReservation.mockResolvedValue({ ...r, lines: [] });
    db.listCancelGroupReservations.mockResolvedValue([r]);
    cancelLog.listCancelEventsByAnchors.mockResolvedValue([{ refundIds: ["RF_GONE"] }]);
    editLog.listEditEventsByAnchors.mockResolvedValue([]);
    editSquare.fetchRefundFacts.mockRejectedValue(new Error("square down"));

    const tl = await getPaymentTimeline(1);
    const node = tl!.nodes.find((n) => n.kind === "refunds");
    expect(node?.refunds).toEqual([
      { id: "RF_GONE", amountCents: 0, status: "UNREADABLE", paymentId: "", source: "cancel" },
    ]);
  });
});

describe("updateReservationNotes — QAMF memo-sync matrix", () => {
  it("bowling with a QAMF id: memo re-patched, memoSynced true, audited with diff", async () => {
    db.getBowlingReservation.mockResolvedValue({ ...row(), lines: [] });
    db.buildQamfMemo.mockResolvedValue("MEMO TEXT");
    qamf.patchReservation.mockResolvedValue(undefined);

    const result = await updateReservationNotes(4211, "new note");
    expect(result).toEqual({ ok: true, memoSynced: true, bmiMemoSynced: false });
    expect(db.updateBowlingReservationNotes).toHaveBeenCalledWith(4211, "new note");
    // fort-myers slug → QAMF center 9172 (cancellation/centers.ts)
    expect(qamf.patchReservation).toHaveBeenCalledWith(9172, "R55100", { Notes: "MEMO TEXT" });
    // No BMI bill on a plain bowling row → BMI sync not attempted.
    expect(bmiNotes.syncNoteToBmi).not.toHaveBeenCalled();
    expect(audit.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "notes_edit",
        outcome: "success",
        detail: { from: "old note", to: "new note", memoSynced: true, bmiMemoSynced: false },
      }),
    );
  });

  it("race row with a BMI bill: no QAMF patch, note appended to the BMI project log", async () => {
    const raceRow = row({
      productKind: "race",
      qamfReservationId: undefined,
      bmiBillId: BILL_ID,
    });
    db.getBowlingReservation.mockResolvedValue({ ...raceRow, lines: [] });
    bmiNotes.syncNoteToBmi.mockResolvedValue(true);

    const result = await updateReservationNotes(4211, "headsock size XL");
    expect(result).toEqual({ ok: true, memoSynced: false, bmiMemoSynced: true });
    expect(qamf.patchReservation).not.toHaveBeenCalled();
    expect(bmiNotes.syncNoteToBmi).toHaveBeenCalledWith(
      expect.objectContaining({ bmiBillId: BILL_ID }),
      "headsock size XL",
    );
  });

  it("empty string clears to null and never appends an empty BMI log line", async () => {
    db.getBowlingReservation.mockResolvedValue({
      ...row({ productKind: "race", qamfReservationId: undefined, bmiBillId: BILL_ID }),
      lines: [],
    });
    const result = await updateReservationNotes(4211, "  ");
    expect(result).toEqual({ ok: true, memoSynced: false, bmiMemoSynced: false });
    expect(db.updateBowlingReservationNotes).toHaveBeenCalledWith(4211, null);
    expect(bmiNotes.syncNoteToBmi).not.toHaveBeenCalled();
    expect(qamf.patchReservation).not.toHaveBeenCalled();
  });

  it("memo patch failure: Neon still updated, memoSynced false, no throw", async () => {
    db.getBowlingReservation.mockResolvedValue({ ...row(), lines: [] });
    db.buildQamfMemo.mockResolvedValue("MEMO");
    qamf.patchReservation.mockRejectedValue(new Error("QAMF down"));

    const result = await updateReservationNotes(4211, "note");
    expect(result).toEqual({ ok: true, memoSynced: false, bmiMemoSynced: false });
    expect(db.updateBowlingReservationNotes).toHaveBeenCalled();
  });
});

describe("updateGuestContactService — partial semantics", () => {
  it("writes only when something changed and records a per-field diff", async () => {
    db.getBowlingReservation.mockResolvedValue({ ...row(), lines: [] });
    const result = await updateGuestContactService(4211, { guestEmail: "fixed@example.com" });
    expect(result?.changed).toEqual({
      guestEmail: { from: "marcus@example.com", to: "fixed@example.com" },
    });
    expect(db.updateGuestContact).toHaveBeenCalledWith(4211, { guestEmail: "fixed@example.com" });
    expect(audit.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "guest_edit", outcome: "success" }),
    );
  });

  it("no-op when values are identical — no write, no audit row", async () => {
    db.getBowlingReservation.mockResolvedValue({ ...row(), lines: [] });
    const result = await updateGuestContactService(4211, { guestEmail: "marcus@example.com" });
    expect(result?.changed).toEqual({});
    expect(db.updateGuestContact).not.toHaveBeenCalled();
    expect(audit.recordAdminAction).not.toHaveBeenCalled();
  });
});

describe("schemas", () => {
  it("detail query: coerces id, accepts billId as string, rejects empty", () => {
    expect(detailQuerySchema.parse({ id: "42" }).id).toBe(42);
    expect(detailQuerySchema.parse({ billId: BILL_ID }).billId).toBe(BILL_ID);
    expect(detailQuerySchema.safeParse({}).success).toBe(false);
  });

  it("notes: caps at 2000 chars; guest: requires at least one field + valid email", () => {
    expect(notesPatchSchema.safeParse({ neonId: 1, notes: "x".repeat(2001) }).success).toBe(false);
    expect(notesPatchSchema.parse({ neonId: 1, notes: "" }).notes).toBe("");
    expect(guestPatchSchema.safeParse({ neonId: 1 }).success).toBe(false);
    expect(guestPatchSchema.safeParse({ neonId: 1, guestEmail: "not-an-email" }).success).toBe(
      false,
    );
    expect(guestPatchSchema.parse({ neonId: 1, guestPhone: "2395550147" }).guestPhone).toBe(
      "2395550147",
    );
  });
});
