"use client";

/**
 * NFL Ticket on NeoVerse — pick your game.
 *
 * Replaces the v3 TIME step for an NFL item: the guest picks a GAME, and the
 * lane window follows from it (kickoff − 15 min, 3 hours). Modelled on
 * WorldCupMatchStep, with three deliberate departures:
 *
 *  1. Games come from `/api/bowling/v2/nfl/games` per date, not a table
 *     compiled into the bundle — the NFL plays ~272 games and flexes Sunday
 *     kickoffs mid-season.
 *  2. Kickoffs are NOT on the hour (1:00, 4:05, 4:25, 8:15, 8:20, 8:35), so the
 *     availability probe passes the real minute. Conqueror accepts an off-grid
 *     start exactly — probed live — so nothing is snapped to a :15 grid.
 *  3. Two experience slugs, picked per game by day band, because the Conqueror
 *     offers behind them are day-banded and the vendor enforces it.
 *
 * Sold-out is discovered lazily, on tap. The card list already knows whether a
 * BLOCK is free (that is one cheap query the API did); what it cannot know is
 * whether a LANE is free, and asking QAMF per card would be a ~13-call fan-out
 * on a Sunday. So a card can read available and still fail — at which point it
 * says sold out and never offers a shifted time.
 */

import { useEffect, useState } from "react";
import { qamfCenterIdForCode } from "~/features/booking";
import type { BowlingItem, StepDef } from "~/features/booking";
import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";
import { probeAvailability, parseAvailabilities } from "./availability-client";
import { getPublicReopenMinutes } from "@/lib/group-events";
import { releaseComboBowlingHold } from "~/features/combos/combo-booking";
import { NFL_WINDOW_MINUTES, buildNflLineItems, maxLanesPerBooking } from "~/features/nfl";
import { clarityTag, clarityEvent } from "~/lib/clarity";
import { IconBallFootball, IconCheck } from "@tabler/icons-react";

const VIOLET = "#A78BFA"; // v3 Experience-step VIP accent (owner 2026-07-26)

/** One row of GET /api/bowling/v2/nfl/games?date= */
interface GameCard {
  id: string;
  kickoffIso: string;
  dateEt: string;
  matchup: string;
  network: string | null;
  week: number | null;
  laneOpenIso: string;
  experienceSlug: string;
  soldOut: boolean;
}

const etTime = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

const NflGameStepComponent: StepDef<BowlingItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
  setBusy,
}) => {
  const [games, setGames] = useState<GameCard[]>([]);
  const [exps, setExps] = useState<BowlingExperienceWithDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [reservingId, setReservingId] = useState<string | null>(null);
  const [soldOutIds, setSoldOutIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const centerId = item.qamfCenterId ?? qamfCenterIdForCode(session.center);
  const playerCount = item.playerCount;
  const maxLanes = centerId ? maxLanesPerBooking(centerId) : 0;
  const laneCount = Math.max(1, Math.ceil(playerCount / 6));
  const tooManyLanes = maxLanes > 0 && laneCount > maxLanes;

  useEffect(() => {
    if (!centerId || !item.date) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [gRes, eRes] = await Promise.all([
          fetch(`/api/bowling/v2/nfl/games?centerId=${centerId}&date=${item.date}`),
          fetch(`/api/bowling/v2/experiences?centerCode=${session.center ?? ""}`),
        ]);
        const gData = gRes.ok ? await gRes.json() : { games: [] };
        const eData = eRes.ok ? await eRes.json() : [];
        if (cancelled) return;
        setGames(Array.isArray(gData.games) ? gData.games : []);
        setExps(Array.isArray(eData) ? eData : []);
      } catch {
        if (!cancelled) setError("Couldn't load today's games — please try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [centerId, item.date, session.center]);

  const expFor = (g: GameCard) => exps.find((e) => e.slug === g.experienceSlug);

  const perLaneCents = (g: GameCard): number | null => {
    const exp = expFor(g);
    if (!exp?.items?.length) return null;
    return exp.items.reduce((sum, i) => sum + (i.priceCents ?? 0) * i.quantity, 0);
  };

  async function pickGame(g: GameCard) {
    if (centerId == null) {
      setError("We couldn't tell which location this is for. Go back and re-select your center.");
      return;
    }
    const exp = expFor(g);
    if (!exp) {
      setError("NFL lanes aren't set up for this date yet — please check back soon.");
      return;
    }
    // The 180-min Time option MUST come from the seeded offer row. A missing id
    // means the seed has not run for this center — fail loud rather than fall
    // back to slot.optionId and book a 1-hour lane (Open-Pkg-Duration bug).
    if (exp.qamfOptionId == null) {
      setError("NFL lanes aren't bookable right now — please check back soon.");
      console.error(`[nfl] experience ${exp.slug} has no qamf_option_id seeded`);
      return;
    }

    setBusy?.(true);
    setReservingId(g.id);
    setError(null);
    try {
      const open = new Date(g.laneOpenIso);
      const openParts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .formatToParts(open)
        .reduce<Record<string, string>>((a, p) => ((a[p.type] = p.value), a), {});
      const openHour = Number(openParts.hour) % 24;
      const openMinute = Number(openParts.minute);

      // Buyout mornings: the centre is closed to the public before the reopen
      // time — the same gate the sibling steps apply.
      const reopenMin = getPublicReopenMinutes(g.dateEt);
      if (reopenMin != null && openHour * 60 + openMinute < reopenMin) {
        setSoldOutIds((prev) => new Set(prev).add(g.id));
        return;
      }

      // Targeted probe at the exact lane-open instant, off-grid minute and all.
      // optionCheck=accurate strips the 180-min option when the lane isn't free
      // for the FULL window, so a match below means "fits", not "configured".
      const raw = await probeAvailability(
        `/api/bowling/v2/availability?centerId=${centerId}&players=${playerCount}` +
          `&startDate=${g.dateEt}&kind=hourly&hour=${openHour}&minute=${openMinute}` +
          `&windowMinutes=15&optionCheck=accurate`,
      );
      const openMs = open.getTime();
      const slot = parseAvailabilities(raw).find(
        (s) => s.webOfferId === exp.qamfWebOfferId && Date.parse(s.bookedAt) === openMs,
      );
      const optionOk =
        !slot?.availableTimeOptionIds?.length ||
        slot.availableTimeOptionIds.includes(exp.qamfOptionId);
      if (!slot || !optionOk) {
        setSoldOutIds((prev) => new Set(prev).add(g.id));
        clarityEvent("nfl:soldout");
        return;
      }

      if (item.qamfReservationId && item.nflGameId === g.id) return; // already held
      if (item.qamfReservationId) {
        // Never leave two live holds, and clear the stale id so a failed
        // re-hold cannot advance the wizard on a dead one.
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
        setError(holdData.error ?? "Couldn't reserve this game window. Try another game.");
        return;
      }

      dispatch({
        type: "setBowlingHold",
        itemId: item.id,
        qamfReservationId: holdData.qamfReservationId as string,
        qamfCenterId: centerId,
      });
      onChange({
        date: g.dateEt,
        hour: openHour,
        minute: openMinute,
        bookedAt: slot.bookedAt,
        tier: "vip",
        experienceId: exp.id,
        experienceSlug: exp.slug,
        webOfferId: exp.qamfWebOfferId,
        optionId: exp.qamfOptionId,
        optionType: "Time",
        durationMinutes: NFL_WINDOW_MINUTES,
        durationMultiplier: 1,
        laneCount,
        lineItems: buildNflLineItems(exp.items ?? [], laneCount, {
          awayTeam: g.matchup.split(" at ")[0] ?? g.matchup,
          homeTeam: g.matchup.split(" at ")[1] ?? "",
        }),
        rawItems: [],
        hasBookingFee: true,
        nflGameId: g.id,
      } as Partial<BowlingItem>);
      clarityTag("nfl", g.id);
      clarityEvent("nfl:game-held");
    } catch {
      setError("Couldn't check that game window — please try again.");
    } finally {
      setReservingId(null);
      setBusy?.(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
          style={{ borderTopColor: VIOLET }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <div className="text-center">
        <div className="flex items-center justify-center gap-2">
          <IconBallFootball size={22} style={{ color: VIOLET }} aria-hidden />
          <h2 className="font-display text-2xl uppercase tracking-widest text-white">
            Pick your game
          </h2>
        </div>
        <p className="mt-1.5 text-sm text-white/70">
          Your game on the NeoVerse LED walls. Lanes open 15 minutes before kickoff and are yours
          for 3 hours — shoes, a one-topping pizza, 10 wings and a soda pitcher included.
        </p>
      </div>

      {tooManyLanes && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-center text-sm text-amber-300">
          {playerCount} bowlers needs {laneCount} lanes, and NFL Ticket seats up to {maxLanes} per
          booking. Give us a call and we&apos;ll set the group up.
        </p>
      )}

      {error && (
        <p className="rounded-lg bg-red-500/10 p-3 text-center text-sm text-red-300">{error}</p>
      )}

      {games.length === 0 && !error && (
        <p className="py-8 text-center text-sm text-white/50">
          No football on this date — pick another day.
        </p>
      )}

      <div className="space-y-2">
        {games.map((g) => {
          const isSoldOut = g.soldOut || soldOutIds.has(g.id);
          const isPicked = item.nflGameId === g.id && !!item.qamfReservationId;
          const cents = perLaneCents(g);
          return (
            <button
              key={g.id}
              type="button"
              disabled={isSoldOut || reservingId !== null || tooManyLanes}
              onClick={() => void pickGame(g)}
              aria-pressed={isPicked}
              className="w-full rounded-xl border p-4 text-left transition-all disabled:cursor-not-allowed"
              style={{
                borderColor: isPicked ? VIOLET : "rgba(255,255,255,0.10)",
                backgroundColor: isPicked ? "rgba(167,139,250,0.10)" : "rgba(255,255,255,0.03)",
                opacity: isSoldOut || tooManyLanes ? 0.45 : 1,
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-white">{g.matchup}</p>
                  <p className="mt-0.5 text-xs text-white/50">
                    {etTime(g.kickoffIso)} kickoff · lanes open {etTime(g.laneOpenIso)}
                    {g.network ? ` · ${g.network}` : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {isPicked ? (
                    <IconCheck size={20} style={{ color: VIOLET }} aria-hidden />
                  ) : isSoldOut ? (
                    <span className="text-xs font-semibold text-white/40">Sold out</span>
                  ) : cents != null ? (
                    <span className="text-sm font-bold text-white">
                      ${(cents / 100).toFixed(2)}
                      <span className="ml-1 text-[10px] font-normal text-white/40">/lane</span>
                    </span>
                  ) : null}
                </div>
              </div>
              {reservingId === g.id && (
                <p className="mt-2 text-xs" style={{ color: VIOLET }}>
                  Holding your lane…
                </p>
              )}
            </button>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-white/40">
        Up to 6 bowlers a lane. Game going long? Tell the front desk — we&apos;ll do our best to
        keep the party going.
      </p>
    </div>
  );
};

const NflGameStep: StepDef<BowlingItem> = {
  id: "nfl-game",
  title: "Pick Your Game",
  Component: NflGameStepComponent,
  isVisible: (item) => item.kind === "bowling" && !!item.experienceSlug?.startsWith("nfl-vip-"),
  canAdvance: (item) =>
    item.webOfferId && item.bookedAt && item.qamfReservationId && item.nflGameId
      ? true
      : { reason: "Pick your game to hold a VIP lane" },
};

export default NflGameStep;
