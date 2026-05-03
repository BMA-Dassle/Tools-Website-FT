"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import type { GroupTicket, GroupTicketMember } from "@/lib/race-tickets";
import {
  CheckingInCard,
  InvalidCard,
  PastCard,
  PreRaceCard,
  TICKET_PULSE_CSS,
  minutesUntil,
} from "../../t/[id]/cards";
import ImportantRaceInfo from "../../t/[id]/ImportantRaceInfo";
import FullScreenTicket from "../../t/[id]/FullScreenTicket";
import PovVoucherBlock from "@/components/booking/PovVoucherBlock";

// Lazy-load TrackStatus so the ticket cards + race-info banner
// paint immediately. Same rationale as /t/[id]/ETicketView.
const TrackStatus = dynamic(() => import("@/components/home/TrackStatus"), {
  ssr: false,
  loading: () => null,
});

export interface MemberInitialState {
  checkingIn: boolean;
  onSession: boolean;
  wasCalled: boolean;
}

interface Props {
  group: GroupTicket;
  initial: Record<string, MemberInitialState>;
}

interface MemberState {
  checkingIn: boolean;
  onSession: boolean;
  wasCalled: boolean;
}

function memberKey(m: Pick<GroupTicketMember, "sessionId" | "personId">): string {
  return `${m.sessionId}:${m.personId}`;
}

function earliestStart(members: GroupTicketMember[]): number {
  return Math.min(...members.map((m) => new Date(m.scheduledStart).getTime()));
}

export default function GroupETicketView({ group, initial }: Props) {
  const [state, setState] = useState<Record<string, MemberState>>(() => {
    const s: Record<string, MemberState> = {};
    for (const m of group.members) {
      const seed = initial[memberKey(m)];
      s[memberKey(m)] = seed
        ? { ...seed, wasCalled: seed.wasCalled || seed.checkingIn }
        : { checkingIn: false, onSession: true, wasCalled: false };
    }
    return s;
  });
  // True after the FIRST live poll completes. Same rationale as
  // /t/[id] — without it, members with `wasCalled=true` (Redis SSR)
  // wrongly resolve to PastCard before `checkingIn` arrives.
  const [statusLoaded, setStatusLoaded] = useState(false);
  /** Currently-fullscreened member key (or null when no overlay).
   *  Lets staff scan one racer's heat info at a time even on
   *  group tickets. Same UX pattern as /t/[id]. */
  const [fullScreenKey, setFullScreenKey] = useState<string | null>(null);
  /** ViewPoint POV codes claimed per personId. Each member is
   *  fetched independently — one block per member who had credit
   *  on file. Members without credit get an empty entry which
   *  hides their block (PovVoucherBlock returns null for empty). */
  const [povByPerson, setPovByPerson] = useState<Record<string, { codes: string[]; cached: boolean }>>({});
  const povClaimAttempted = useRef(false);

  // Sort: active heats first (soonest start), past heats last.
  const sortedMembers = [...group.members].sort((a, b) => {
    const ta = new Date(a.scheduledStart).getTime();
    const tb = new Date(b.scheduledStart).getTime();
    return ta - tb;
  });

  // Stop polling once every heat is 90+ min past AND was never called — no
  // state transitions to watch for.
  const allPast = group.members.every((m) => minutesUntil(m.scheduledStart) < -90);

  // Polling is paused while the tab is hidden — see
  // lib/use-visible-interval.ts. Long-lived background tabs were
  // racking up fetches until Edge killed the renderer.
  const distinctSessions = Array.from(new Set(group.members.map((m) => String(m.sessionId))));
  async function poll(signal: AbortSignal) {
    try {
      const stateFetches = distinctSessions.map((sid) =>
        fetch(`/api/race-session-state?sessionId=${encodeURIComponent(sid)}`, { cache: "no-store", signal }),
      );
      const [currentRes, ...rest] = await Promise.all([
        fetch("/api/pandora/races-current", { cache: "no-store", signal }),
        ...distinctSessions.map((sid) =>
          fetch(
            `/api/pandora/session-participants?locationId=${encodeURIComponent(group.locationId)}&sessionId=${encodeURIComponent(sid)}`,
            { cache: "no-store", signal },
          ),
        ),
        ...stateFetches,
      ]);
      if (signal.aborted) return;
      const partResponses = rest.slice(0, distinctSessions.length);
      const stateResponses = rest.slice(distinctSessions.length);

      let current: { blue?: { sessionId?: number | string } | null; red?: { sessionId?: number | string } | null; mega?: { sessionId?: number | string } | null } = {};
      if (currentRes.ok) current = await currentRes.json();

      const rosterBySession = new Map<string, Set<string>>();
      for (let i = 0; i < distinctSessions.length; i++) {
        const sid = distinctSessions[i];
        const res = partResponses[i];
        if (!res.ok) continue;
        const data = await res.json();
        const list = Array.isArray(data?.data) ? data.data : [];
        if (list.length === 0) continue; // trust prior state on empty
        rosterBySession.set(sid, new Set(list.map((p: { personId: string | number }) => String(p.personId))));
      }

      const calledBySession = new Map<string, boolean>();
      for (let i = 0; i < distinctSessions.length; i++) {
        const sid = distinctSessions[i];
        const res = stateResponses[i];
        if (!res.ok) continue;
        try {
          const d = await res.json();
          if (d?.wasCalled) calledBySession.set(sid, true);
        } catch { /* skip */ }
      }

      setState((prev) => {
        const next: Record<string, MemberState> = { ...prev };
        for (const m of group.members) {
          const key = memberKey(m);
          const trackKey = m.track.toLowerCase() as "blue" | "red" | "mega";
          const checkingIn = String(current?.[trackKey]?.sessionId ?? "") === String(m.sessionId ?? "");
          const roster = rosterBySession.get(String(m.sessionId));
          let onSession = prev[key]?.onSession ?? true;
          if (roster) {
            const scheduled = new Date(m.scheduledStart).getTime();
            if (!isNaN(scheduled) && scheduled < Date.now() - 45 * 60_000) {
              onSession = true;
            } else {
              onSession = roster.has(String(m.personId));
            }
          }
          const wasCalled =
            (prev[key]?.wasCalled ?? false) ||
            checkingIn ||
            (calledBySession.get(String(m.sessionId)) ?? false);
          next[key] = { checkingIn, onSession, wasCalled };
        }
        return next;
      });
      // First poll has settled — `checkingIn` is now trustable, so
      // members with `wasCalled=true && checkingIn=false` can
      // legitimately resolve to PastCard without flashing.
      if (!signal.aborted) setStatusLoaded(true);
    } catch {
      // Even on error, flip statusLoaded so the user doesn't get
      // stuck on a "Loading status…" card forever — next poll will
      // correct any wrong assumptions.
      setStatusLoaded(true);
    }
  }
  useVisibleInterval(poll, 20_000, !allPast);

  // ViewPoint POV claim fan-out — one call per member, fired once
  // on mount (StrictMode-safe via ref). The claim endpoint is
  // idempotent per-personId, so subsequent visits return the same
  // codes for each member without re-popping the pool.
  //
  // Two wrinkles vs. the single-ticket path:
  //   (1) Same person could appear under two different sessionIds
  //       (multi-heat booking). We dedupe by personId so we don't
  //       fire two claim calls for the same person — the server's
  //       per-personId idempotency would handle it but it's wasteful.
  //   (2) Concurrent members fire in parallel (Promise.all) — the
  //       server-side SET-NX race-guard handles cross-tab races
  //       within a single member.
  useEffect(() => {
    if (povClaimAttempted.current) return;
    povClaimAttempted.current = true;
    const ac = new AbortController();
    (async () => {
      const seen = new Set<string>();
      const targets: { personId: string; sessionId: string; locationId: string }[] = [];
      for (const m of group.members) {
        const pid = String(m.personId ?? "").trim();
        const sid = String(m.sessionId ?? "").trim();
        if (!pid || !sid || !/^\d+$/.test(pid) || !/^\d+$/.test(sid)) continue;
        if (seen.has(pid)) continue;
        seen.add(pid);
        targets.push({ personId: pid, sessionId: sid, locationId: group.locationId });
      }
      const results = await Promise.all(
        targets.map(async (t) => {
          try {
            const res = await fetch(
              `/api/pov-codes?action=claim-from-credit&personId=${encodeURIComponent(t.personId)}&locationId=${encodeURIComponent(t.locationId)}&sessionId=${encodeURIComponent(t.sessionId)}`,
              { cache: "no-store", signal: ac.signal },
            );
            if (!res.ok) return null;
            const json = (await res.json()) as { codes?: string[]; cached?: boolean };
            const codes = Array.isArray(json.codes) ? json.codes : [];
            return { personId: t.personId, codes, cached: !!json.cached };
          } catch {
            return null;
          }
        }),
      );
      if (ac.signal.aborted) return;
      setPovByPerson((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (r && r.codes.length > 0) {
            next[r.personId] = { codes: r.codes, cached: r.cached };
          }
        }
        return next;
      });
    })();
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id, group.locationId]);

  const racerCount = group.members.length;
  const distinctHeats = new Set(group.members.map((m) => String(m.sessionId))).size;
  const earliest = earliestStart(group.members);
  const earliestDate = new Date(earliest);
  const dateLabel = isNaN(earliestDate.getTime())
    ? ""
    : earliestDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" });

  return (
    <div className="min-h-screen bg-[#010A20] flex items-start justify-center px-4 pt-28 sm:pt-32 pb-8">
      <style>{TICKET_PULSE_CSS}</style>

      <div className="w-full max-w-lg">
        <div className="text-center mb-6">
          <p className="text-white/30 text-xs uppercase tracking-[0.3em] mb-1">FastTrax Entertainment</p>
          <p className="text-white/60 text-sm font-semibold">
            {group.recipient === "guardian" ? "Your Racers' E-Tickets" : "E-Tickets"}
          </p>
          <p className="text-white/40 text-xs mt-0.5">
            {racerCount} Racer{racerCount === 1 ? "" : "s"} · {distinctHeats} Heat{distinctHeats === 1 ? "" : "s"}
          </p>
          {dateLabel && <p className="text-white/30 text-xs mt-1">{dateLabel}</p>}
          {group.recipient === "guardian" && (
            <p className="text-amber-300/80 text-[11px] mt-2 inline-block px-2 py-0.5 rounded-full border border-amber-300/30 bg-amber-500/10">
              {group.guardianFirstName
                ? <>Sent to <strong className="text-amber-200">{group.guardianFirstName}</strong> (parent)</>
                : <>Sent to your guardian</>}
            </p>
          )}
        </div>

        {/* Important race info banner — shared with /t/[id]. Was
            previously baked into the SMS body but the carrier kept
            rejecting 11-segment messages with code 4505. Lives on
            the page now so customers always see it. */}
        <ImportantRaceInfo />

        {/* Group members by sessionId so per-heat content +
            full-screen overlays line up with how staff scans the
            check-in counter (one heat at a time). Members in the
            same heat share metadata; we render their cards
            together with ONE "show to staff" button that opens a
            full-screen view listing every racer in that heat. */}
        <div className="space-y-5">
          {(() => {
            const bySession = new Map<string, GroupTicketMember[]>();
            for (const m of sortedMembers) {
              const sid = String(m.sessionId);
              const arr = bySession.get(sid) ?? [];
              arr.push(m);
              bySession.set(sid, arr);
            }
            return Array.from(bySession.entries()).map(([sid, members]) => {
              const first = members[0];
              const mins = minutesUntil(first.scheduledStart);
              const longPast = mins < -90;
              // A heat is "past" only when EVERY member's wasCalled
              // is true and none are currently checking in — and
              // the first poll has settled.
              const allCalled = members.every((m) => state[memberKey(m)]?.wasCalled ?? false);
              const anyCheckingIn = members.some((m) => state[memberKey(m)]?.checkingIn ?? false);
              const dropped = statusLoaded && allCalled && !anyCheckingIn;
              const isPast = longPast || dropped;
              const loadingStatus = !statusLoaded && allCalled && !longPast;
              const anyOnSession = members.some((m) => state[memberKey(m)]?.onSession ?? true);
              return (
                <div key={sid} className="space-y-2">
                  {members.map((m) => {
                    const key = memberKey(m);
                    const s = state[key] ?? { checkingIn: false, onSession: true, wasCalled: false };
                    const memberPov = povByPerson[String(m.personId)];
                    return (
                      <div key={key}>
                        {!s.onSession && !isPast && !loadingStatus ? (
                          <InvalidCard details={m} />
                        ) : isPast ? (
                          <PastCard details={m} />
                        ) : s.checkingIn ? (
                          <CheckingInCard details={m} />
                        ) : (
                          <PreRaceCard details={m} loadingStatus={loadingStatus} />
                        )}
                        {/* Per-member ViewPoint voucher block — sits
                            directly under the member's ticket card so
                            it's clearly THEIR codes (not the
                            household's). Hidden on past heats; the
                            heads-up email/SMS has already fired by
                            then. */}
                        {!isPast && memberPov && memberPov.codes.length > 0 && (
                          <div className="mt-3">
                            <PovVoucherBlock
                              codes={memberPov.codes}
                              cached={memberPov.cached}
                              caption={
                                <>
                                  About 5–10 minutes after{" "}
                                  <strong className="text-white/80">{m.firstName}&apos;s</strong> race, you&apos;ll
                                  get an <strong className="text-white/80">email and text</strong> letting you know
                                  the video is ready. Use the codes below to redeem it.
                                </>
                              }
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {/* Per-heat full-screen button — TABLED for now.
                      Component + state preserved so we can re-enable
                      with a one-line change once the UX is finalized. */}
                  {false && !isPast && anyOnSession && (
                    <button
                      type="button"
                      onClick={() => setFullScreenKey(sid)}
                      className="w-full py-2.5 rounded-xl border border-[#00E2E5]/40 bg-[#00E2E5]/10 text-[#00E2E5] font-bold uppercase tracking-wider text-xs hover:bg-[#00E2E5]/15 active:scale-[0.99] transition-all"
                    >
                      Open Full Screen · Heat {first.heatNumber}
                    </button>
                  )}
                  {/* Full-screen overlay for this heat. */}
                  {fullScreenKey === sid && (
                    <FullScreenTicket
                      racers={members.map((m) => ({ firstName: m.firstName, lastName: m.lastName }))}
                      heat={{
                        scheduledStart: first.scheduledStart,
                        track: first.track,
                        raceType: first.raceType,
                        heatNumber: first.heatNumber,
                      }}
                      onClose={() => setFullScreenKey(null)}
                    />
                  )}
                </div>
              );
            });
          })()}
        </div>

        <div className="mt-8">
          <TrackStatus />
        </div>

        <div className="mt-6 text-center">
          <p className="text-white/30 text-xs">14501 Global Parkway, Fort Myers, FL 33913</p>
          <p className="text-white/20 text-[11px] mt-1">Show this screen at check-in · No paper ticket needed</p>
        </div>
      </div>
    </div>
  );
}
