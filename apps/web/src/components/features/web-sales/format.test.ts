import { describe, expect, it } from "vitest";
import { makeSaleRow } from "~/features/web-sales/test-support";
import {
  buyerLabel,
  isProblemRow,
  money,
  recipientLabel,
  refundChip,
  visibleCapabilities,
  whenLabel,
} from "./format";

describe("money", () => {
  it("renders cents as dollars", () => {
    expect(money(3621)).toBe("$36.21");
    expect(money(0)).toBe("$0.00");
    expect(money(100000)).toBe("$1000.00");
  });
});

describe("whenLabel", () => {
  it("renders in Eastern, not UTC", () => {
    // 02:00Z on the 4th is 22:00 ET on the 3rd. Rendering UTC here would show
    // staff a sale on the wrong day every evening.
    expect(whenLabel("2026-08-04T02:00:00Z")).toBe("8/3, 10:00 PM");
  });

  it("degrades to a dash on an unparseable timestamp", () => {
    expect(whenLabel("not-a-date")).toBe("—");
  });
});

describe("buyerLabel", () => {
  it("prefers the name, falls back to the email, then a dash", () => {
    expect(buyerLabel(makeSaleRow())).toBe("Jacob Elliott");
    expect(buyerLabel(makeSaleRow({ buyer: { ...makeSaleRow().buyer, name: null } }))).toBe(
      "jacob@headpinz.com",
    );
    expect(
      buyerLabel(makeSaleRow({ buyer: { ...makeSaleRow().buyer, name: null, email: null } })),
    ).toBe("—");
  });
});

describe("recipientLabel", () => {
  it("is null on an ordinary sale, so no empty column appears", () => {
    expect(recipientLabel(makeSaleRow())).toBeNull();
  });

  it("names the recipient on a gift", () => {
    const row = makeSaleRow({
      buyer: { ...makeSaleRow().buyer, recipientName: "Dana", recipientEmail: "dana@example.com" },
    });
    expect(recipientLabel(row)).toBe("Dana");
  });

  it("falls back to the recipient email when unnamed", () => {
    const row = makeSaleRow({
      buyer: { ...makeSaleRow().buyer, recipientName: null, recipientEmail: "dana@example.com" },
    });
    expect(recipientLabel(row)).toBe("dana@example.com");
  });
});

describe("refundChip", () => {
  it("shows nothing when nothing happened", () => {
    expect(refundChip(makeSaleRow())).toBeNull();
  });

  it("distinguishes a void from a refund", () => {
    // A void killed the value and left the money alone — it must not read as
    // money returned.
    expect(refundChip(makeSaleRow({ refund: { kind: "voided", at: "x", reason: null } }))).toEqual({
      label: "voided",
      tone: "muted",
    });
  });

  it("shows the amount taken back on a partial", () => {
    expect(
      refundChip(
        makeSaleRow({ refund: { kind: "partial", refundedCents: 1207, at: "x", destination: "card" } }),
      ),
    ).toEqual({ label: "−$12.07", tone: "warn" });
  });

  it("shows the full amount on a full refund", () => {
    expect(
      refundChip(
        makeSaleRow({ refund: { kind: "full", refundedCents: 3621, at: "x", destination: "gift_card" } }),
      ),
    ).toEqual({ label: "refunded $36.21", tone: "muted" });
  });
});

describe("isProblemRow", () => {
  it("is true only when the projection flagged one", () => {
    expect(isProblemRow(makeSaleRow())).toBe(false);
    expect(
      isProblemRow(
        makeSaleRow({ status: { code: "charged", label: "Awaiting codes", tone: "warn", problem: "stuck" } }),
      ),
    ).toBe(true);
  });
});

describe("visibleCapabilities", () => {
  it("hides an action the source does not implement, even if the row declares it", () => {
    // Belt and braces: a typo in a projection must never surface a Refund button
    // on a source with no refund handler.
    const row = makeSaleRow({
      capabilities: [
        { action: "resend", label: "Resend" },
        { action: "refund", label: "Refund" },
      ],
    });
    expect(visibleCapabilities(row, ["resend"]).map((c) => c.action)).toEqual(["resend"]);
    expect(visibleCapabilities(row, []).length).toBe(0);
  });

  it("keeps a blocked-but-supported action visible so it can render disabled", () => {
    const row = makeSaleRow({
      capabilities: [{ action: "refund", label: "Refund", blockedReason: "Already voided." }],
    });
    expect(visibleCapabilities(row, ["refund"])[0].blockedReason).toBe("Already voided.");
  });
});
