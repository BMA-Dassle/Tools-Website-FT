"use client";

/**
 * NFL Ticket on NeoVerse — pick your game.
 *
 * This step IS the front of the NFL wizard. It replaces the classic
 * Slots/Tier/Offer steps AND the v3 Date/Experience/Time steps, because on this
 * entry every question those screens ask has exactly one answer: the tier is
 * VIP, the experience is the NFL package, and the game supplies both the date
 * and the time. Modelled on WorldCupMatchStep, with four departures:
 *
 *  1. It owns the DATE. World Cup could lean on a fixture list small enough to
 *     show whole; the NFL plays ~272 games, so a flat list across the booking
 *     horizon would be ~70 cards. A day rail leads, and the games for the
 *     chosen day sit under it.
 *  2. Games come from `/api/bowling/v2/nfl/games`, not a table compiled into
 *     the bundle — the league flexes Sunday kickoffs mid-season.
 *  3. Kickoffs are NOT on the hour (1:00, 4:05, 4:25, 8:15, 8:20, 8:35), so the
 *     availability probe passes the real minute. Conqueror accepts an off-grid
 *     start exactly — probed live — so nothing is snapped to a :15 grid.
 *  4. Two experience slugs, picked per game by day band, because the Conqueror
 *     offers behind them are day-banded and the vendor enforces it.
 *
 * Sold-out is discovered lazily, on tap. The card list already knows whether a
 * BLOCK is free (that is one cheap query the API did); what it cannot know is
 * whether a LANE is free, and asking QAMF per card would be a ~13-call fan-out
 * on a Sunday. So a card can read available and still fail — at which point it
 * says sold out and never offers a shifted time.
 */

import { useEffect, useMemo, useState } from "react";
import { qamfCenterIdForCode } from "~/features/booking";
import type { BowlingItem, StepDef } from "~/features/booking";
import type { BowlingExperienceWithDetails } from "@/lib/bowling-db";
import { probeAvailability, parseAvailabilities } from "./availability-client";
import { QAMF_TO_CENTER_CODE } from "~/features/booking/service/bowling-hours";
import { getPublicReopenMinutes } from "@/lib/group-events";
import { releaseComboBowlingHold } from "~/features/combos/combo-booking";
import { NFL_WINDOW_MINUTES, buildNflLineItems, maxLanesPerBooking } from "~/features/nfl";
import { clarityTag, clarityEvent } from "~/lib/clarity";
// Shared web/kiosk step. useLocale falls back to the default locale when
// there is no provider, so this renders English on the web and the guest's
// language on the kiosk without either side needing to know about the other.
import { useT } from "~/features/kiosk/i18n/useT";
import { IconBallFootball, IconCheck } from "@tabler/icons-react";

const VIOLET = "#A78BFA"; // v3 Experience-step VIP accent (owner 2026-07-26)

/**
 * How far ahead the day rail looks.
 *
 * 30, because that is QAMF's booking horizon — offering a 31st day would show
 * games the vendor will refuse to hold. Roughly four NFL weeks.
 */
const HORIZON_DAYS = 30;

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

/** Today in ET as YYYY-MM-DD. en-CA formats as ISO, which is why it's used. */
const etToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

/** `n` days after an ET date string, as YYYY-MM-DD. */
function addDays(dateEt: string, n: number): string {
  // Noon UTC anchor: a date-only string plus a day count never crosses a DST
  // boundary badly from the middle of the day.
  const d = new Date(`${dateEt}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const NflGameStepComponent: StepDef<BowlingItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
  setBusy,
}) => {
  const [dates, setDates] = useState<string[]>([]);
  const [activeDate, setActiveDate] = useState<string | null>(item.date || null);
  const [games, setGames] = useState<GameCard[]>([]);
  const [exps, setExps] = useState<BowlingExperienceWithDetails[]>([]);
  // Both "loading" states are DERIVED, not set in an effect body: a one-way
  // `datesLoaded` latch, and "the games on screen belong to `gamesFor`". Setting
  // a loading boolean at the top of an effect is a cascading render, and the
  // second flavour also drifts — an in-flight fetch for a day the guest has
  // already tabbed away from would clear the spinner for the wrong day.
  const [datesLoaded, setDatesLoaded] = useState(false);
  const [gamesFor, setGamesFor] = useState<string | null>(null);
  const [reservingId, setReservingId] = useState<string | null>(null);
  const [soldOutIds, setSoldOutIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const centerId = item.qamfCenterId ?? qamfCenterIdForCode(session.center);
  // The experiences endpoint keys on the SQUARE center code, not the wizard's
  // CenterCode. Passing session.center ("fort-myers") returns [] — which read
  // on screen as "NFL lanes aren't set up for this date yet" (owner screenshot,
  // 2026-09-01). Resolve it the way BowlingExperienceStep does.
  const squareCenterCode = centerId != null ? (QAMF_TO_CENTER_CODE[centerId] ?? null) : null;
  const canLoad = centerId != null && squareCenterCode != null;

  const playerCount = item.playerCount;
  const maxLanes = centerId ? maxLanesPerBooking(centerId) : 0;
  const laneCount = Math.max(1, Math.ceil(playerCount / 6));
  const tooManyLanes = maxLanes > 0 && laneCount > maxLanes;

  // ── Which days have football, and the package's pricing rows ──────────────
  useEffect(() => {
    if (!canLoad) return;
    let cancelled = false;
    const from = etToday();
    void (async () => {
      try {
        const [dRes, eRes] = await Promise.all([
          fetch(
            `/api/bowling/v2/nfl/games?centerId=${centerId}` +
              `&from=${from}&to=${addDays(from, HORIZON_DAYS)}`,
          ),
          fetch(`/api/bowling/v2/experiences?centerCode=${squareCenterCode}`),
        ]);
        const dData = dRes.ok ? await dRes.json() : { dates: [] };
        const eData = eRes.ok ? await eRes.json() : [];
        if (cancelled) return;
        const list: string[] = Array.isArray(dData.dates) ? dData.dates : [];
        setDates(list);
        setExps(Array.isArray(eData) ? eData : []);
        // Keep the guest's day if it still has football (they may have come
        // back a step); otherwise lead with the soonest one.
        setActiveDate((cur) => (cur && list.includes(cur) ? cur : (list[0] ?? null)));
      } catch {
        if (!cancelled) setError(t("nfl.err.loadFailed"));
      } finally {
        if (!cancelled) setDatesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `t` is stable per locale; re-running on it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerId, squareCenterCode, canLoad]);

  // ── The chosen day's games ────────────────────────────────────────────────
  useEffect(() => {
    if (!centerId || !activeDate) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/bowling/v2/nfl/games?centerId=${centerId}&date=${activeDate}`,
        );
        const data = res.ok ? await res.json() : { games: [] };
        if (!cancelled) setGames(Array.isArray(data.games) ? data.games : []);
      } catch {
        if (cancelled) return;
        setGames([]);
        setError(t("nfl.err.loadFailed"));
      } finally {
        if (!cancelled) setGamesFor(activeDate);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerId, activeDate]);

  const loadingGames = !!activeDate && gamesFor !== activeDate;

  const expFor = (g: GameCard) => exps.find((e) => e.slug === g.experienceSlug);

  /**
   * Is the package sellable at this center at all?
   *
   * The nfl-vip-* experience rows carry the price, the Conqueror offer and the
   * four Square items. `is_active = FALSE` on them is the package's kill switch
   * — no deploy, one UPDATE — so when they are absent NOTHING here can be
   * bought. Fail closed and say so ONCE, up front: a rail of games that each
   * error on tap is a worse answer than "not bookable", and it invites a guest
   * to keep trying different days for a reason that has nothing to do with the
   * day.
   */
  const sellable = exps.some((e) => e.slug.startsWith("nfl-vip-"));

  const perLaneCents = (g: GameCard): number | null => {
    const exp = expFor(g);
    if (!exp?.items?.length) return null;
    return exp.items.reduce((sum, i) => sum + (i.priceCents ?? 0) * i.quantity, 0);
  };

  /**
   * The day's games, bucketed by the instant their lanes open.
   *
   * Every game in a bucket shares a kickoff, a lane-open time AND a price —
   * the price because both experience rows cost the same and a single day
   * never spans the Fri-Sun / Mon-Thu band split. So all three belong to the
   * heading, and the rows below it carry only what actually differs.
   */
  const windows = useMemo(() => {
    const by = new Map<string, { laneOpenIso: string; kickoffIso: string; games: GameCard[] }>();
    for (const g of games) {
      const w = by.get(g.laneOpenIso);
      if (w) w.games.push(g);
      else
        by.set(g.laneOpenIso, { laneOpenIso: g.laneOpenIso, kickoffIso: g.kickoffIso, games: [g] });
    }
    return [...by.values()].sort((a, b) => a.laneOpenIso.localeCompare(b.laneOpenIso));
  }, [games]);

  /** The day's per-lane price, shown ONCE — see `windows`. */
  const dayPriceCents = useMemo(() => {
    for (const g of games) {
      const c = perLaneCents(g);
      if (c != null) return c;
    }
    return null;
    // perLaneCents reads `exps`, which is the dependency that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games, exps]);

  /** "Today" / "Tomorrow" / "Sun Sep 13" for a rail chip. */
  const dateChipLabel = useMemo(() => {
    const today = etToday();
    const tomorrow = addDays(today, 1);
    return (d: string) => {
      if (d === today) return t("nfl.dateToday");
      if (d === tomorrow) return t("nfl.dateTomorrow");
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(new Date(`${d}T12:00:00Z`));
    };
  }, [t]);

  async function pickGame(g: GameCard) {
    if (centerId == null) {
      setError(t("nfl.err.noCenter"));
      return;
    }
    const exp = expFor(g);
    if (!exp) {
      setError(t("nfl.err.notSetUp"));
      return;
    }
    // The 180-min Time option MUST come from the seeded offer row. A missing id
    // means the seed has not run for this center — fail loud rather than fall
    // back to slot.optionId and book a 1-hour lane (Open-Pkg-Duration bug).
    if (exp.qamfOptionId == null) {
      setError(t("nfl.err.notBookable"));
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
        setError(holdData.error ?? t("nfl.err.holdFailed"));
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
      setError(t("nfl.err.probeFailed"));
    } finally {
      setReservingId(null);
      setBusy?.(false);
    }
  }

  // No resolvable center means no schedule and no pricing — say so plainly
  // rather than spinning forever or showing an empty rail that reads as
  // "no football".
  if (!canLoad) {
    return (
      <p className="mx-auto max-w-lg rounded-lg bg-red-500/10 p-3 text-center text-sm text-red-300">
        {t("nfl.err.noCenter")}
      </p>
    );
  }

  if (!datesLoaded) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
          style={{ borderTopColor: VIOLET }}
        />
      </div>
    );
  }

  if (!sellable) {
    return (
      <p className="mx-auto max-w-lg rounded-lg bg-white/5 p-4 text-center text-sm text-white/60">
        {t("nfl.err.notBookable")}
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <div className="text-center">
        <div className="flex items-center justify-center gap-2">
          <IconBallFootball size={22} style={{ color: VIOLET }} aria-hidden />
          <h2 className="font-display text-2xl uppercase tracking-widest text-white">
            {t("nfl.title")}
          </h2>
        </div>
        <p className="mt-1.5 text-sm text-white/70">{t("nfl.subtitle")}</p>
        {dayPriceCents != null && (
          <p className="mt-2 text-sm font-bold" style={{ color: VIOLET }}>
            {t("nfl.priceLine", { price: `$${(dayPriceCents / 100).toFixed(2)}` })}
          </p>
        )}
      </div>

      {tooManyLanes && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-center text-sm text-amber-300">
          {t("nfl.tooManyLanes", { players: playerCount, lanes: laneCount, max: maxLanes })}
        </p>
      )}

      {error && (
        <p className="rounded-lg bg-red-500/10 p-3 text-center text-sm text-red-300">{error}</p>
      )}

      {/* ── day rail ── */}
      {dates.length === 0 && !error ? (
        <p className="py-8 text-center text-sm text-white/50">{t("nfl.noSchedule")}</p>
      ) : (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/40">
            {t("nfl.pickDate")}
          </p>
          {/* Horizontal scroll: a busy month is ~14 chips, which will not fit a
              kiosk column, and wrapping them buries the games below the fold.
              scrollbar-hide because the site's ::-webkit-scrollbar is bowling
              cyan — under a row of chips it reads as a stray progress bar
              rather than a scrollbar (the utility exists for exactly this). */}
          <div
            className="scrollbar-hide -mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
            role="tablist"
            aria-label={t("nfl.pickDate")}
          >
            {dates.map((d) => {
              const on = d === activeDate;
              return (
                <button
                  key={d}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  disabled={reservingId !== null}
                  onClick={() => {
                    setActiveDate(d);
                    setError(null); // a failure on Sunday says nothing about Monday
                  }}
                  className="shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold transition-all disabled:cursor-not-allowed"
                  style={{
                    borderColor: on ? VIOLET : "rgba(255,255,255,0.10)",
                    backgroundColor: on ? "rgba(167,139,250,0.14)" : "rgba(255,255,255,0.03)",
                    color: on ? VIOLET : "rgba(255,255,255,0.70)",
                  }}
                >
                  {dateChipLabel(d)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── games on the chosen day ── */}
      {loadingGames ? (
        <div className="flex items-center justify-center py-10">
          <div
            className="h-6 w-6 animate-spin rounded-full border-2 border-white/15"
            style={{ borderTopColor: VIOLET }}
          />
        </div>
      ) : (
        <>
          {activeDate && games.length === 0 && !error && (
            <p className="py-8 text-center text-sm text-white/50">{t("nfl.empty")}</p>
          )}

          {/* Grouped by KICKOFF WINDOW.
              On a normal Sunday eight games start at 1:00, so a flat list
              repeats "1:00 PM kickoff · lanes open 12:45 PM" eight times and
              the price thirteen times — a wall of identical text the guest has
              to read past to find the only thing that differs, the matchup.
              The window says the time once, and the rows carry the matchups. */}
          <div className="space-y-4">
            {windows.map((w) => (
              <div key={w.laneOpenIso}>
                <div className="mb-1.5 flex items-baseline gap-2 border-b border-white/10 pb-1.5">
                  <span className="text-sm font-bold text-white">{etTime(w.kickoffIso)}</span>
                  <span className="text-[11px] text-white/45">
                    {t("nfl.window.opens", { open: etTime(w.laneOpenIso) })}
                  </span>
                </div>
                <div className="space-y-1">
                  {w.games.map((g) => {
                    const isSoldOut = g.soldOut || soldOutIds.has(g.id);
                    const isPicked = item.nflGameId === g.id && !!item.qamfReservationId;
                    return (
                      <button
                        key={g.id}
                        type="button"
                        disabled={isSoldOut || reservingId !== null || tooManyLanes}
                        onClick={() => void pickGame(g)}
                        aria-pressed={isPicked}
                        className="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all disabled:cursor-not-allowed"
                        style={{
                          borderColor: isPicked ? VIOLET : "transparent",
                          backgroundColor: isPicked
                            ? "rgba(167,139,250,0.12)"
                            : "rgba(255,255,255,0.03)",
                          opacity: isSoldOut || tooManyLanes ? 0.4 : 1,
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
                          {g.matchup}
                        </span>
                        {g.network && (
                          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-white/35">
                            {g.network}
                          </span>
                        )}
                        <span className="shrink-0">
                          {reservingId === g.id ? (
                            <span className="text-[11px]" style={{ color: VIOLET }}>
                              {t("nfl.card.holding")}
                            </span>
                          ) : isPicked ? (
                            <IconCheck size={18} style={{ color: VIOLET }} aria-hidden />
                          ) : isSoldOut ? (
                            <span className="text-[11px] font-semibold text-white/40">
                              {t("nfl.card.soldOut")}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="text-[11px] leading-relaxed text-white/40">{t("nfl.footer")}</p>
    </div>
  );
};

const NflGameStep: StepDef<BowlingItem> = {
  id: "nfl-game",
  title: "Pick Your Game",
  Component: NflGameStepComponent,
  // Keys on the ITEM marker seeded at entry (?experience=nfl), never on
  // experienceSlug — the slug only exists once a game is picked, so a slug test
  // could not gate the step that does the picking.
  isVisible: (item) => item.kind === "bowling" && !!(item as { isNfl?: boolean }).isNfl,
  canAdvance: (item) =>
    item.webOfferId && item.bookedAt && item.qamfReservationId && item.nflGameId
      ? true
      : { reason: "Pick your game to hold a VIP lane" },
};

export default NflGameStep;
