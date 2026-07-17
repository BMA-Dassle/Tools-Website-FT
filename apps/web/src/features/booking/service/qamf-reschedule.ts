/**
 * Shared QAMF reschedule core — the ONLY way to move a bowling reservation's
 * time. Two mechanisms, tried in order:
 *
 * 1. IN-PLACE MOVE (default for `intent: "move"`, added 2026-07-14): spec
 *    v1.3's `PATCH /reservations/{id}/lanes` shifts every lane's
 *    StartTime/EndTime while keeping the reservation id, Title, Notes,
 *    players, and lane assignment. Live at our centers since Conqueror
 *    passed 15.13 (it 412'd VersionRequired before that — probed 7/11,
 *    verified working 7/14). No delete means no webhook guard, no
 *    double-block, no memo re-patch. Guarded: only when the live
 *    reservation still carries the SAME web offer + option the caller
 *    asked for (in-place can't change offer or duration) and is
 *    Temporary/Confirmed. Anything else falls through to #2.
 *
 * 2. DELETE + CREATE (fallback, and the only path for `intent: "rebook"`
 *    where the lane structure itself changes), with hard-won rules:
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
  moveReservationLanes,
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
  /**
   * "move" (default): time-only shift — same offer, same party, same lane
   * structure. Tries the in-place v1.3 lanes PATCH first, falling back to
   * delete+create.
   * "rebook": the lane structure must be REBUILT (player/lane-count change —
   * reservation-edit's lane-change path). Always delete+create; an in-place
   * "success" here would be a no-op move that silently skips the rebuild.
   */
  intent?: "move" | "rebook";
  /** Log prefix, e.g. "[admin/reschedule]". */
  logTag: string;
}

export type QamfRescheduleOutcome =
  | { ok: true; newQamfId: string; title: string }
  | { ok: false; httpStatus: number; error: string };

/** Neon updates shared by both mechanisms: booked_at + qamf id + status
 *  reset with day-of clearing (the lane-open processor re-derives at the
 *  new time). No status guard: reschedule must override even if a webhook
 *  raced. */
async function finalizeNeonReschedule(
  neonId: number,
  bookedAt: string,
  qamfId: string,
  logTag: string,
): Promise<void> {
  await updateReservationReschedule(neonId, bookedAt, qamfId);
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
}

/**
 * Render an instant as center-local wall-clock ISO with the real UTC offset,
 * e.g. "2026-07-15T15:30:00-04:00". REQUIRED for the lanes PATCH: Conqueror
 * takes the wall-clock portion as CENTER-LOCAL time and ignores the offset
 * (probed live 2026-07-14 — a Z-rendered 15:30 ET instant landed at 7:30 PM
 * ET, and the immediate GET echoed the requested instant so a same-moment
 * verify can't catch it). Writing local wall-clock + true offset is correct
 * under both interpretations. Both QAMF centers (9172 Fort Myers, 3148
 * Naples) are Eastern.
 */
function toCenterLocalIso(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // timeZoneName is "GMT-04:00" (or "GMT" for a zero offset).
  const gmt = get("timeZoneName");
  const offset = /GMT([+-]\d{2}:\d{2})/.exec(gmt)?.[1] ?? "+00:00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

/**
 * In-place move via v1.3 `PATCH /lanes`: shift every lane by the same delta
 * (target bookedAt minus the earliest lane start), keeping lane numbers and
 * durations. Returns a reason instead of throwing so the caller can fall
 * back to delete+create.
 */
async function tryInPlaceMove(params: {
  qamfCenterId: number;
  qamfReservationId: string;
  bookedAt: string;
  webOfferId: number;
  optionId?: number;
  optionType: "Game" | "Time" | "Unlimited";
}): Promise<{ ok: true; title: string } | { ok: false; reason: string }> {
  const { qamfCenterId, qamfReservationId, bookedAt, webOfferId, optionId, optionType } = params;

  let live;
  try {
    // "1.3" — the pinned version predates the lanes PATCH; read the same
    // schema we're about to write.
    live = await getReservation(qamfCenterId, qamfReservationId, "1.3");
  } catch (err) {
    return { ok: false, reason: `GET failed: ${err instanceof Error ? err.message : err}` };
  }

  if (live.Status !== "Confirmed" && live.Status !== "Temporary") {
    return { ok: false, reason: `live status is ${live.Status}` };
  }
  // In-place keeps the reservation's offer + option (and therefore its
  // duration). If the caller booked the new slot under anything else,
  // only a recreate honors it.
  if (live.WebOffer?.Id !== webOfferId) {
    return {
      ok: false,
      reason: `web offer ${live.WebOffer?.Id ?? "?"} != requested ${webOfferId}`,
    };
  }
  if (optionId) {
    const liveOptionIds = (live.WebOffer?.Options?.[optionType] ?? []).map((o) => o.Id);
    if (!liveOptionIds.includes(optionId)) {
      return { ok: false, reason: `option ${optionType}:${optionId} not on the live reservation` };
    }
  }

  const lanes = live.Lanes ?? [];
  if (lanes.length === 0) return { ok: false, reason: "live reservation has no lanes" };
  if (lanes.some((l) => !l.Id || typeof l.LaneNumber !== "number" || !l.StartTime || !l.EndTime)) {
    return { ok: false, reason: "lane is missing Id/LaneNumber/StartTime/EndTime" };
  }

  const targetMs = Date.parse(bookedAt);
  const anchorMs = Math.min(...lanes.map((l) => Date.parse(l.StartTime)));
  if (!Number.isFinite(targetMs) || !Number.isFinite(anchorMs)) {
    return { ok: false, reason: `unparseable time (target ${bookedAt})` };
  }
  const deltaMs = targetMs - anchorMs;

  try {
    await moveReservationLanes(
      qamfCenterId,
      qamfReservationId,
      lanes.map((l) => ({
        Id: l.Id,
        LaneNumber: l.LaneNumber,
        StartTime: toCenterLocalIso(Date.parse(l.StartTime) + deltaMs),
        EndTime: toCenterLocalIso(Date.parse(l.EndTime) + deltaMs),
      })),
    );
  } catch (err) {
    return {
      ok: false,
      reason: `lanes PATCH failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  // Verify the move landed. A 200 with unmoved lanes would strand the guest
  // at the old time — treat as failure so the recreate fallback fixes it.
  try {
    const after = await getReservation(qamfCenterId, qamfReservationId, "1.3");
    const afterAnchor = Math.min(...(after.Lanes ?? []).map((l) => Date.parse(l.StartTime)));
    if (afterAnchor !== targetMs) {
      return {
        ok: false,
        reason: `verify mismatch: lanes at ${new Date(afterAnchor).toISOString()}, wanted ${new Date(targetMs).toISOString()}`,
      };
    }
  } catch (err) {
    // PATCH already 200'd — a flaky verify GET must not trigger a recreate
    // of a reservation that (almost certainly) moved.
    console.warn(
      `[qamf-reschedule] verify GET failed after successful lanes PATCH (${qamfReservationId}) — trusting the 200:`,
      err instanceof Error ? err.message : err,
    );
  }

  return { ok: true, title: live.Title?.trim() ?? "" };
}

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
    intent = "move",
    logTag,
  } = args;

  const who = `${existing.guestName ?? "Guest"} (${existing.playerCount ?? 1}p)`;
  let title = existing.comboSpecialId ? `VIP Exp. ${who}` : who;

  // ── Mechanism 1: in-place lanes PATCH (time-only moves) ──────────────
  if (intent === "move" && existing.qamfReservationId) {
    const moved = await tryInPlaceMove({
      qamfCenterId,
      qamfReservationId: existing.qamfReservationId,
      bookedAt,
      webOfferId,
      optionId,
      optionType,
    });
    if (moved.ok) {
      console.log(
        `${logTag} neonId=${neonId} moved QAMF ${existing.qamfReservationId} in place -> ${bookedAt}`,
      );
      await finalizeNeonReschedule(neonId, bookedAt, existing.qamfReservationId, logTag);
      return { ok: true, newQamfId: existing.qamfReservationId, title: moved.title || title };
    }
    console.warn(
      `${logTag} neonId=${neonId} in-place move unavailable (${moved.reason}) — falling back to delete+create`,
    );
  }

  // ── Mechanism 2: delete + create ─────────────────────────────────────
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

  await finalizeNeonReschedule(neonId, bookedAt, newQamfId, logTag);

  // Restore the QAMF memo — Title is REQUIRED in the PATCH body. (The
  // in-place path never needs this: Notes survive untouched.)
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
