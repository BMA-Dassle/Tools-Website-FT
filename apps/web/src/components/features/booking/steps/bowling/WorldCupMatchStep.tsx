"use client";

import { useEffect, useState } from "react";
import { qamfCenterIdForCode } from "~/features/booking";
import type { BowlingItem, StepDef } from "~/features/booking";
import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";
import { probeAvailability, parseAvailabilities } from "./availability-client";
import { getPublicReopenMinutes } from "@/lib/group-events";
import { releaseComboBowlingHold } from "~/features/combos/combo-booking";
import {
  WORLD_CUP_FIXTURES,
  WORLD_CUP_WINDOW_MINUTES,
  buildWorldCupLineItems,
  fixtureLabel,
  fixtureDayLabel,
  fixtureTimeLabel,
  fixtureMatchesBookedAt,
  isWorldCupSlug,
  upcomingFrom,
  worldCupCenterEnabledByQamfId,
  worldCupSlugForDate,
  type WorldCupFixture,
} from "~/features/world-cup";
import { clarityTag, clarityEvent } from "~/lib/clarity";
import { IconBallFootball, IconCheck, IconClockHour4 } from "@tabler/icons-react";

const GOLD = "#FFD700";

// Same QAMF-id → Square center-code map the sibling steps use.
const QAMF_CENTER_CODES: Record<number, string> = {
  9172: "TXBSQN0FEKQ11",
  3148: "PPTR5G2N0QXF7",
};

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * World Cup VIP Bowling — match picker (?experience=world-cup entry mode).
 *
 * Replaces the Slots/Tier/Offer steps for `item.isWorldCup` bowling items:
 * the customer picks a MATCH, not a date+hour, and the lane window is pinned
 * to the fixture kickoff (150-min Time option carried on the experience's
 * seeded offer row — NEVER slot.optionId, per the Open-Pkg-Duration lesson).
 *
 * Booking mechanics mirror the proven combo path (comboBowlingPatch +
 * holdComboBowling): targeted availability probe at the exact kickoff, then
 * the QAMF hold, then the same item patch BowlingOfferStep.selectSlot writes.
 * Deliberately NOT built on BowlingOfferStep — its earliest-in-hour booking,
 * hour widening, and VIP-upsell behaviors are all wrong for kickoff-pinned
 * slots. If the exact kickoff can't hold, the card reads sold out; we never
 * offer a shifted start.
 */
const WorldCupMatchStepComponent: StepDef<BowlingItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
  setBusy,
}) => {
  // Resolve from the item's stamped center, else the SELECTED session center —
  // never a hardcoded fallback (BowlingOfferStep precedent).
  const centerId = item.qamfCenterId ?? qamfCenterIdForCode(session.center);
  const centerCode = centerId != null ? (QAMF_CENTER_CODES[centerId] ?? null) : null;
  const centerEnabled = worldCupCenterEnabledByQamfId(centerId);

  const playerCount = item.playerCount;
  const laneCount = Math.max(1, Math.ceil(playerCount / 6));

  const [experiences, setExperiences] = useState<BowlingExperienceWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Fixture id currently being probed/held — drives the inline spinner. */
  const [reservingId, setReservingId] = useState<string | null>(null);
  /** Fixtures whose exact kickoff probed empty at this center. */
  const [soldOutIds, setSoldOutIds] = useState<Set<string>>(new Set());
  /** Fixture table, TBD matchups live-filled server-side (ESPN feed). The
   *  committed table renders instantly; the fetch only upgrades labels —
   *  ids/dates/kickoffs are identical, so selections stay stable. */
  const [fixtures, setFixtures] = useState<WorldCupFixture[]>(WORLD_CUP_FIXTURES);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/world-cup/fixtures");
        if (!res.ok) return;
        const data = (await res.json()) as { fixtures?: WorldCupFixture[] };
        if (Array.isArray(data.fixtures) && data.fixtures.length) {
          setFixtures(data.fixtures);
        }
      } catch {
        // Feed down — the committed table ("Teams TBD") is the fallback.
      }
    })();
  }, []);

  useEffect(() => {
    if (!centerCode || !centerEnabled) {
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`/api/bowling/v2/experiences?centerCode=${centerCode}`);
        const data = await res.json();
        const all: BowlingExperienceWithDetails[] = Array.isArray(data) ? data : [];
        // Only the two seeded world-cup rows — everything else belongs to the
        // normal wizard (which, conversely, filters these OUT).
        setExperiences(all.filter((e) => isWorldCupSlug(e.slug)));
      } catch {
        setExperiences([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [centerCode, centerEnabled]);

  const expForFixture = (f: WorldCupFixture): BowlingExperienceWithDetails | undefined =>
    experiences.find((e) => e.slug === worldCupSlugForDate(f.dateEt));

  const perLaneCents = (f: WorldCupFixture): number | null => {
    const exp = expForFixture(f);
    const primary = exp?.items?.find((i) => i.sortOrder === 0);
    if (!exp) return null;
    // Per-lane window total = every bundled rate line (chips is $0).
    const total = (exp.items ?? []).reduce((s, i) => s + (i.priceCents ?? 0) * i.quantity, 0);
    return primary ? total : null;
  };

  async function pickMatch(f: WorldCupFixture) {
    if (centerId == null) {
      setError("We couldn't tell which location this is for. Go back and re-select your center.");
      return;
    }
    const exp = expForFixture(f);
    if (!exp) {
      setError("World Cup lanes aren't set up for this date yet — please check back soon.");
      return;
    }
    // The 150-min Time option MUST come from the seeded offer row. A missing
    // id means the seed hasn't run for this center — fail loud rather than
    // fall back to slot.optionId and book a 1-hour lane (Open-Pkg-Duration bug).
    if (exp.qamfOptionId == null) {
      setError("World Cup lanes aren't bookable right now — please check back soon.");
      console.error(`[world-cup] experience ${exp.slug} has no qamf_option_id seeded`);
      return;
    }

    setBusy?.(true);
    setReservingId(f.id);
    setError(null);
    try {
      // Buyout mornings: the whole center is closed to the public before the
      // reopen time — same gate the sibling steps apply.
      const reopenMin = getPublicReopenMinutes(f.dateEt);
      if (reopenMin != null && f.kickoffHourEt * 60 < reopenMin) {
        setSoldOutIds((prev) => new Set(prev).add(f.id));
        return;
      }

      // Targeted probe at the exact kickoff (QAMF availability is point-in-time).
      const raw = await probeAvailability(
        `/api/bowling/v2/availability?centerId=${centerId}&players=${playerCount}` +
          `&startDate=${f.dateEt}&kind=hourly&hour=${f.kickoffHourEt}&minute=0&windowMinutes=15`,
      );
      const slots = parseAvailabilities(raw);
      const slot = slots.find(
        (s) => s.webOfferId === exp.qamfWebOfferId && fixtureMatchesBookedAt(f, s.bookedAt),
      );
      // When QAMF lists which Time options are bookable at this start, our
      // 150-min option must be among them.
      const optionOk =
        !slot?.availableTimeOptionIds?.length ||
        slot.availableTimeOptionIds.includes(exp.qamfOptionId);
      if (!slot || !optionOk) {
        setSoldOutIds((prev) => new Set(prev).add(f.id));
        clarityEvent("worldcup:soldout");
        return;
      }

      // Re-pick: release the previous hold first (best-effort — QAMF holds
      // TTL out server-side anyway). Never leave two live holds; clear the
      // stale id on the item so a failed re-hold can't advance on a dead hold.
      if (item.qamfReservationId && item.worldCupMatchId === f.id) {
        return; // same match already held — nothing to do
      }
      if (item.qamfReservationId) {
        await releaseComboBowlingHold(item);
        onChange({ qamfReservationId: null } as Partial<BowlingItem>);
      }

      const holdRes = await fetch("/api/bowling/v2/reserve/hold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          centerId,
          webOfferId: exp.qamfWebOfferId,
          optionId: exp.qamfOptionId,
          optionType: "Time",
          bookedAt: slot.bookedAt,
          players: playerCount,
          service: "BookForLater",
        }),
      });
      const holdData = await holdRes.json();
      if (!holdRes.ok || !holdData.qamfReservationId) {
        setError(holdData.error ?? "Couldn't reserve this match window. Try another match.");
        return;
      }

      const lineItems = buildWorldCupLineItems(exp.items ?? [], laneCount, f);

      dispatch({
        type: "setBowlingHold",
        itemId: item.id,
        qamfReservationId: holdData.qamfReservationId as string,
        qamfCenterId: centerId,
      });
      onChange({
        date: f.dateEt,
        hour: f.kickoffHourEt,
        minute: 0,
        bookedAt: slot.bookedAt,
        tier: "vip",
        experienceId: exp.id,
        experienceSlug: exp.slug,
        webOfferId: exp.qamfWebOfferId,
        optionId: exp.qamfOptionId,
        optionType: "Time",
        durationMinutes: WORLD_CUP_WINDOW_MINUTES,
        durationMultiplier: 1,
        laneCount,
        lineItems,
        rawItems: [],
        hasBookingFee: true,
        worldCupMatchId: f.id,
      } as Partial<BowlingItem>);
      clarityTag("worldcup", f.id);
      clarityEvent("worldcup:match-held");
    } catch {
      setError("Couldn't check that match window — please try again.");
    } finally {
      setReservingId(null);
      setBusy?.(false);
    }
  }

  if (!centerEnabled) {
    return (
      <div className="rounded-2xl bg-white/5 p-6 text-center ring-1 ring-white/10">
        <IconBallFootball size={32} className="mx-auto mb-3 text-white/40" />
        <p className="font-semibold text-white">
          World Cup VIP Bowling isn&apos;t available at this location right now.
        </p>
        <p className="mt-2 text-sm text-white/60">
          Please check back soon, or book a regular lane from the bowling page.
        </p>
      </div>
    );
  }

  const upcoming = upcomingFrom(fixtures, Date.now());
  const dates = [...new Set(upcoming.map((f) => f.dateEt))];

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
        <div className="flex items-center gap-2">
          <IconBallFootball size={22} style={{ color: GOLD }} />
          <h3 className="font-display text-lg font-bold uppercase italic text-white">
            Pick your match
          </h3>
        </div>
        <p className="mt-1.5 text-sm text-white/70">
          A VIP lane for {Math.floor(WORLD_CUP_WINDOW_MINUTES / 60)}½ hours from kickoff — the match
          on our NeoVerse LED video walls, chips &amp; salsa included. Shoe rental is extra (added
          on the next step).
        </p>
        <p className="mt-1 text-xs text-white/50">
          {playerCount} {playerCount === 1 ? "bowler" : "bowlers"} · {laneCount}{" "}
          {laneCount === 1 ? "lane" : "lanes"} (up to 6 per lane)
        </p>
      </div>

      {error && (
        <div className="rounded-xl bg-red-500/15 px-4 py-3 text-sm text-red-200 ring-1 ring-red-400/30">
          {error}
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-white/60">Loading matches…</p>
      ) : upcoming.length === 0 ? (
        <p className="py-8 text-center text-sm text-white/60">
          The tournament is over — thanks for watching with us!
        </p>
      ) : (
        dates.map((dateEt) => (
          <div key={dateEt}>
            <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-white/50">
              {fixtureDayLabel(upcoming.find((f) => f.dateEt === dateEt)!)}
            </h4>
            <div className="space-y-2">
              {upcoming
                .filter((f) => f.dateEt === dateEt)
                .map((f) => {
                  const selected = item.worldCupMatchId === f.id && !!item.qamfReservationId;
                  const soldOut = soldOutIds.has(f.id);
                  const reserving = reservingId === f.id;
                  const priceCents = perLaneCents(f);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      disabled={soldOut || reserving}
                      onClick={() => void pickMatch(f)}
                      aria-label={`${fixtureLabel(f)}, ${f.round}, kickoff ${fixtureTimeLabel(f)} ${fixtureDayLabel(f)}${soldOut ? " — sold out at this center" : ""}`}
                      className={`w-full rounded-2xl p-4 text-left ring-1 transition-colors ${
                        selected
                          ? "bg-white/10 ring-2 ring-[#FFD700]"
                          : soldOut
                            ? "cursor-not-allowed bg-white/[0.03] opacity-50 ring-white/10"
                            : "bg-white/5 ring-white/10 hover:bg-white/10"
                      }`}
                      style={selected ? { boxShadow: `0 0 14px ${GOLD}40` } : undefined}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <span
                            className="text-[10px] font-bold uppercase tracking-wider"
                            style={{ color: GOLD }}
                          >
                            {f.round}
                          </span>
                          <p className="truncate font-semibold text-white">{fixtureLabel(f)}</p>
                          <p className="mt-0.5 flex items-center gap-1 text-xs text-white/60">
                            <IconClockHour4 size={13} />
                            Kickoff {fixtureTimeLabel(f)}
                            {f.venue ? ` · ${f.venue}` : ""}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          {selected ? (
                            <span
                              className="inline-flex items-center gap-1 text-sm font-bold"
                              style={{ color: GOLD }}
                            >
                              <IconCheck size={16} /> Selected
                            </span>
                          ) : soldOut ? (
                            <span className="text-xs font-semibold text-white/50">
                              Sold out at this center
                            </span>
                          ) : reserving ? (
                            <span className="text-xs text-white/60">Holding lane…</span>
                          ) : priceCents != null ? (
                            <span className="text-sm font-bold text-white">
                              {centsToDollars(priceCents)}
                              <span className="text-xs font-normal text-white/40">/lane</span>
                            </span>
                          ) : null}
                          {!selected && !soldOut && priceCents != null && laneCount > 1 && (
                            <p className="text-[11px] text-white/40">
                              {laneCount} lanes · {centsToDollars(priceCents * laneCount)} + tax
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
            </div>
          </div>
        ))
      )}
      <p className="text-[11px] leading-relaxed text-white/40">
        Windows run {Math.floor(WORLD_CUP_WINDOW_MINUTES / 60)} hours 30 minutes from kickoff at
        normal VIP lane rates. Match going to extra time? Tell the front desk at our bowling center
        — we&apos;ll do our best to keep the party going.
      </p>
    </div>
  );
};

const WorldCupMatchStep: StepDef<BowlingItem> = {
  id: "world-cup-match",
  title: "Pick Your Match",
  Component: WorldCupMatchStepComponent,
  isVisible: (item) => item.kind === "bowling" && !!item.isWorldCup,
  canAdvance: (item) =>
    item.webOfferId && item.bookedAt && item.qamfReservationId
      ? true
      : { reason: "Pick your match to hold a VIP lane" },
};

export default WorldCupMatchStep;
