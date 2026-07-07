/**
 * Sync an admin-edited reservation note to BMI — WITHOUT clobbering the
 * memos already there (Ultimate VIP / combo banners, express lane, POV
 * codes, staff-typed text).
 *
 * BMI's public `booking/memo` is a single overwriting field, so writing the
 * note through it would wipe the composed booking memo (the exact bug
 * reservation-memo.ts exists to prevent). Instead we go through the Office
 * PROJECT's private log via appendProjectPrivateNote, which read-merges the
 * current memo and appends inside its own marked section — everything
 * outside the section (the booking-time memo, staff notes) is preserved.
 *
 * Project resolution reuses the cancel cascade's proven resolver
 * (W-number search → kind===2, order-id fallback, number-match guard).
 * BMI ids are strings end to end.
 */
import { appendProjectPrivateNote, noteTimestamp } from "@/lib/bmi-office-actions";
import type { BowlingReservation } from "@/lib/bowling-db";
import { resolveBmiProject } from "~/features/cancellation/bmi-cancel";
import { resolveCenter } from "~/features/cancellation/centers";

/**
 * Append the edited note to the reservation's BMI project private log.
 * Best-effort: returns true only when the append succeeded. No-ops (false)
 * for rows without a BMI bill.
 */
export async function syncNoteToBmi(
  reservation: Pick<
    BowlingReservation,
    "id" | "bmiBillId" | "bmiReservationNumber" | "centerCode" | "productKind"
  >,
  note: string,
): Promise<boolean> {
  if (!reservation.bmiBillId) return false;
  try {
    const center = resolveCenter(reservation.centerCode, reservation.productKind);
    const resolved = await resolveBmiProject({
      bmiClientKey: center.bmiClientKey,
      bmiBillId: reservation.bmiBillId,
      bmiReservationNumber: reservation.bmiReservationNumber,
    });
    if (!resolved.projectId) {
      console.warn(
        `[reservations-admin] BMI note sync: no project for bill=${reservation.bmiBillId} — skipped`,
      );
      return false;
    }
    // pandoraStateSlug is the location the project actually lives under
    // (race projects → "fasttrax"), matching appendProjectPrivateNote's maps.
    return await appendProjectPrivateNote({
      centerCode: center.pandoraStateSlug,
      projectId: resolved.projectId,
      note: `[${noteTimestamp()}] Portal note: ${note}`,
    });
  } catch (err) {
    console.warn(
      `[reservations-admin] BMI note sync failed res=${reservation.id}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
