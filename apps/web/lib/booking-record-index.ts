import redis from "@/lib/redis";

/**
 * Server-side booking-record reverse indexes, written at reserve/confirm time.
 *
 * Historically the `bookingrecord:res:{W#}` index was written ONLY by the web
 * confirmation page's PATCH (booking-record route). Bookings that never load
 * that page — every KIOSK booking, and any booking whose confirmation page was
 * never opened — therefore had no reverse index, so a scanned W-number or
 * confirmation code couldn't resolve to a billId. Writing the indexes here, the
 * moment payment/confirm hands us the numbers, makes scan-lookup work for all
 * bookings (kiosk check-in is the first consumer of the `code:` index).
 *
 * Idempotent + best-effort: the client PATCH still writes the same `res:` key,
 * and a Redis outage is non-fatal (the confirm itself already succeeded).
 * billId is a 17-digit BMI bigint — keep it a STRING; never Number() it.
 */

const TTL = 60 * 60 * 24 * 90; // 90 days — match booking-record/route.ts

export async function writeReservationIndexes(
  billId: string,
  reservationNumber: string | null | undefined,
  reservationCode: string | null | undefined,
): Promise<void> {
  try {
    if (reservationNumber) {
      await redis.set(`bookingrecord:res:${reservationNumber}`, billId, "EX", TTL);
    }
    // Index the code the guest actually holds (the emailed QR encodes this
    // value — BMI's native reservationCode when present, else `r{billId}`).
    if (reservationCode) {
      await redis.set(`bookingrecord:code:${reservationCode}`, billId, "EX", TTL);
    }
  } catch {
    // Redis down — non-fatal; the client confirmation PATCH re-writes `res:`.
  }
}
