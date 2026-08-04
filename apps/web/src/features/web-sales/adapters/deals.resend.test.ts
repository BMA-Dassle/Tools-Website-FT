/**
 * The resend path: who it goes to, what it sends, and what it records.
 *
 * The Square-free half of the adapter, so the whole thing runs against mocks.
 * The assertion that matters most is the FIRST one: a gift's codes must default
 * to the recipient, never the buyer. Getting that backwards emails a live bearer
 * instrument to the wrong person, and the buyer already has their own receipt.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDealPurchase: vi.fn(),
  fulfilDealPurchase: vi.fn(),
  emailPurchasedVouchers: vi.fn(),
  smsPurchasedVouchers: vi.fn(),
  recordSaleAction: vi.fn(),
  listSaleActions: vi.fn(),
  getVoucherStatus: vi.fn(),
}));

vi.mock("~/features/deals/data/deal-purchases-db", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getDealPurchase: mocks.getDealPurchase,
}));
vi.mock("~/features/deals/service/purchase", () => ({
  fulfilDealPurchase: mocks.fulfilDealPurchase,
  dealScheduleUrl: () => "/book/laser-tag/v2?voucher=HPWK8EJPXCR",
}));
vi.mock("~/features/game-cards/service/voucher-mail", () => ({
  emailPurchasedVouchers: mocks.emailPurchasedVouchers,
  smsPurchasedVouchers: mocks.smsPurchasedVouchers,
}));
vi.mock("~/features/game-cards/service/native-voucher", () => ({
  getVoucherStatus: mocks.getVoucherStatus,
}));
vi.mock("../data/web-sales-audit-db", () => ({
  recordSaleAction: mocks.recordSaleAction,
  listSaleActions: mocks.listSaleActions,
}));

const { dealsAdapter, dealResendDefaults } = await import("./deals");
const { makeDealPurchaseRow } = await import("../test-support");

const ok = { ok: true as const };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emailPurchasedVouchers.mockResolvedValue(ok);
  mocks.smsPurchasedVouchers.mockResolvedValue(ok);
  mocks.recordSaleAction.mockResolvedValue(undefined);
  mocks.listSaleActions.mockResolvedValue([]);
  mocks.getVoucherStatus.mockResolvedValue(null);
});

const GIFT = {
  isGift: true,
  recipientName: "Dana",
  recipientEmail: "dana@example.com",
  recipientPhone: "+12395551234",
};

describe("dealResendDefaults", () => {
  it("sends a gift to the RECIPIENT, not the buyer", () => {
    expect(dealResendDefaults(makeDealPurchaseRow(GIFT))).toEqual({
      email: "dana@example.com",
      phone: "+12395551234",
    });
  });

  it("sends an ordinary purchase to the buyer", () => {
    expect(dealResendDefaults(makeDealPurchaseRow())).toEqual({
      email: "jacob@headpinz.com",
      phone: "+18138473894",
    });
  });
});

describe("resend", () => {
  it("emails the address on file exactly once for a multi-code purchase", async () => {
    // The bug this guards: a per-code send loop would fire three emails at a
    // buyer who bought three separate packs and expects one.
    mocks.getDealPurchase.mockResolvedValue(
      makeDealPurchaseRow({ combine: false, qty: 3, codes: ["A", "B", "C"] }),
    );
    await dealsAdapter.resend!({
      ref: "412",
      channel: "email",
      overrideEmail: null,
      overridePhone: null,
      actor: "admin",
    });
    expect(mocks.emailPurchasedVouchers).toHaveBeenCalledTimes(1);
    expect(mocks.emailPurchasedVouchers.mock.calls[0][0]).toMatchObject({
      to: "jacob@headpinz.com",
      codes: ["A", "B", "C"],
    });
  });

  it("honours an override and marks the audit row as redirected", async () => {
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow());
    await dealsAdapter.resend!({
      ref: "412",
      channel: "email",
      overrideEmail: "typo-fixed@example.com",
      overridePhone: null,
      actor: "admin",
    });
    expect(mocks.emailPurchasedVouchers.mock.calls[0][0].to).toBe("typo-fixed@example.com");
    expect(mocks.recordSaleAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "resend", source: "deals", ref: "412" }),
    );
    // `redirected` is what lets an audit reader tell a corrected address from an
    // ordinary "send it again".
    expect(mocks.recordSaleAction.mock.calls[0][0].detail).toMatchObject({
      redirected: true,
      email: "typo-fixed@example.com",
    });
  });

  it("tags an admin resend distinctly in the voucher audit trail", async () => {
    // Otherwise a staff redirect is indistinguishable from the original purchase
    // send, and "did the buyer ever actually get this?" becomes unanswerable.
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow());
    await dealsAdapter.resend!({
      ref: "412",
      channel: "email",
      overrideEmail: "other@example.com",
      overridePhone: null,
      actor: "admin",
    });
    expect(mocks.emailPurchasedVouchers.mock.calls[0][0].eventReason).toBe("admin-resend");
  });

  it("defers to the idempotent fulfilment path for an unfulfilled purchase", async () => {
    // `charged` means the money landed but the codes may not exist. Only
    // fulfilDealPurchase can cut them, and it is fenced so it will not double-mint.
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow({ status: "charged", codes: [] }));
    mocks.fulfilDealPurchase.mockResolvedValue({
      codes: ["HPWNEW"],
      mintPending: false,
      emailPending: false,
    });
    const res = await dealsAdapter.resend!({
      ref: "412",
      channel: "email",
      overrideEmail: null,
      overridePhone: null,
      actor: "admin",
    });
    expect(mocks.fulfilDealPurchase).toHaveBeenCalledOnce();
    expect(mocks.emailPurchasedVouchers).not.toHaveBeenCalled();
    expect(res.note).toBe("Sent.");
  });

  it("does NOT use the fulfilment path when the operator redirected the send", async () => {
    // fulfilDealPurchase hardcodes the address on the row, so it would silently
    // ignore the override and mail the wrong person.
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow({ status: "minted" }));
    await dealsAdapter.resend!({
      ref: "412",
      channel: "email",
      overrideEmail: "elsewhere@example.com",
      overridePhone: null,
      actor: "admin",
    });
    expect(mocks.fulfilDealPurchase).not.toHaveBeenCalled();
    expect(mocks.emailPurchasedVouchers.mock.calls[0][0].to).toBe("elsewhere@example.com");
  });

  it("refuses when there are no codes and no fulfilment path to run", async () => {
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow({ status: "sent", codes: [] }));
    await expect(
      dealsAdapter.resend!({
        ref: "412",
        channel: "email",
        overrideEmail: null,
        overridePhone: null,
        actor: "admin",
      }),
    ).rejects.toThrow(/no codes/i);
  });

  it("reports a per-channel failure without claiming success", async () => {
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow());
    mocks.smsPurchasedVouchers.mockResolvedValue({ ok: false, error: "carrier rejected" });
    const res = await dealsAdapter.resend!({
      ref: "412",
      channel: "both",
      overrideEmail: null,
      overridePhone: null,
      actor: "admin",
    });
    expect(res.emailOk).toBe(true);
    expect(res.smsOk).toBe(false);
    expect(res.note).toContain("carrier rejected");
  });

  it("does not attempt a channel it has no destination for", async () => {
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow({ buyerPhone: null }));
    const res = await dealsAdapter.resend!({
      ref: "412",
      channel: "sms",
      overrideEmail: null,
      overridePhone: null,
      actor: "admin",
    });
    expect(mocks.smsPurchasedVouchers).not.toHaveBeenCalled();
    expect(res.smsOk).toBe(false);
    expect(res.note).toContain("no phone number");
  });

  it("carries the gift framing so the recipient is not thanked for a purchase they did not make", async () => {
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow({ ...GIFT, giftMessage: "Happy birthday" }));
    await dealsAdapter.resend!({
      ref: "412",
      channel: "both",
      overrideEmail: null,
      overridePhone: null,
      actor: "admin",
    });
    expect(mocks.emailPurchasedVouchers.mock.calls[0][0]).toMatchObject({
      to: "dana@example.com",
      gift: { fromName: "Jacob Elliott", message: "Happy birthday" },
    });
    expect(mocks.smsPurchasedVouchers.mock.calls[0][0]).toMatchObject({
      phone: "+12395551234",
      giftFromName: "Jacob Elliott",
    });
  });
});

describe("previewResend", () => {
  it("builds the message through the real send path in preview mode", async () => {
    // A preview assembled by a second builder drifts from the send the first
    // time anyone edits one of them.
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow());
    mocks.emailPurchasedVouchers.mockResolvedValue({
      ok: true,
      subject: "Your Laser Tag + Game Card Pack voucher",
      text: "body",
    });
    const preview = await dealsAdapter.previewResend!({ ref: "412", channel: "email" });
    expect(mocks.emailPurchasedVouchers.mock.calls[0][0].preview).toBe(true);
    expect(preview).toEqual({ subject: "Your Laser Tag + Game Card Pack voucher", text: "body" });
  });

  it("never actually sends while previewing", async () => {
    mocks.getDealPurchase.mockResolvedValue(makeDealPurchaseRow());
    mocks.smsPurchasedVouchers.mockResolvedValue({ ok: true, text: "Your voucher is ready." });
    await dealsAdapter.previewResend!({ ref: "412", channel: "sms" });
    expect(mocks.smsPurchasedVouchers.mock.calls[0][0].preview).toBe(true);
    expect(mocks.recordSaleAction).not.toHaveBeenCalled();
  });
});
