/**
 * markBookingRecordCancelled: the cascade's close of bmi-cancel-sweep's
 * booking-record gate. Covers the 17-digit id precision through the
 * read-modify-write, TTL preservation, and idempotency.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
let ttlValue = 12345;

vi.mock("@/lib/redis", () => ({
  default: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return "OK";
    }),
    ttl: vi.fn(async () => ttlValue),
  },
}));

import redis from "@/lib/redis";
import { markBookingRecordCancelled } from "./booking-record";

const BILL = "63000000004198690";

beforeEach(() => {
  store.clear();
  ttlValue = 12345;
  vi.clearAllMocks();
});

describe("markBookingRecordCancelled", () => {
  it("returns not_found when no record exists (expired / evicted)", async () => {
    const r = await markBookingRecordCancelled({ bmiBillId: BILL, cancelledBy: "admin" });
    expect(r).toBe("not_found");
  });

  it("marks a confirmed record cancelled, preserving 17-digit ids and TTL", async () => {
    // billId as a BARE number — JSON.parse alone would round it (…690 → …688/692).
    store.set(
      `bookingrecord:${BILL}`,
      `{"billId":${BILL},"status":"confirmed","racers":[{"personId":63000000004198777}]}`,
    );
    const r = await markBookingRecordCancelled({ bmiBillId: BILL, cancelledBy: "admin" });
    expect(r).toBe("cancelled");

    const written = store.get(`bookingrecord:${BILL}`)!;
    expect(written).toContain(BILL); // full precision survived the round-trip
    expect(written).toContain("63000000004198777");
    const rec = JSON.parse(written);
    expect(rec.status).toBe("cancelled");
    expect(rec.cancelledAt).toBeTruthy();
    expect(rec.cancelledBy).toBe("admin");
    // Remaining TTL preserved, not reset to the full 90 days.
    expect(vi.mocked(redis.set)).toHaveBeenCalledWith(
      `bookingrecord:${BILL}`,
      expect.any(String),
      "EX",
      12345,
    );
  });

  it("falls back to the 90-day TTL when the key has no expiry", async () => {
    ttlValue = -1;
    store.set(`bookingrecord:${BILL}`, `{"billId":"${BILL}","status":"confirmed"}`);
    await markBookingRecordCancelled({ bmiBillId: BILL, cancelledBy: "customer" });
    expect(vi.mocked(redis.set)).toHaveBeenCalledWith(
      `bookingrecord:${BILL}`,
      expect.any(String),
      "EX",
      60 * 60 * 24 * 90,
    );
  });

  it("is idempotent — an already-cancelled record is left untouched", async () => {
    store.set(
      `bookingrecord:${BILL}`,
      `{"billId":"${BILL}","status":"cancelled","cancelledAt":"2026-07-07T19:56:49.223Z"}`,
    );
    const r = await markBookingRecordCancelled({ bmiBillId: BILL, cancelledBy: "admin" });
    expect(r).toBe("already_cancelled");
    expect(vi.mocked(redis.set)).not.toHaveBeenCalled();
  });
});
