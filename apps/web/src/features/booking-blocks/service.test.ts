import { beforeEach, describe, expect, it, vi } from "vitest";

const data = vi.hoisted(() => ({
  findActiveBlocks: vi.fn(),
}));
vi.mock("./data", () => data);

import {
  BLOCK_CALL_CENTER,
  BLOCK_ERROR_CODE,
  blockResponseBody,
  blockStaffSummary,
  checkBookingBlock,
} from "./service";
import type { BookingBlockRow } from "./types";

const row = (partial: Partial<BookingBlockRow> = {}): BookingBlockRow => ({
  id: 1,
  kind: "phone",
  value: "2398512480",
  center: null,
  reason: "4 chargebacks after service delivered, $319.31",
  caseRef: "fJkdcVfqpxrJKHGyGkoPkB",
  submittedBy: "EO",
  active: true,
  createdAt: "2026-08-24T12:00:00.000Z",
  releasedAt: null,
  releasedBy: null,
  ...partial,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("checkBookingBlock", () => {
  it("allows a guest with no matching block", async () => {
    data.findActiveBlocks.mockResolvedValue([]);
    await expect(checkBookingBlock({ email: "someone@example.com" })).resolves.toEqual({
      blocked: false,
    });
  });

  it("blocks and reports every matched row and kind", async () => {
    data.findActiveBlocks.mockResolvedValue([
      row({ id: 4, kind: "phone" }),
      row({ id: 5, kind: "email", value: "tactics-spaces1s@icloud.com" }),
    ]);
    const d = await checkBookingBlock({
      email: "tactics-spaces1s@icloud.com",
      phone: "+12398512480",
    });
    expect(d.blocked).toBe(true);
    if (!d.blocked) throw new Error("unreachable");
    expect(d.matches).toHaveLength(2);
    expect(d.kinds).toEqual(["phone", "email"]);
  });

  it("dedupes kinds when several rows share one kind", async () => {
    data.findActiveBlocks.mockResolvedValue([
      row({ id: 1, kind: "email", value: "a@b.com" }),
      row({ id: 2, kind: "email", value: "c@d.com" }),
    ]);
    const d = await checkBookingBlock({ email: "a@b.com" });
    if (!d.blocked) throw new Error("expected blocked");
    expect(d.kinds).toEqual(["email"]);
    expect(d.matches).toHaveLength(2);
  });

  it("FAILS OPEN when the lookup throws, and says so loudly", async () => {
    // A block list must never be able to take checkout down. Losing one refusal
    // is far cheaper than refusing every paying guest.
    data.findActiveBlocks.mockRejectedValue(new Error("neon: connection reset"));
    await expect(checkBookingBlock({ phone: "2398512480" })).resolves.toEqual({ blocked: false });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("lookup FAILED"),
      expect.any(Error),
    );
  });

  it("never logs the guest's identity — only kinds and row ids", async () => {
    data.findActiveBlocks.mockResolvedValue([row({ id: 9, kind: "email" })]);
    await checkBookingBlock({ email: "tactics-spaces1s@icloud.com", phone: "+12398512480" });
    const logged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .flat()
      .join(" ");
    expect(logged).toContain("email");
    expect(logged).toContain("9");
    expect(logged).not.toContain("tactics-spaces1s");
    expect(logged).not.toContain("2398512480");
  });

  it("passes the whole candidate through so any field can match", async () => {
    data.findActiveBlocks.mockResolvedValue([]);
    const candidate = {
      email: "x@y.com",
      phone: "2392404970",
      squareCustomerId: "XRDGWN5W9H21DCYHKCS9VC9W08",
      bmiPersonId: "57362761",
      cardFingerprint: "sq-1-abc",
      center: "fort-myers",
    };
    await checkBookingBlock(candidate);
    expect(data.findActiveBlocks).toHaveBeenCalledWith(candidate);
  });
});

describe("guest-facing copy", () => {
  it("puts the HUMAN message in `error`, because the client renders that field", () => {
    // features/booking/service/checkout.ts does `throw new Error(data.error)`,
    // so a code in `error` would show the guest the literal "ACCOUNT_DISABLED".
    const body = blockResponseBody("en");
    expect(body.error).toBe(body.message);
    expect(body.error).toContain("Account Disabled");
    expect(body.error).not.toBe(BLOCK_ERROR_CODE);
    expect(body.code).toBe(BLOCK_ERROR_CODE);
  });

  it("tells the guest to call, and reveals NOTHING about disputes", async () => {
    const body = blockResponseBody("en");
    expect(body.code).toBe(BLOCK_ERROR_CODE);
    expect(body.message).toContain("Account Disabled");
    expect(body.message).toContain(BLOCK_CALL_CENTER);
    // The reason is a manager conversation, never a public screen.
    for (const leak of ["dispute", "chargeback", "banned", "fraud"]) {
      expect(body.message.toLowerCase()).not.toContain(leak);
    }
  });

  it("has a Spanish message carrying the same number", () => {
    const es = blockResponseBody("es");
    expect(es.message).toContain("Cuenta desactivada");
    expect(es.message).toContain(BLOCK_CALL_CENTER);
    expect(es.message).not.toBe(blockResponseBody("en").message);
  });

  it("returns the call-centre number as its own field for the UI", () => {
    expect(blockResponseBody().phone).toBe(BLOCK_CALL_CENTER);
  });
});

describe("blockStaffSummary", () => {
  it("gives staff the case reference and who imposed it", () => {
    const s = blockStaffSummary({
      blocked: true,
      kinds: ["phone"],
      matches: [row({ id: 12, center: "fort-myers" })],
    });
    expect(s).toContain("#12");
    expect(s).toContain("phone@fort-myers");
    expect(s).toContain("fJkdcVfqpxrJKHGyGkoPkB");
    expect(s).toContain("EO");
    expect(s).toContain("2026-08-24");
  });

  it("is null when nothing is blocked", () => {
    expect(blockStaffSummary({ blocked: false })).toBeNull();
  });
});
