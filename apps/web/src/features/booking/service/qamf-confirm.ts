/**
 * QAMF reservation confirmation — extracted from /api/bowling/v2/reserve.
 *
 * Handles the hold-first confirm flow (existing hold → setCustomer → setStatus)
 * with a fresh-reservation fallback if the hold expired. Server-side only.
 */
import {
  createReservation,
  getReservation,
  setReservationCustomer,
  setReservationStatus,
  patchReservation,
  setLanePlayers,
  extendReservation,
  type Service,
} from "@/lib/qamf-bowling";

export interface QamfConfirmInput {
  centerId: number;
  qamfReservationId?: string;
  bookedAt: string;
  webOfferId: number;
  optionId?: number;
  optionType?: "Game" | "Time" | "Unlimited";
  service?: Service;
  guest: { name: string; phone: string; email: string };
  players: Array<{ name: string; bumpers?: boolean }>;
  notes?: string;
}

export interface QamfConfirmResult {
  qamfReservationId: string;
  confirmed: boolean;
  laneId: string | null;
}

export async function confirmQamfReservation(input: QamfConfirmInput): Promise<QamfConfirmResult> {
  const { centerId, bookedAt, webOfferId, guest, players, notes } = input;
  const service = input.service ?? "BookForLater";

  const qamfOptions: Record<string, Array<{ Id: number }>> = {};
  const optionType = input.optionType ?? "Game";
  if (input.optionId) {
    qamfOptions[optionType] = [{ Id: input.optionId }];
  }

  let qamfReservationId: string;
  let qamfConfirmed = false;
  let qamfLanes: Array<{ Id?: string; LaneNumber: number }> = [];

  async function attachAndConfirm(reservationId: string): Promise<boolean> {
    await setReservationCustomer(centerId, reservationId, {
      Guest: {
        Name: guest.name,
        PhoneNumber: guest.phone,
        Email: guest.email,
      },
    });
    return setReservationStatus(centerId, reservationId, "Confirmed");
  }

  async function createFresh(): Promise<{
    id: string;
    lanes: Array<{ Id?: string; LaneNumber: number }>;
  }> {
    const reservation = await createReservation(centerId, {
      BookedAt: bookedAt,
      Title: `${guest.name} (${players.length}p)`,
      Notes: notes,
      Customer: {
        Guest: {
          Name: guest.name,
          PhoneNumber: guest.phone,
          Email: guest.email,
        },
      },
      WebOffer: {
        Id: webOfferId,
        Options: qamfOptions,
        Services: [service],
      },
      TotalPlayers: players.length,
    });
    return { id: reservation.Id, lanes: reservation.Lanes ?? [] };
  }

  if (input.qamfReservationId) {
    qamfReservationId = input.qamfReservationId;

    let holdCustomerAttached = false;
    try {
      await Promise.all([
        setReservationCustomer(centerId, qamfReservationId, {
          Guest: {
            Name: guest.name,
            PhoneNumber: guest.phone,
            Email: guest.email,
          },
        }),
        patchReservation(centerId, qamfReservationId, {
          Title: `${guest.name} (${players.length}p)`,
          Notes: notes,
        }).catch(() => {}),
      ]);
      holdCustomerAttached = true;
    } catch {
      // Hold expired — fall through to fresh
    }

    if (holdCustomerAttached) {
      qamfConfirmed = await setReservationStatus(centerId, qamfReservationId, "Confirmed");
    }

    if (!qamfConfirmed) {
      const fresh = await createFresh();
      qamfReservationId = fresh.id;
      qamfLanes = fresh.lanes;
      qamfConfirmed = await attachAndConfirm(qamfReservationId).catch(() => false);
    }
  } else {
    const fresh = await createFresh();
    qamfReservationId = fresh.id;
    qamfLanes = fresh.lanes;
    qamfConfirmed = await attachAndConfirm(qamfReservationId).catch(() => false);
  }

  if (qamfLanes.length === 0) {
    try {
      const laneRes = await getReservation(centerId, qamfReservationId);
      qamfLanes = laneRes.Lanes ?? [];
    } catch {
      // Non-fatal
    }
  }

  if (qamfLanes.length > 0 && players.some((p) => p.name)) {
    const lane = qamfLanes[0];
    const laneId = lane.Id ?? String(lane.LaneNumber);
    setLanePlayers(
      centerId,
      qamfReservationId,
      laneId,
      players.map((p) => ({
        Name: p.name || "Bowler",
        ActivateBumpers: p.bumpers ?? false,
      })),
    ).catch(() => {});
  }

  return {
    qamfReservationId,
    confirmed: qamfConfirmed,
    laneId: qamfLanes[0]?.Id ?? (qamfLanes[0] ? String(qamfLanes[0].LaneNumber) : null),
  };
}

export { extendReservation };
