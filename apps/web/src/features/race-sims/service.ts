/**
 * Race Sims booking service — books sim sessions onto the shared BMI bill.
 *
 * A sim item carries MANY sessions (racing's heats[] shape); each session is
 * ONE $0 track-key line for the whole party, eager-held the moment the guest
 * picks it (racing's holdPickedHeats semantics). The session's track decides
 * WHICH key books (racing-style per-track keys); all three keys draw the same
 * "Race Sim" resource sessions, so BMI's freeSpots (capacity 4) gates seats.
 *
 * FastTrax FM only — the bill lives in the FM BMI, so no clientKey is passed
 * (the /api/bmi proxy defaults to the FM key; duck-pin precedent).
 */
import type { Dispatch } from "react";
import type { Action } from "~/features/booking/state/machine";
import type { BookingSession, RaceSimItem, RaceSimSession } from "~/features/booking/state/types";
import { bmiAdapter } from "~/features/booking/data/bmi";
import { registerContact } from "~/features/booking/service/bmi-register";
import { raceSimBookingTarget } from "./products";

const sameSession = (a: RaceSimSession, b: { trackKey: string; slot: string }) =>
  a.trackKey === b.trackKey && a.slot === b.slot;

/**
 * Hold ONE session (identified by track + slot) with BMI. Returns the item's
 * sessions with that session's bmiLineId + heldQty filled in, plus the bill
 * id the line actually landed on — and dispatches both onto the session, so
 * callers chaining several holds pass the returned values forward instead of
 * re-reading stale props (a reparent mid-chain must not split the lines
 * across two BMI orders).
 */
export async function bookRaceSimSession(
  session: BookingSession,
  item: RaceSimItem,
  which: { trackKey: string; slot: string },
  dispatch: Dispatch<Action>,
): Promise<{ sessions: RaceSimSession[]; bmiBillId: string | null }> {
  const idx = item.sessions.findIndex((s) => sameSession(s, which));
  if (idx < 0) throw new Error("Cannot book: session not on the item");
  const target = item.sessions[idx];
  if (target.bmiLineId) return { sessions: item.sessions, bmiBillId: session.bmiBillId }; // already held
  const key = raceSimBookingTarget(target.trackKey);
  if (!key) {
    // Keys not armed — the grid can't have offered real sessions, and reserve
    // guard 2e refuses the charge regardless. Loud, not silent.
    throw new Error("Race sim track key not configured");
  }

  const quantity = Math.max(1, item.racerCount);
  const result = await bmiAdapter.bookHeat({
    productId: key.productId,
    quantity,
    proposal: target.slotProposal,
    orderId: session.bmiBillId,
    clientKey: undefined, // FastTrax FM — proxy default key owns the bill
  });

  // Response orderId is AUTHORITATIVE — adopt it whenever it differs (BMI
  // silently reparents onto a fresh order when the chained order was
  // cancelled; attraction rail precedent, live find 2026-07-19).
  if (result.rawOrderId && result.rawOrderId !== session.bmiBillId) {
    dispatch({ type: "setBmiBillId", id: result.rawOrderId });
    // Attach the customer to the (possibly brand-new) bill immediately so a
    // sim reservation never exists without a contact. Non-fatal.
    await registerContact(result.rawOrderId, session.contact, session.party, undefined);
  }

  // heldQty records what BMI actually holds; racerCount keeps following the
  // roster, and the two disagreeing is the re-hold / refuse signal.
  const next = item.sessions.map((s, i) =>
    i === idx ? { ...s, bmiLineId: result.billLineId, heldQty: quantity } : s,
  );
  dispatch({ type: "updateItem", id: item.id, patch: { sessions: next } });
  return { sessions: next, bmiBillId: result.rawOrderId || session.bmiBillId };
}

/** Hold every session that isn't held yet — the checkout-time backstop
 *  (racing's bookHeatsOnAdvance skips heats that already carry a line).
 *  Threads the adopted bill id forward so every line lands on ONE order. */
export async function bookRaceSimSessions(
  session: BookingSession,
  item: RaceSimItem,
  dispatch: Dispatch<Action>,
): Promise<void> {
  let current = item;
  let onBill = session;
  for (const s of item.sessions) {
    if (s.bmiLineId) continue;
    const { sessions, bmiBillId } = await bookRaceSimSession(onBill, current, s, dispatch);
    current = { ...current, sessions };
    onBill = { ...onBill, bmiBillId };
  }
}
