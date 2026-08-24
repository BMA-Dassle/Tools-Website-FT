/**
 * Race Sims booking service — books a sim session onto the shared BMI bill.
 *
 * Mirrors bookAttractionOnAdvance (gel/laser): one slot, one $0 track-key
 * line, eager hold the moment the guest picks a time. The track choice
 * selects WHICH key books (racing-style per-track keys, owner 2026-08-23);
 * all three keys draw the same "Race Sim" resource sessions, so BMI's
 * freeSpots (capacity 4) gates seats regardless of track.
 *
 * FastTrax FM only — the bill lives in the FM BMI, so no clientKey is passed
 * (the /api/bmi proxy defaults to the FM key; duck-pin precedent).
 */
import type { Dispatch } from "react";
import type { Action } from "~/features/booking/state/machine";
import type { BookingSession, RaceSimItem } from "~/features/booking/state/types";
import { bmiAdapter } from "~/features/booking/data/bmi";
import { registerContact } from "~/features/booking/service/bmi-register";
import { raceSimBookingTarget } from "./products";

export async function bookRaceSimOnAdvance(
  session: BookingSession,
  item: RaceSimItem,
  dispatch: Dispatch<Action>,
): Promise<void> {
  if (item.bmiLineId) return; // already booked
  if (!item.slotProposal) {
    throw new Error("Cannot book: slotProposal missing");
  }
  const target = raceSimBookingTarget(item.trackKey);
  if (!target) {
    // Keys not armed — the slot step can't have offered real slots, and
    // reserve guard 2e refuses the charge regardless. Loud, not silent.
    throw new Error("Race sim track key not configured");
  }

  const result = await bmiAdapter.bookHeat({
    productId: target.productId,
    quantity: Math.max(1, item.racerCount),
    proposal: item.slotProposal,
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

  dispatch({
    type: "updateItem",
    id: item.id,
    patch: { bmiLineId: result.billLineId },
  });
}
