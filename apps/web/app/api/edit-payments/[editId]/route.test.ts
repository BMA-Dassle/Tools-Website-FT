import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/edit-payments/[editId] — the guest pay-link completion. The
 * card-vault capture used to run with a hard-coded `sourceKind: "card"` and
 * `permanentConsent: false`, so a wallet payment became a stuck pending row
 * and a ticked "save my card" was silently dropped (COF-6). These pin the
 * forwarding of PaymentForm's tokenize tags into the capture.
 */

const db = vi.hoisted(() => ({ getBowlingReservation: vi.fn() }));
const log = vi.hoisted(() => ({ getEditEvent: vi.fn(), finishEditEvent: vi.fn() }));
const planner = vi.hoisted(() => ({ buildEditPlan: vi.fn() }));
const payLink = vi.hoisted(() => ({
  verifyPayLinkToken: vi.fn(),
  payLinkExpired: vi.fn(),
  payLinkExpiresAtMs: vi.fn(),
}));
const executor = vi.hoisted(() => ({ executeEditCascade: vi.fn() }));
const vault = vi.hoisted(() => ({ captureCardFromDeposit: vi.fn() }));

vi.mock("@/lib/bowling-db", () => db);
vi.mock("@/lib/reservation-edit-log", () => log);
vi.mock("~/features/reservation-edit/plan", () => planner);
vi.mock("~/features/reservation-edit/pay-link", () => payLink);
vi.mock("~/features/reservation-edit/service", () => executor);
vi.mock("~/features/reservation-edit", () => ({
  EditGuardError: class EditGuardError extends Error {
    code = "guard";
  },
}));
vi.mock("~/features/card-vault", () => vault);

import { POST } from "./route";

const EDIT_ID = "edit-4211-a1";
const ctx = { params: Promise.resolve({ editId: EDIT_ID }) };

const post = (body: Record<string, unknown>) =>
  POST(
    new NextRequest(`https://x/api/edit-payments/${EDIT_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx,
  );

beforeEach(() => {
  vi.clearAllMocks();
  db.getBowlingReservation.mockResolvedValue({
    id: 4211,
    bookedAt: "2026-09-01T18:00:00.000Z",
    guestName: "Ada Lovelace",
    squareCustomerId: "CUS_1",
    squareDepositOrderId: "DEP_1",
  });
  log.getEditEvent.mockResolvedValue({
    state: "pending_payment",
    createdAt: "2026-08-24T12:00:00.000Z",
    anchorReservationId: 4211,
    diffCents: 2500,
    spec: {},
    settlement: null,
    plan: { planHash: "h1" },
  });
  log.finishEditEvent.mockResolvedValue(undefined);
  planner.buildEditPlan.mockResolvedValue({ planHash: "h1" });
  payLink.verifyPayLinkToken.mockReturnValue(true);
  payLink.payLinkExpired.mockReturnValue(false);
  payLink.payLinkExpiresAtMs.mockReturnValue(Date.now() + 60_000);
  executor.executeEditCascade.mockResolvedValue({
    paymentIds: ["PAY_LINK_1"],
    state: "completed",
    diffCents: 2500,
  });
  vault.captureCardFromDeposit.mockResolvedValue({ ok: true, skipped: "test" });
});

describe("POST /api/edit-payments/[editId] — card-vault capture tags", () => {
  it("forwards the guest's sourceKind and 'save my card' consent into the capture", async () => {
    const res = await post({
      token: "t",
      cardNonce: "cnon:abc",
      sourceKind: "wallet",
      saveCardConsent: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, state: "completed", chargedCents: 2500 });

    expect(executor.executeEditCascade).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentSource: { kind: "nonce", token: "cnon:abc" },
        resumeEditId: EDIT_ID,
        actor: "guest",
      }),
    );
    expect(vault.captureCardFromDeposit).toHaveBeenCalledTimes(1);
    expect(vault.captureCardFromDeposit).toHaveBeenCalledWith({
      squareCustomerId: "CUS_1",
      paymentId: "PAY_LINK_1",
      reservationId: 4211,
      depositOrderId: "DEP_1",
      baseKey: "edit4211a1",
      sourceKind: "wallet", // NOT the old hard-coded "card"
      permanentConsent: true, // the guest's tick is honoured
    });
  });

  it("a typed card with consent unticked captures as a temporary card", async () => {
    await post({ token: "t", cardNonce: "cnon:abc", sourceKind: "card", saveCardConsent: false });
    expect(vault.captureCardFromDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: "card", permanentConsent: false }),
    );
  });

  it("an unknown / missing sourceKind is passed as undefined (vault skips it as no_source_kind)", async () => {
    await post({ token: "t", cardNonce: "cnon:abc", sourceKind: "bogus" });
    expect(vault.captureCardFromDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: undefined, permanentConsent: false }),
    );

    vault.captureCardFromDeposit.mockClear();
    await post({ token: "t", cardNonce: "cnon:abc" });
    expect(vault.captureCardFromDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: undefined, permanentConsent: false }),
    );
  });

  it("consent must be the boolean true — a truthy string is not consent", async () => {
    await post({ token: "t", cardNonce: "cnon:abc", sourceKind: "card", saveCardConsent: "yes" });
    expect(vault.captureCardFromDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ permanentConsent: false }),
    );
  });

  it("400 card_required without a nonce — nothing executes, nothing is captured", async () => {
    const res = await post({ token: "t", sourceKind: "card" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "card_required" });
    expect(executor.executeEditCascade).not.toHaveBeenCalled();
    expect(vault.captureCardFromDeposit).not.toHaveBeenCalled();
  });

  it("a capture failure never fails the completed payment", async () => {
    vault.captureCardFromDeposit.mockRejectedValue(new Error("vault down"));
    const res = await post({ token: "t", cardNonce: "cnon:abc", sourceKind: "card" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
