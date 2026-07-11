/**
 * Shared QAMF reschedule core — the ONLY way to move a bowling reservation's
 * time. QAMF has no BookedAt mutation (probed live 2026-07-10: PATCH rejects
 * the field at JSON deserialization, on Temporary and Confirmed alike), so a
 * time change is delete old -> create new -> confirm, with hard-won rules:
 *
 *  - Clear Neon's qamf_reservation_id BEFORE deleting — the reservation.deleted
 *    webhook would otherwise find the row and cancel+refund the booking.
 *  - QAMF DELETE on a Confirmed reservation only SOFT-cancels it (the block
 *    stays on the Conqueror grid as "Canceled" — the 2026-07-10 double-block);
 *    a second DELETE removes it. Delete -> verify -> delete; if the old block
 *    is still LIVE (neither gone nor Canceled) after that, ABORT before
 *    creating and re-link the old id — never two live reservations on a lane.
 *  - Preserve the old reservation's live Title ("VIP Exp." / "Futbal"
 *    prefixes, staff edits) on the recreate; fall back to canonical shapes.
 *  - The memo re-patch must include Title — QAMF validates it as required and
 *    400s a Notes-only PATCH.
 *
 * Callers own auth, validation, audit, notifications, and any combo gating.
 */
import {
  createReservation,
  deleteReservation,
  getReservation,
  patchReservation,
  setReservationStatus,
} from "@/lib/qamf-bowling";
import { buildQamfMemo, updateReservationReschedule } from "@/lib/bowling-db";
import { sql } from "@/lib/db";

export interface QamfRescheduleArgs {
  neonId: number;
  qamfCenterId: number;
  existing: {
    qamfReservationId?: string;
    guestName?: string;
    guestPhone?: string;
    guestEmail?: string;
    notes?: string;
    playerCount?: number;
    comboSpecialId?: string;
  };
  bookedAt: string;
  webOfferId: number;
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
  /** Log prefix, e.g. "[admin/reschedule]". */
  logTag: string;
}

export type QamfRescheduleOutcome =
  | { ok: true; newQamfId: string; title: string }
  | { ok: false; httpStatus: number; error: string };

export async function rescheduleQamfReservation(
  args: QamfRescheduleArgs,
): Promise<QamfRescheduleOutcome> {
  const {
    neonId,
    qamfCenterId,
    existing,
    bookedAt,
    webOfferId,
    optionId,
    optionType = "Game",
    logTag,
  } = args;

  const who = `${existing.guestName ?? "Guest"} (${existing.playerCount ?? 1}p)`;
  let title = existing.comboSpecialId ? `VIP Exp. ${who}` : who;

  if (existing.qamfReservationId) {
    // Capture the live title before the old reservation disappears.
    try {
      const live = await getReservation(qamfCenterId, existing.qamfReservationId);
      if (live.Title?.trim()) title = live.Title.trim();
    } catch {
      /* keep the fallback title */
    }

    // Webhook guard: unlink the old id first.
    try {
      const q = sql();
      await q`UPDATE bowling_reservations SET qamf_reservation_id = NULL WHERE id = ${neonId}`;
    } catch (err) {
      console.error(`${logTag} failed to clear old qamfId:`, err);
    }

    // Delete -> verify -> delete (soft-cancel behavior above).
    let oldStatus: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await deleteReservation(qamfCenterId, existing.qamfReservationId);
      } catch (err) {
        console.warn(
          `${logTag} neonId=${neonId} delete old QAMF ${existing.qamfReservationId} (attempt ${attempt}) failed:`,
          err instanceof Error ? err.message : err,
        );
      }
      try {
        oldStatus = (await getReservation(qamfCenterId, existing.qamfReservationId)).Status ?? null;
      } catch {
        oldStatus = null; // gone — the desired end state
      }
      if (oldStatus === null) break;
    }
    if (oldStatus && oldStatus !== "Canceled") {
      // Still live — abort BEFORE creating, and re-link so the booking keeps
      // its (unchanged) QAMF reservation.
      try {
        const q = sql();
        await q`UPDATE bowling_reservations SET qamf_reservation_id = ${existing.qamfReservationId} WHERE id = ${neonId}`;
      } catch (err) {
        console.error(`${logTag} failed to restore old qamfId after aborted delete:`, err);
      }
      return {
        ok: false,
        httpStatus: 502,
        error: `Could not remove the existing lane reservation (QAMF status ${oldStatus}) — nothing was changed. Try again.`,
      };
    }
    if (oldStatus === "Canceled") {
      console.warn(
        `${logTag} neonId=${neonId} old QAMF ${existing.qamfReservationId} stuck in Canceled — inventory released but the block may linger on the Conqueror grid.`,
      );
    } else {
      console.log(
        `${logTag} neonId=${neonId} old QAMF ${existing.qamfReservationId} fully removed`,
      );
    }
  }

  const qamfOptions: {
    Game?: { Id: number }[];
    Time?: { Id: number }[];
    Unlimited?: { Id: number }[];
  } = {};
  if (optionId) {
    if (optionType === "Time") qamfOptions.Time = [{ Id: optionId }];
    else if (optionType === "Unlimited") qamfOptions.Unlimited = [{ Id: optionId }];
    else qamfOptions.Game = [{ Id: optionId }];
  }

  let newQamfId: string;
  try {
    const created = await createReservation(qamfCenterId, {
      BookedAt: bookedAt,
      Title: title,
      Notes: existing.notes,
      Customer: {
        Guest: {
          Name: existing.guestName ?? "Guest",
          PhoneNumber: existing.guestPhone ?? "",
          Email: existing.guestEmail ?? "",
        },
      },
      WebOffer: { Id: webOfferId, Options: qamfOptions, Services: ["BookForLater"] },
      TotalPlayers: existing.playerCount ?? 1,
    });
    newQamfId = created.Id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "QAMF error";
    console.error(`${logTag} createReservation failed:`, msg);
    return { ok: false, httpStatus: 502, error: `QAMF failed to create new reservation: ${msg}` };
  }

  // Confirm — MUST succeed or the whole operation fails.
  try {
    await setReservationStatus(qamfCenterId, newQamfId, "Confirmed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "QAMF error";
    console.error(`${logTag} setReservationStatus failed:`, msg);
    try {
      await deleteReservation(qamfCenterId, newQamfId);
    } catch {
      /* best effort */
    }
    return { ok: false, httpStatus: 502, error: `QAMF failed to confirm new reservation: ${msg}` };
  }

  await updateReservationReschedule(neonId, bookedAt, newQamfId);

  // Reset status + clear lane-open fields (the lane-open processor re-derives
  // them at the new time). No status guard: reschedule must override even if
  // a webhook raced.
  try {
    const q = sql();
    await q`
      UPDATE bowling_reservations
      SET status = 'confirmed',
          dayof_order_sent_at = NULL,
          dayof_order_lane = NULL,
          dayof_payment_id = NULL,
          dayof_order_error = NULL
      WHERE id = ${neonId}
    `;
  } catch (err) {
    console.error(`${logTag} status reset failed:`, err);
  }

  // Restore the QAMF memo — Title is REQUIRED in the PATCH body.
  try {
    const memo = await buildQamfMemo(neonId);
    if (memo) {
      await patchReservation(qamfCenterId, newQamfId, { Title: title, Notes: memo });
    }
  } catch (err) {
    console.warn(`${logTag} memo patch failed:`, err instanceof Error ? err.message : err);
  }

  return { ok: true, newQamfId, title };
}
