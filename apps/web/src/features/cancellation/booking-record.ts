/**
 * Redis booking-record integration for the cancellation cascade.
 *
 * The check-in booking record (`bookingrecord:{billId}`, written by the
 * confirmation pages) doubles as bmi-cancel-sweep's "is this cancellation
 * intentional?" gate: a -4 BMI project whose booking record is cancelled is
 * left alone; one whose record still says "confirmed" gets RECOVERED back to
 * Confirmation (-3). Pandora's direct Firebird state write leaves
 * userUpdatedId=-1 — indistinguishable from BMI's auto-cancel bug — so this
 * record (plus the sweep's Neon backstop) is what tells the sweep our -4 was
 * deliberate. The cascade marks the record cancelled at COMMIT, before the
 * BMI -4 teardown write lands. (Res 11417 / W48833, 2026-07-07: the sweep
 * reverted a cascade's -4 within 5 minutes because this record still said
 * "confirmed".)
 *
 * Records can carry 17-digit BMI ids as bare JSON numbers — parseWithRawIds
 * keeps their full precision through the read-modify-write.
 */
import redis from "@/lib/redis";
import { parseWithRawIds } from "@ft/db";

/** Mirrors the TTL in app/api/booking-record/route.ts. */
const RECORD_TTL_FALLBACK = 60 * 60 * 24 * 90;

export type MarkRecordResult = "cancelled" | "already_cancelled" | "not_found";

export async function markBookingRecordCancelled(params: {
  bmiBillId: string;
  cancelledBy: string;
}): Promise<MarkRecordResult> {
  const key = `bookingrecord:${params.bmiBillId}`;
  const raw = await redis.get(key);
  if (!raw) return "not_found";
  const rec = parseWithRawIds<Record<string, unknown>>(raw);
  if (rec.status === "cancelled" || rec.status === "refunded") return "already_cancelled";
  const now = new Date().toISOString();
  rec.status = "cancelled";
  rec.cancelledAt = now;
  rec.cancelledBy = params.cancelledBy;
  rec.updatedAt = now;
  const ttl = await redis.ttl(key);
  await redis.set(key, JSON.stringify(rec), "EX", ttl > 0 ? ttl : RECORD_TTL_FALLBACK);
  return "cancelled";
}
