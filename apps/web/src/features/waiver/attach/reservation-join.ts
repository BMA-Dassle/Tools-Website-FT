import { useEffect, useRef } from "react";
import type { CenterCode, PartyMember } from "~/features/booking";

/** The reservation a signed guest attaches to (BMI Office project + location). */
export interface ReservationTarget {
  locationId: number;
  projectId: string;
}

export interface UseReservationJoinAttachArgs {
  /** Roster to scan — a member joins the moment it has a person id + valid waiver. */
  party: PartyMember[];
  /** Reservation to attach to; null while none is selected (the pipeline no-ops). */
  target: ReservationTarget | null;
  /** Venue center — drives the /join payload + location routing. */
  center: CenterCode | null;
  /** Provisioned kiosk id, or null off a kiosk (the mobile /waiver flow). */
  kioskId?: string | null;
  /** Master gate (e.g. until device config / brand resolves). Default true. */
  enabled?: boolean;
  /** When provided, ONLY these member ids attach. The mobile /waiver flow passes
   *  its participating set so an adult added purely to sign for a minor ("No,
   *  just signing") never lands in the reservation's headcount — that count feeds
   *  guest totals and billing (owner 2026-07-30). Omitted = attach everyone,
   *  which is the kiosk group-waiver behavior. */
  participatingIds?: ReadonlySet<string> | null;
  /** Fires as each member's join POST starts — bump an in-flight counter. */
  onJoinStart?: () => void;
  /** Fires in the POST's finally — decrement the counter + refetch the roster. */
  onJoinSettled?: () => void;
}

/**
 * Does this member attach to the reservation right now?
 *
 * Exported and pure so the rule is testable without a React renderer — it decides
 * who lands in a real event's headcount, which feeds guest totals and billing.
 * Returns the person id to POST, or null to skip.
 */
export function attachPersonId(
  member: PartyMember,
  participatingIds: ReadonlySet<string> | null,
): string | null {
  // Signer-only guardians stay in `party` (their own waiver is tracked, and the
  // minor's guardian reference must resolve) but never join the reservation.
  if (participatingIds && !participatingIds.has(member.id)) return null;
  if (!member.waiverValid) return null;
  return member.pandoraPersonId ?? member.bmiPersonId ?? null;
}

/**
 * The waiver reservation-attach pipeline — lifted verbatim from KioskWaiverFlow so
 * the in-center kiosk AND the mobile /waiver flow share one implementation.
 *
 * Any PARTY member with a person id (short Pandora preferred, else the 17-digit
 * Office id) AND a valid waiver is POSTed to /api/kiosk/waiver/join — Neon
 * persist-first, then the probe-gated BMI registerProjectPerson. Signer-only
 * guardians never reach here (they're not in `party`). A ref-held `posted` set
 * makes it idempotent: every ready path (fresh signature, onboard-returns-valid,
 * returning lookup with a current waiver, the authoritative re-check patch) fires
 * the join exactly once; a failed POST is un-marked so the next party change retries.
 */
export function useReservationJoinAttach({
  party,
  target,
  center,
  kioskId = null,
  enabled = true,
  participatingIds = null,
  onJoinStart,
  onJoinSettled,
}: UseReservationJoinAttachArgs): void {
  // person ids already POSTed to /join — the pipeline must never double-post.
  const postedRef = useRef<Set<string>>(new Set());
  // Latest callbacks kept in refs so their identity never re-runs the attach
  // effect — it should re-run on party / target / center changes only. Synced in
  // an effect (never mutated during render) per react-hooks/refs.
  const onJoinStartRef = useRef(onJoinStart);
  const onJoinSettledRef = useRef(onJoinSettled);
  useEffect(() => {
    onJoinStartRef.current = onJoinStart;
    onJoinSettledRef.current = onJoinSettled;
  });

  useEffect(() => {
    if (!enabled || !target || !center) return;
    for (const m of party) {
      const pid = attachPersonId(m, participatingIds);
      if (!pid || postedRef.current.has(pid)) continue;
      postedRef.current.add(pid);
      onJoinStartRef.current?.();
      void fetch("/api/kiosk/waiver/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          center,
          locationId: target.locationId,
          projectId: target.projectId,
          personId: pid,
          firstName: m.firstName,
          lastName: m.lastName ?? "",
          kioskId,
        }),
      })
        .catch(() => {
          // Allow a retry on the next party change — the join never got saved.
          postedRef.current.delete(pid);
        })
        .finally(() => {
          onJoinSettledRef.current?.();
        });
    }
  }, [party, target, center, kioskId, enabled, participatingIds]);
}
