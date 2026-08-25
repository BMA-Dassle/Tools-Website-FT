import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const vault = vi.hoisted(() => ({
  captureCardFromDeposit: vi.fn(),
  countLiveReservationsForCustomer: vi.fn(),
  isDueForDisable: vi.fn(),
  listDueForDisable: vi.fn(),
  listPendingCaptures: vi.fn(),
  markDisabled: vi.fn(),
  recordCaptureFailure: vi.fn(),
  recordDisableFailure: vi.fn(),
}));
const cards = vi.hoisted(() => ({ disableCard: vi.fn() }));
const db = vi.hoisted(() => ({
  getBowlingReservation: vi.fn(),
  listCancelGroupReservations: vi.fn(),
}));
const audit = vi.hoisted(() => ({ recordAdminAction: vi.fn() }));

vi.mock("~/features/card-vault", () => vault);
vi.mock("~/features/account/data/cards", () => cards);
vi.mock("@/lib/bowling-db", () => db);
vi.mock("~/features/reservations-admin/audit", () => audit);

import { GET } from "./route";
import { reserveBaseKey } from "~/features/booking/service/reserve-idempotency";

const makeReq = (qs = ""): NextRequest =>
  new NextRequest(`https://x/api/cron/card-vault-sweep${qs}`);

const pendingRow = (partial: Record<string, unknown> = {}) => ({
  id: 11,
  squareCustomerId: "CUS_1",
  squareCardId: null,
  cardBrand: null,
  cardLast4: null,
  cardExpMonth: null,
  cardExpYear: null,
  fingerprint: null,
  sourceReservationId: 4211,
  sourceDepositOrderId: "DEP_1",
  sourcePaymentId: "PAY_1",
  weAdded: true,
  permanentConsent: false,
  consentSource: null,
  captureAttempts: 1,
  captureLastError: "boom",
  captureSkipReason: null,
  disabledAt: null,
  disableAttempts: 0,
  disableLastError: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...partial,
});

const dueRow = (partial: Record<string, unknown> = {}) =>
  pendingRow({
    id: 21,
    squareCardId: "ccof:DUE",
    cardBrand: "VISA",
    cardLast4: "4242",
    ...partial,
  });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  vault.listPendingCaptures.mockResolvedValue([]);
  vault.listDueForDisable.mockResolvedValue([]);
  vault.countLiveReservationsForCustomer.mockResolvedValue(0);
  vault.markDisabled.mockResolvedValue(undefined);
  vault.recordDisableFailure.mockResolvedValue(undefined);
  vault.recordCaptureFailure.mockResolvedValue(undefined);
  audit.recordAdminAction.mockResolvedValue(undefined);
  db.getBowlingReservation.mockResolvedValue({ id: 4211, status: "completed" });
  db.listCancelGroupReservations.mockResolvedValue([{ id: 4211, status: "completed" }]);
});

describe("GET /api/cron/card-vault-sweep — auth", () => {
  it("401s when CRON_SECRET is set and the bearer is wrong", async () => {
    process.env.CRON_SECRET = "s3cret";
    try {
      const res = await GET(makeReq());
      expect(res.status).toBe(401);
      expect(vault.listPendingCaptures).not.toHaveBeenCalled();
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
});

describe("GET /api/cron/card-vault-sweep — dryRun", () => {
  it("reports counts without capturing or disabling anything", async () => {
    vault.listPendingCaptures.mockResolvedValue([pendingRow()]);
    vault.listDueForDisable.mockResolvedValue([dueRow()]);
    vault.isDueForDisable.mockReturnValue(true);

    const res = await GET(makeReq("?dryRun=1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.dryRun).toBe(true);
    expect(json.captures).toMatchObject({ pending: 1, attempted: 0 });
    expect(json.disables).toMatchObject({ candidates: 1, due: 1, disabled: 0 });
    expect(json.disables.wouldDisable).toEqual([
      { id: 21, cardId: "ccof:DUE", reservationId: 4211 },
    ]);
    expect(vault.captureCardFromDeposit).not.toHaveBeenCalled();
    expect(cards.disableCard).not.toHaveBeenCalled();
    expect(vault.markDisabled).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/card-vault-sweep — phase 1 capture retry", () => {
  it("re-runs the capture with a deterministic cof baseKey from the stored payment id", async () => {
    vault.listPendingCaptures.mockResolvedValue([pendingRow()]);
    vault.captureCardFromDeposit.mockResolvedValue({ ok: true, cardId: "ccof:X", deduped: false });

    const res = await GET(makeReq());
    const json = await res.json();
    expect(json.captures).toMatchObject({ pending: 1, attempted: 1, succeeded: 1, failed: 0 });
    expect(vault.captureCardFromDeposit).toHaveBeenCalledWith({
      squareCustomerId: "CUS_1",
      paymentId: "PAY_1",
      reservationId: 4211,
      depositOrderId: "DEP_1",
      baseKey: reserveBaseKey("PAY_1"), // same key every sweep run → replay-safe
      sourceKind: "card",
      permanentConsent: false,
    });
  });

  it("we_added=false pending rows retry as the saved-card path", async () => {
    vault.listPendingCaptures.mockResolvedValue([pendingRow({ weAdded: false })]);
    vault.captureCardFromDeposit.mockResolvedValue({ ok: true, cardId: null, deduped: true });
    await GET(makeReq());
    expect(vault.captureCardFromDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: "saved" }),
    );
  });

  it("never re-probes a terminal row (skip reason set) — wallet / gift card / SOURCE_USED stay retired", async () => {
    vault.listPendingCaptures.mockResolvedValue([
      pendingRow({ captureSkipReason: "wallet" }),
      pendingRow({ id: 12, sourcePaymentId: "PAY_2", captureSkipReason: "terminal:SOURCE_USED" }),
      pendingRow({ id: 13, sourcePaymentId: "PAY_3" }),
    ]);
    vault.captureCardFromDeposit.mockResolvedValue({ ok: true, cardId: "ccof:Z", deduped: false });

    const res = await GET(makeReq());
    const json = await res.json();
    expect(json.captures).toMatchObject({ pending: 3, attempted: 1, skipped: 2, succeeded: 1 });
    expect(vault.captureCardFromDeposit).toHaveBeenCalledTimes(1);
    expect(vault.captureCardFromDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "PAY_3" }),
    );
  });

  it("counts failures without aborting the run", async () => {
    vault.listPendingCaptures.mockResolvedValue([
      pendingRow(),
      pendingRow({ id: 12, sourcePaymentId: "PAY_2" }),
    ]);
    vault.captureCardFromDeposit
      .mockResolvedValueOnce({ ok: false, error: "still failing" })
      .mockResolvedValueOnce({ ok: true, cardId: "ccof:Y", deduped: false });
    const res = await GET(makeReq());
    const json = await res.json();
    expect(json.captures).toMatchObject({ attempted: 2, succeeded: 1, failed: 1 });
  });
});

describe("GET /api/cron/card-vault-sweep — phase 2 disable", () => {
  it("disables a due card, marks the row, and audits card_vault_disable", async () => {
    vault.listDueForDisable.mockResolvedValue([dueRow()]);
    vault.isDueForDisable.mockReturnValue(true);
    cards.disableCard.mockResolvedValue({ ok: true });

    const res = await GET(makeReq());
    const json = await res.json();
    expect(json.disables).toMatchObject({ due: 1, disabled: 1, failed: 0 });
    expect(cards.disableCard).toHaveBeenCalledWith("ccof:DUE");
    expect(vault.markDisabled).toHaveBeenCalledWith(21);
    expect(audit.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 4211,
        action: "card_vault_disable",
        outcome: "success",
        actor: "card-vault-sweep",
      }),
    );
    // The predicate got the live group + customer live count.
    expect(vault.isDueForDisable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 21 }),
      [{ id: 4211, status: "completed" }],
      0,
      expect.any(Date),
    );
  });

  it("already-disabled from Square still counts as success (idempotent replay)", async () => {
    vault.listDueForDisable.mockResolvedValue([dueRow()]);
    vault.isDueForDisable.mockReturnValue(true);
    cards.disableCard.mockResolvedValue({ ok: true, alreadyDisabled: true });

    const res = await GET(makeReq());
    const json = await res.json();
    expect(json.disables).toMatchObject({ disabled: 1, alreadyDisabled: 1 });
    expect(vault.markDisabled).toHaveBeenCalledWith(21);
  });

  it("disable failure bumps attempts and audits a failed action", async () => {
    vault.listDueForDisable.mockResolvedValue([dueRow()]);
    vault.isDueForDisable.mockReturnValue(true);
    cards.disableCard.mockResolvedValue({ ok: false, error: "Square 500" });

    const res = await GET(makeReq());
    const json = await res.json();
    expect(json.disables).toMatchObject({ disabled: 0, failed: 1 });
    expect(vault.recordDisableFailure).toHaveBeenCalledWith(21, "Square 500");
    expect(vault.markDisabled).not.toHaveBeenCalled();
    expect(audit.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "card_vault_disable", outcome: "failed" }),
    );
  });

  it("defers not-due candidates (predicate false) without touching Square", async () => {
    vault.listDueForDisable.mockResolvedValue([dueRow()]);
    vault.isDueForDisable.mockReturnValue(false);
    vault.countLiveReservationsForCustomer.mockResolvedValue(2);

    const res = await GET(makeReq());
    const json = await res.json();
    expect(json.disables).toMatchObject({ due: 0, deferred: 1, disabled: 0 });
    expect(cards.disableCard).not.toHaveBeenCalled();
  });

  it("never disables when the source reservation can't be loaded (fail closed)", async () => {
    vault.listDueForDisable.mockResolvedValue([dueRow({ sourceReservationId: null })]);
    const res = await GET(makeReq());
    const json = await res.json();
    expect(json.disables).toMatchObject({ deferred: 1, disabled: 0 });
    expect(vault.isDueForDisable).not.toHaveBeenCalled();
    expect(cards.disableCard).not.toHaveBeenCalled();
  });

  it("passes the limit param to both list queries", async () => {
    await GET(makeReq("?limit=7"));
    expect(vault.listPendingCaptures).toHaveBeenCalledWith(7);
    expect(vault.listDueForDisable).toHaveBeenCalledWith(7);
  });
});
