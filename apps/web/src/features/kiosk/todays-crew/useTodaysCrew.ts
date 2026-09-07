/**
 * Today's Crew — the ONE client hook both people components call (owner
 * 2026-09-06). The family lookup was hand-copied into KioskPeopleStep and
 * KioskPartyManager and had already drifted (one formats CRM names, the other
 * does not); this feature keeps its state and its rules in one place and the
 * two screens only render what it hands back.
 *
 * Per signed-in member it tracks: the lookup status (so the card can draw the
 * PENDING pill the instant the sign-in lands — owner: the pills must never
 * "randomly appear"), the un-added co-bookers, and whether the sheet has
 * already popped for them. `load` is fired from the same spot the family
 * fetch fires — handleVerified and the setup-form attach branch.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CenterSlug } from "../checkin/centers";
import { shouldAutoOpenCrew } from "./todays-crew";
import type { CrewStatus, CrewSuggestion, TodaysCrewResponse } from "./types";

/** A co-booker plus the roster member whose booking listed them — the pill
 *  and the sheet hang off THAT person's card, exactly like the family pill. */
export interface CrewEntry extends CrewSuggestion {
  ownerMemberId: string;
}

export interface UseTodaysCrewOptions {
  /** The kiosk's centre; null (the phone /waiver flow has no kiosk) disables. */
  center: CenterSlug | null;
  /** Kill switch + centre known. */
  enabled: boolean;
  /** Pop the sheet once per member when the lookup finds someone. Booking
   *  screens and the crew page say yes; check-in and the waiver flow say no. */
  autoOpen: boolean;
  /** BMI person ids already on the roster, read when the lookup resolves. */
  rosterIds: () => Set<string>;
  /** Is any other overlay up right now (lookup, form, licence picker, the
   *  split-payment warning, the family sheet…)? Read when the lookup resolves. */
  overlayOpen: () => boolean;
}

export function useTodaysCrew(opts: UseTodaysCrewOptions) {
  // Options are read through a ref at RESOLVE time: `load` is async and the
  // caller's closures would otherwise be the ones from the render that fired
  // it — stale `lookupOpen`, stale roster. Written in an effect (not during
  // render, per the React rules) — a fetch always resolves after the commit.
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const [crew, setCrew] = useState<CrewEntry[]>([]);
  const crewRef = useRef<CrewEntry[]>([]);
  const commitCrew = (next: CrewEntry[]) => {
    crewRef.current = next;
    setCrew(next);
  };
  const [status, setStatus] = useState<Record<string, CrewStatus>>({});
  /** The member id whose sheet is open; null = closed. */
  const [open, setOpen] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  /** Members the sheet has already popped for — once per member per session. */
  const offeredRef = useRef<Set<string>>(new Set());

  const setMemberStatus = (memberId: string, s: CrewStatus) =>
    setStatus((prev) => ({ ...prev, [memberId]: s }));

  const load = useCallback(async (personId: string, memberId: string, alreadyIds: Set<string>) => {
    const o = optsRef.current;
    if (!o.enabled || !o.center) return;
    setMemberStatus(memberId, "loading");
    try {
      const res = await fetch(
        `/api/kiosk/todays-crew?personId=${encodeURIComponent(personId)}&center=${o.center}`,
      );
      if (!res.ok) {
        setMemberStatus(memberId, "error");
        return;
      }
      const data = (await res.json()) as TodaysCrewResponse;
      const taken = new Set<string>([...alreadyIds, ...optsRef.current.rosterIds()]);
      const have = new Set(crewRef.current.map((c) => c.id));
      const fresh: CrewEntry[] = (data.crew ?? [])
        .filter((c) => !taken.has(c.id) && !have.has(c.id))
        .map((c) => ({ ...c, ownerMemberId: memberId }));
      if (fresh.length > 0) commitCrew([...crewRef.current, ...fresh]);
      const mine = crewRef.current.filter((c) => c.ownerMemberId === memberId).length;
      setMemberStatus(memberId, mine > 0 ? "ready" : "none");
      if (
        shouldAutoOpenCrew({
          count: mine,
          overlayOpen: optsRef.current.overlayOpen(),
          alreadyOffered: offeredRef.current.has(memberId),
          enabled: optsRef.current.autoOpen,
        })
      ) {
        offeredRef.current.add(memberId);
        setSel(new Set());
        setOpen(memberId);
      }
    } catch {
      setMemberStatus(memberId, "error");
    }
  }, []);

  /** This member's un-added co-bookers. */
  const crewFor = (memberId: string): CrewEntry[] =>
    crew.filter((c) => c.ownerMemberId === memberId);
  const statusFor = (memberId: string): CrewStatus => status[memberId] ?? "idle";

  /** Drop the people who just joined the roster — from EVERY member's list,
   *  since one person can be on two members' bookings. */
  const take = useCallback((ids: ReadonlySet<string>) => {
    commitCrew(crewRef.current.filter((c) => !ids.has(c.id)));
  }, []);

  return { load, crewFor, statusFor, take, open, setOpen, sel, setSel };
}
