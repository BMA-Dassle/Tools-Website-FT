"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Sales dashboard for web reservations.
 *
 *   - Filter bar: from / to date range with quick-preset buttons
 *     (Today, Yesterday, Last 7d, Last 30d, MTD)
 *   - Top-line stats cards: reservations, racers, mix breakdown
 *   - Racing breakdown: Rookie Pack uptake, POV attach (new vs
 *     returning), license, add-on attach rate
 *   - Top race products + top add-ons
 *   - Per-day mini-bar timeline
 *   - Raw entries table with newest-first ordering
 *
 * Reads /api/admin/sales/list. No POST yet — read-only dashboard.
 */

type SaleEntry = {
  ts: string;
  billId?: string;
  reservationNumber?: string;
  brand?: "fasttrax" | "headpinz";
  location?: "fortmyers" | "naples";
  bookingType: "racing" | "racing-pack" | "attractions" | "mixed" | "other";
  participantCount?: number;
  isNewRacer?: boolean;
  /** @deprecated use packageId */
  rookiePack?: boolean;
  /** Package ID if this booking used a named bundle. */
  packageId?: string;
  povPurchased?: boolean;
  povQty?: number;
  licensePurchased?: boolean;
  expressLane?: boolean;
  raceProductNames?: string[];
  addOnNames?: string[];
  totalUsd?: number;
  email?: string;
  phone?: string;
};

type ListResponse = {
  range: { from: string; to: string; days: number };
  totals: {
    reservations: number;
    racers: number;
    racingReservations: number;
    racingPackReservations: number;
    attractionReservations: number;
    mixedReservations: number;
  };
  racing: {
    reservations: number;
    newRacers: number;
    returningRacers: number;
    expressLane: number;
    rookiePack: { count: number; pctOfNew: number; pctOfRacing: number };
    packages: {
      total: number;
      byType: { id: string; label: string; count: number; pctOfRacing: number }[];
    };
    pov: {
      count: number;
      qty: number;
      attachRate: number;
      byNewRacer: number;
      byReturning: number;
      attachRateNewRacer: number;
      attachRateReturning: number;
      byTier?: { tier: string; racingCount: number; povCount: number; attachRate: number }[];
    };
    license: { count: number };
    addOnAttachCount: number;
    addOnAttachRate: number;
    topRaceProducts: { name: string; count: number }[];
  };
  attractions: {
    reservations: number;
    topAddOns: { name: string; count: number }[];
  };
  videos?: {
    total: number;
    purchased: number;
    viewed: number;
    smsSent: number;
    pending: number;
    purchaseRate: number;
    smsDeliveryRate: number;
    byTrack: { track: string; total: number; purchased: number; viewed: number; smsSent: number; purchaseRate: number }[];
    byRaceType: { raceType: string; total: number; purchased: number; purchaseRate: number }[];
  };
  byDay: { ymd: string; reservations: number; racers: number }[];
  /** SMS volume per day + range totals. Sources bucketed into the
   *  dashboard's four categories — booking confirmations, e-tickets,
   *  check-ins, videos — plus an "other" catch-all. */
  sms?: {
    totals: {
      attempts: number;
      ok: number;
      delivered: number;
      bookingConfirm: number;
      eTicket: number;
      checkIn: number;
      video: number;
      other: number;
    };
    byDay: {
      date: string;
      attempts: number;
      ok: number;
      delivered: number;
      bySource: {
        bookingConfirm: number;
        eTicket: number;
        checkIn: number;
        video: number;
        other: number;
      };
    }[];
  };
  entries: SaleEntry[];
};

function todayET(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function shiftDays(ymd: string, n: number): string {
  // Anchor at noon UTC so DST transitions don't bump us a day.
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function startOfMonthET(): string {
  const today = todayET();
  return today.slice(0, 8) + "01";
}

function formatDate(ymd: string): string {
  try {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short", day: "numeric",
    }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  } catch { return ymd; }
}

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
  } catch { return iso; }
}

function bookingTypeLabel(t: SaleEntry["bookingType"]): string {
  if (t === "racing") return "Racing";
  if (t === "racing-pack") return "Race Pack";
  if (t === "attractions") return "Attractions";
  if (t === "mixed") return "Racing + Attr";
  return "Other";
}

function bookingTypeColor(t: SaleEntry["bookingType"]): string {
  if (t === "racing") return "bg-blue-500/20 text-blue-300";
  if (t === "racing-pack") return "bg-purple-500/20 text-purple-300";
  if (t === "attractions") return "bg-emerald-500/20 text-emerald-300";
  if (t === "mixed") return "bg-amber-500/20 text-amber-300";
  return "bg-white/10 text-white/60";
}

/**
 * Reduce a packageId to its "family" — the human-facing brand the
 * customer sees on the picker — so the dashboard can offer a single
 * "Ultimate Qualifier: 26" tile instead of seven variant tiles.
 *
 * Strategy: strip the trailing schedule/age suffixes that
 * `lib/packages.ts` appends to the family id (`-mega`, `-weekday`,
 * `-weekend`, `-junior`, plus `-weekday-junior` / `-weekend-junior`
 * compound suffixes). Whatever's left is the family id, which we
 * lowercase-then-titlecase for display.
 *
 * Special-cased the legacy `rookie-pack` row (no suffix) so the
 * confirmation-page back-compat path doesn't get its own tile.
 */
function packageFamilyId(packageId: string): string {
  // Stripped suffixes come from lib/packages.ts:41 — `PackageId` union.
  return packageId
    .replace(/-(weekday|weekend|mega)(-junior)?$/, "")
    .replace(/-junior$/, "");
}

function packageFamilyLabel(familyId: string): string {
  // Convert "ultimate-qualifier" → "Ultimate Qualifier".
  return familyId
    .split("-")
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : ""))
    .join(" ");
}

export default function SalesAdminClient({ token }: { token: string }) {
  const [from, setFrom] = useState(todayET());
  const [to, setTo] = useState(todayET());
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Toggle: collapse `ultimate-qualifier-{mega,weekday,weekend,…}` into a
  // single "Ultimate Qualifier" tile (and same for Rookie Pack). Default
  // ON because the variant breakdown is rarely the question being asked
  // at this dashboard — total package family uptake is. Persisted to
  // localStorage so the toggle sticks across reloads.
  const [combineFamilies, setCombineFamilies] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const v = window.localStorage.getItem("sales_combine_families");
    return v === null ? true : v === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "sales_combine_families",
      combineFamilies ? "1" : "0",
    );
  }, [combineFamilies]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ from, to, token });
      const res = await fetch(`/api/admin/sales/list?${qs.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`list failed: ${res.status}`);
      const json = (await res.json()) as ListResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    } finally {
      setLoading(false);
    }
  }, [from, to, token]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  // Preset buttons
  function preset(kind: "today" | "yesterday" | "7d" | "30d" | "mtd") {
    const today = todayET();
    if (kind === "today") { setFrom(today); setTo(today); return; }
    if (kind === "yesterday") {
      const y = shiftDays(today, -1);
      setFrom(y); setTo(y); return;
    }
    if (kind === "7d") { setFrom(shiftDays(today, -6)); setTo(today); return; }
    if (kind === "30d") { setFrom(shiftDays(today, -29)); setTo(today); return; }
    if (kind === "mtd") { setFrom(startOfMonthET()); setTo(today); return; }
  }

  const maxDay = useMemo(() => {
    if (!data?.byDay) return 1;
    return Math.max(1, ...data.byDay.map((d) => d.reservations));
  }, [data]);

  return (
    <div
      className="min-h-screen text-white"
      style={{
        background: "radial-gradient(ellipse at top, rgba(0,226,229,0.06) 0%, transparent 50%), #050b1d",
      }}
    >
      <div className="max-w-7xl mx-auto p-3 sm:p-6">
        <header className="mb-5 sm:mb-7">
          <div className="flex items-baseline gap-3 mb-1.5">
            <span
              className="text-xs font-bold uppercase tracking-[0.3em]"
              style={{ color: ACCENTS.cyan.fg }}
            >
              FastTrax · Admin
            </span>
            <span className="text-[10px] uppercase tracking-wider text-white/30 hidden sm:inline">
              Web Reservations Dashboard
            </span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
            Sales Overview
          </h1>
          <p className="text-white/45 text-xs sm:text-sm mt-1 hidden sm:block">
            Volume, product mix, and SMS pipeline health — confirmed bookings only.
          </p>
        </header>

        {/* Filter bar */}
        <div className="mb-5 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-white/50 font-semibold">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-cyan-400/40 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-white/50 font-semibold">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:border-cyan-400/40 focus:outline-none"
            />
          </label>
          <div className="col-span-2 flex flex-wrap items-end gap-2">
            {([
              { k: "today", l: "Today" },
              { k: "yesterday", l: "Yesterday" },
              { k: "7d", l: "Last 7d" },
              { k: "30d", l: "Last 30d" },
              { k: "mtd", l: "MTD" },
            ] as const).map((p) => (
              <button
                key={p.k}
                type="button"
                onClick={() => preset(p.k)}
                className="px-3 py-1.5 text-xs font-semibold rounded-full border border-white/15 bg-white/[0.02] text-white/70 hover:bg-white/10 hover:border-white/25 transition-colors"
              >
                {p.l}
              </button>
            ))}
            <button
              type="button"
              onClick={load}
              className="ml-auto px-4 py-1.5 text-xs font-bold uppercase tracking-wider rounded-full text-[#000418] transition-all hover:scale-105"
              style={{
                background: `linear-gradient(135deg, ${ACCENTS.cyan.fg} 0%, #38f0f3 100%)`,
                boxShadow: `0 0 12px ${ACCENTS.cyan.glow}`,
              }}
            >
              Refresh
            </button>
          </div>
        </div>

        {/* Status line */}
        <div className="mb-4 text-xs text-white/50">
          {loading
            ? "Loading…"
            : error
              ? <span className="text-red-400">{error}</span>
              : data
                ? `${data.totals.reservations} reservation${data.totals.reservations === 1 ? "" : "s"} · ${data.range.days} day${data.range.days === 1 ? "" : "s"}`
                : ""}
        </div>

        {data && data.totals.reservations === 0 && !loading && (
          <div className="rounded-lg border border-white/10 bg-white/[0.02] text-center text-white/40 py-12 text-sm">
            No web reservations in this range yet.
          </div>
        )}

        {data && data.totals.reservations > 0 && (
          <>
            {/* ── Top-line cards ── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <Card
                label="Reservations"
                value={data.totals.reservations}
                accent="cyan"
                icon="📋"
              />
              <Card
                label="Racers"
                value={data.totals.racers}
                subtle="across bookings"
                accent="coral"
                icon="🏁"
              />
              <Card
                label="Racing"
                value={data.totals.racingReservations + data.totals.mixedReservations}
                subtle={`${pctText(data.totals.racingReservations + data.totals.mixedReservations, data.totals.reservations)} of all`}
                accent="blue"
                icon="🏎"
              />
              <Card
                label="Attractions"
                value={data.totals.attractionReservations + data.totals.mixedReservations}
                subtle={`${pctText(data.totals.attractionReservations + data.totals.mixedReservations, data.totals.reservations)} of all`}
                accent="purple"
                icon="🎯"
              />
            </div>

            {/* ── Racing breakdown ── */}
            {data.racing.reservations > 0 && (
              <Section title="Racing" icon="🏎">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                  <MiniStat label="New racers" value={data.racing.newRacers} />
                  <MiniStat label="Returning" value={data.racing.returningRacers} />
                  <MiniStat label="Express Lane" value={data.racing.expressLane} />
                  <MiniStat label="Avg racers / booking" value={data.racing.reservations > 0 ? (data.totals.racers / data.racing.reservations).toFixed(1) : "--"} />
                </div>

                {/* Packages */}
                {data.racing.packages.byType.length > 0 && (() => {
                  // When the toggle is on, fold every variant into its
                  // family bucket — Ultimate Qualifier (mega/weekday/
                  // weekend/junior) all roll up to "Ultimate Qualifier".
                  const tiles = combineFamilies
                    ? (() => {
                        const byFamily = new Map<
                          string,
                          { count: number; variants: string[] }
                        >();
                        for (const pkg of data.racing.packages.byType) {
                          const fam = packageFamilyId(pkg.id);
                          const slot = byFamily.get(fam) ?? {
                            count: 0,
                            variants: [],
                          };
                          slot.count += pkg.count;
                          slot.variants.push(pkg.id);
                          byFamily.set(fam, slot);
                        }
                        return Array.from(byFamily.entries())
                          .map(([fam, { count, variants }]) => ({
                            id: fam,
                            label: packageFamilyLabel(fam),
                            count,
                            variantCount: variants.length,
                            pctOfRacing:
                              data.racing.reservations > 0
                                ? Math.round(
                                    (count / data.racing.reservations) * 100,
                                  )
                                : 0,
                          }))
                          .sort((a, b) => b.count - a.count);
                      })()
                    : data.racing.packages.byType.map((pkg) => ({
                        id: pkg.id,
                        label: pkg.label,
                        count: pkg.count,
                        variantCount: 1,
                        pctOfRacing: pkg.pctOfRacing,
                      }));
                  return (
                    <div className="mb-4">
                      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                        <div className="text-xs uppercase tracking-wider text-white/55">
                          Packages{" "}
                          <span className="text-white/30 font-normal normal-case tracking-normal ml-1">
                            ({data.racing.packages.total} sold)
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setCombineFamilies((v) => !v)}
                          className={`text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full border transition-colors ${
                            combineFamilies
                              ? "bg-cyan-500/20 text-cyan-200 border-cyan-400/40 hover:bg-cyan-500/30"
                              : "bg-white/5 text-white/55 border-white/15 hover:bg-white/10"
                          }`}
                          aria-pressed={combineFamilies}
                          title={
                            combineFamilies
                              ? "Click to show every variant separately"
                              : "Click to roll variants up to one tile per family"
                          }
                        >
                          {combineFamilies ? "Combined ✓" : "Show variants"}
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                        {tiles.map((pkg) => (
                          <Tile
                            key={pkg.id}
                            title={pkg.label}
                            primary={`${pkg.count}`}
                            primarySubtle={`/ ${data.racing.reservations} racing`}
                            accent="amber"
                            rows={[
                              {
                                label: "% of racing bookings",
                                value: `${pkg.pctOfRacing}%`,
                              },
                              ...(combineFamilies && pkg.variantCount > 1
                                ? [
                                    {
                                      label: "Variants",
                                      value: `${pkg.variantCount}`,
                                    },
                                  ]
                                : []),
                            ]}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* POV */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                  <Tile
                    title="POV Race Video"
                    primary={`${data.racing.pov.count}`}
                    primarySubtle={`bookings · ${data.racing.pov.qty} videos sold`}
                    accent="purple"
                    rows={[
                      { label: "Attach rate (overall)", value: `${data.racing.pov.attachRate}%` },
                      { label: "  · new racers", value: `${data.racing.pov.byNewRacer} (${data.racing.pov.attachRateNewRacer}%)` },
                      { label: "  · returning", value: `${data.racing.pov.byReturning} (${data.racing.pov.attachRateReturning}%)` },
                      ...(data.racing.pov.byTier ?? []).map((t) => ({
                        label: `  · ${t.tier}`,
                        value: `${t.povCount} / ${t.racingCount} (${t.attachRate}%)`,
                      })),
                    ]}
                  />
                  <Tile
                    title="Packages (all types)"
                    primary={`${data.racing.packages.total}`}
                    primarySubtle="total package sales"
                    accent="amber"
                    rows={[
                      { label: "% of racing bookings", value: data.racing.reservations > 0 ? `${Math.round((data.racing.packages.total / data.racing.reservations) * 100)}%` : "—" },
                    ]}
                  />
                </div>

                {/* License + add-on attach */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                  <Tile
                    title="License sales"
                    primary={`${data.racing.license.count}`}
                    primarySubtle="bookings"
                    accent="blue"
                  />
                  <Tile
                    title="Add-on attach"
                    primary={`${data.racing.addOnAttachCount}`}
                    primarySubtle={`/${data.racing.reservations} racing bookings`}
                    accent="emerald"
                    rows={[
                      { label: "Attach rate", value: `${data.racing.addOnAttachRate}%` },
                    ]}
                  />
                </div>

                {data.racing.topRaceProducts.length > 0 && (
                  <CountList title="Top race products" rows={data.racing.topRaceProducts} />
                )}
              </Section>
            )}

            {/* ── Attractions breakdown ── */}
            {data.attractions.reservations > 0 && (
              <Section title="Attractions" icon="🎯">
                <div className="mb-3 text-xs text-white/60">
                  {data.attractions.reservations} reservation{data.attractions.reservations === 1 ? "" : "s"} included an attraction.
                </div>
                {data.attractions.topAddOns.length > 0 && (
                  <CountList title="Top attractions / add-ons" rows={data.attractions.topAddOns} />
                )}
              </Section>
            )}

            {/* ── Video post-sale breakdown ── */}
            {data.videos && data.videos.total > 0 && (
              <Section title="Videos · Post-Race" icon="🎥">
                {/* Top-line counts */}
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
                  <MiniStat label="Matched" value={data.videos.total} />
                  <MiniStat label="Purchased" value={`${data.videos.purchased} (${data.videos.purchaseRate}%)`} />
                  <MiniStat label="Viewed" value={data.videos.viewed} />
                  <MiniStat label="SMS sent" value={`${data.videos.smsSent} (${data.videos.smsDeliveryRate}%)`} />
                  <MiniStat label="Pending notify" value={data.videos.pending} />
                </div>

                {/* By track */}
                {data.videos.byTrack.length > 0 && (
                  <div className="mb-4">
                    <div className="text-xs uppercase tracking-wider text-white/55 mb-2">By track</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                      {data.videos.byTrack.map((t) => (
                        <Tile
                          key={t.track}
                          title={`${t.track} Track`}
                          primary={`${t.purchased}`}
                          primarySubtle={`/ ${t.total} matched`}
                          rows={[
                            { label: "Purchase rate", value: `${t.purchaseRate}%` },
                            { label: "Viewed", value: `${t.viewed}` },
                            { label: "SMS sent", value: `${t.smsSent}` },
                          ]}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* By race type */}
                {data.videos.byRaceType.length > 0 && (
                  <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
                    <div className="text-xs uppercase tracking-wider text-white/55 mb-2.5">By race type</div>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-white/40 uppercase tracking-wider">
                          <th className="text-left pb-2 font-medium">Race type</th>
                          <th className="text-right pb-2 font-medium">Matched</th>
                          <th className="text-right pb-2 font-medium">Purchased</th>
                          <th className="text-right pb-2 font-medium">Buy rate</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {data.videos.byRaceType.map((r) => (
                          <tr key={r.raceType}>
                            <td className="py-1.5 text-white/80">{r.raceType}</td>
                            <td className="py-1.5 text-right font-mono text-white/60">{r.total}</td>
                            <td className="py-1.5 text-right font-mono text-white/80">{r.purchased}</td>
                            <td className="py-1.5 text-right font-mono text-[#00E2E5]">{r.purchaseRate}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            )}

            {/* ── Per-day timeline ── */}
            {data.byDay.length > 1 && (
              <Section title="Daily volume" icon="📈">
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                  <div className="flex items-end gap-2 overflow-x-auto pb-1" style={{ minHeight: 130 }}>
                    {data.byDay.map((d) => {
                      const h = Math.max(6, Math.round((d.reservations / maxDay) * 110));
                      return (
                        <div
                          key={d.ymd}
                          className="flex flex-col items-center gap-1.5 shrink-0 group"
                          style={{ width: "48px" }}
                        >
                          <div className="text-[10px] font-mono text-white/85 group-hover:text-white">
                            {d.reservations || ""}
                          </div>
                          <div
                            className="w-full rounded-t-md transition-all group-hover:scale-y-105 origin-bottom"
                            style={{
                              height: `${h}px`,
                              background: `linear-gradient(180deg, ${ACCENTS.cyan.fg} 0%, ${ACCENTS.cyan.fg}80 100%)`,
                              boxShadow: `0 0 14px ${ACCENTS.cyan.glow}`,
                            }}
                            title={`${d.reservations} reservation${d.reservations === 1 ? "" : "s"} · ${d.racers} racer${d.racers === 1 ? "" : "s"}`}
                          />
                          <div className="text-[10px] text-white/45">{formatDate(d.ymd)}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </Section>
            )}

            {/* ── SMS volume by day + source ── */}
            {data.sms && data.sms.totals.attempts > 0 && (() => {
              // Color tokens for the four SMS source buckets — used for
              // both the per-source KPI tiles AND the stacked-bar chart
              // below so the legend reads consistently.
              const SMS_SOURCES = [
                { key: "bookingConfirm" as const, label: "Booking confirmations", icon: "📋", accent: "cyan"    as AccentKey },
                { key: "eTicket"        as const, label: "E-tickets",             icon: "🎟",  accent: "coral"   as AccentKey },
                { key: "checkIn"        as const, label: "Check-ins",             icon: "📣", accent: "amber"   as AccentKey },
                { key: "video"          as const, label: "Videos",                icon: "🎥", accent: "purple"  as AccentKey },
              ];
              const maxDailyAttempts = Math.max(
                1,
                ...data.sms!.byDay.map((d) => d.attempts),
              );
              return (
                <Section title="SMS volume" icon="💬">
                  {/* Per-source headline tiles — color-coded so eye can
                      jump straight to the bucket it cares about. */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                    {SMS_SOURCES.map((src) => (
                      <Card
                        key={src.key}
                        label={src.label}
                        value={data.sms!.totals[src.key]}
                        accent={src.accent}
                        icon={src.icon}
                      />
                    ))}
                  </div>

                  {/* Total attempts / provider OK / delivered — gives a
                      health pulse on the entire send pipeline at a glance. */}
                  <div className="grid grid-cols-3 gap-2 mb-4">
                    <MiniStat
                      label="Total attempts"
                      value={data.sms.totals.attempts}
                    />
                    <MiniStat
                      label="Provider OK"
                      value={`${data.sms.totals.ok} (${pctText(data.sms.totals.ok, data.sms.totals.attempts)})`}
                    />
                    <MiniStat
                      label="Carrier delivered"
                      value={`${data.sms.totals.delivered} (${pctText(data.sms.totals.delivered, data.sms.totals.attempts)})`}
                    />
                  </div>

                  {/* Stacked-bar per day — replaces the wall-of-numbers
                      table. Each bar is normalized to the busiest day so
                      a quiet Sunday doesn't disappear next to a peak
                      Saturday. Hovering a bar shows the breakdown. */}
                  {data.sms.byDay.length > 0 && (
                    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-white/60">
                          Daily breakdown
                        </div>
                        <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider">
                          {SMS_SOURCES.map((src) => (
                            <span key={src.key} className="flex items-center gap-1.5 text-white/55">
                              <span
                                className="w-2 h-2 rounded-full inline-block"
                                style={{ backgroundColor: ACCENTS[src.accent].fg }}
                              />
                              {src.label.split(" ")[0]}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        {[...data.sms.byDay].reverse().map((d) => {
                          const segments = SMS_SOURCES.map((src) => ({
                            value: d.bySource[src.key],
                            color: ACCENTS[src.accent].fg,
                          }));
                          const breakdown = SMS_SOURCES
                            .map((src) => `${src.label.split(" ")[0]}: ${d.bySource[src.key]}`)
                            .join(" · ");
                          return (
                            <div
                              key={d.date}
                              className="grid items-center gap-3 text-xs"
                              style={{ gridTemplateColumns: "70px 1fr 80px" }}
                              title={breakdown}
                            >
                              <div className="text-white/55 font-mono whitespace-nowrap">
                                {formatDate(d.date)}
                              </div>
                              <StackedBar segments={segments} max={maxDailyAttempts} />
                              <div className="text-right">
                                <span className="font-mono font-semibold text-white">{d.attempts}</span>
                                {d.delivered > 0 && d.delivered < d.attempts && (
                                  <span
                                    className="ml-1.5 text-[10px] font-mono"
                                    style={{ color: ACCENTS.emerald.fg }}
                                    title={`${d.delivered} carrier-delivered`}
                                  >
                                    ✓{d.delivered}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </Section>
              );
            })()}

            {/* ── Raw entries ── */}
            <Section title={`Reservations (${data.entries.length})`} icon="📋">
              <div className="rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-white/5 text-xs uppercase text-white/50">
                      <tr>
                        <th className="text-left px-3 py-2">Time</th>
                        <th className="text-left px-3 py-2">Type</th>
                        <th className="text-left px-3 py-2">Racers</th>
                        <th className="text-left px-3 py-2">New?</th>
                        <th className="text-left px-3 py-2">Pack/POV/Lic</th>
                        <th className="text-left px-3 py-2">Products</th>
                        <th className="text-left px-3 py-2">Add-ons</th>
                        <th className="text-left px-3 py-2">Bill</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.entries.map((e, i) => (
                        <tr key={`${e.billId ?? i}-${e.ts}`} className="border-t border-white/5">
                          <td className="px-3 py-2 whitespace-nowrap text-white/80">{formatTs(e.ts)}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded ${bookingTypeColor(e.bookingType)}`}>
                              {bookingTypeLabel(e.bookingType)}
                            </span>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-white/70">{e.participantCount ?? "—"}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {e.isNewRacer === true
                              ? <span className="text-emerald-300 text-xs">new</span>
                              : e.isNewRacer === false
                                ? <span className="text-white/40 text-xs">returning</span>
                                : <span className="text-white/30 text-xs">—</span>}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-xs">
                            {e.packageId && (
                              <span className="text-amber-300 mr-1 uppercase tracking-wide">
                                {e.packageId === "rookie-pack"
                                  ? "ROOKIE"
                                  : e.packageId === "ultimate-qualifier-mega"
                                    ? "ULT-Q"
                                    : e.packageId.toUpperCase().slice(0, 8)}
                              </span>
                            )}
                            {e.povPurchased && <span className="text-purple-300 mr-1">POV{e.povQty ? `×${e.povQty}` : ""}</span>}
                            {e.licensePurchased && <span className="text-blue-300">LIC</span>}
                            {!e.packageId && !e.povPurchased && !e.licensePurchased && <span className="text-white/30">—</span>}
                          </td>
                          <td className="px-3 py-2 text-white/70 text-xs">
                            {e.raceProductNames?.length ? e.raceProductNames.join(", ") : "—"}
                          </td>
                          <td className="px-3 py-2 text-white/70 text-xs">
                            {e.addOnNames?.length ? e.addOnNames.join(", ") : "—"}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-white/40">{e.reservationNumber || e.billId?.slice(-8) || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function pctText(num: number, denom: number): string {
  if (!denom) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

// ── Visual helpers ─────────────────────────────────────────────────────────
// Color tokens used across the dashboard. Mirrors the team-member-portal
// approach (semantic per-domain colors) without dragging shadcn into
// this codebase: cyan = system / racing primary, coral = brand,
// amber = packages, emerald = ok / delivered, purple = POV / video,
// blue = informational, red = issues.
const ACCENTS = {
  cyan:    { fg: "#00E2E5", glow: "rgba(0,226,229,0.18)", border: "rgba(0,226,229,0.35)" },
  coral:   { fg: "#fd5b56", glow: "rgba(253,91,86,0.18)", border: "rgba(253,91,86,0.35)" },
  amber:   { fg: "#fbbf24", glow: "rgba(251,191,36,0.18)", border: "rgba(251,191,36,0.35)" },
  emerald: { fg: "#34d399", glow: "rgba(52,211,153,0.18)", border: "rgba(52,211,153,0.35)" },
  purple:  { fg: "#c084fc", glow: "rgba(192,132,252,0.18)", border: "rgba(192,132,252,0.35)" },
  blue:    { fg: "#60a5fa", glow: "rgba(96,165,250,0.18)", border: "rgba(96,165,250,0.35)" },
  rose:    { fg: "#fb7185", glow: "rgba(251,113,133,0.18)", border: "rgba(251,113,133,0.35)" },
  slate:   { fg: "rgba(255,255,255,0.85)", glow: "rgba(255,255,255,0.05)", border: "rgba(255,255,255,0.12)" },
} as const;
type AccentKey = keyof typeof ACCENTS;

function Card({
  label,
  value,
  subtle,
  accent = "slate",
  icon,
}: {
  label: string;
  value: number | string;
  subtle?: string;
  accent?: AccentKey;
  icon?: string;
}) {
  const c = ACCENTS[accent];
  return (
    <div
      className="rounded-xl px-4 py-3.5 transition-colors"
      style={{
        background: `linear-gradient(135deg, ${c.glow} 0%, rgba(255,255,255,0.02) 70%)`,
        border: `1px solid ${c.border}`,
      }}
    >
      <div className="flex items-start justify-between mb-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-white/55">{label}</div>
        {icon && <div className="text-base leading-none opacity-70">{icon}</div>}
      </div>
      <div className="text-3xl font-extrabold text-white tracking-tight" style={{ color: c.fg }}>{value}</div>
      {subtle && <div className="text-[11px] text-white/45 mt-1">{subtle}</div>}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">{label}</div>
      <div className="text-lg font-bold text-white">{value}</div>
    </div>
  );
}

function Tile({
  title,
  primary,
  primarySubtle,
  rows,
  accent = "slate",
}: {
  title: string;
  primary: string;
  primarySubtle?: string;
  rows?: { label: string; value: string }[];
  accent?: AccentKey;
}) {
  const c = ACCENTS[accent];
  return (
    <div
      className="rounded-xl p-4 transition-colors"
      style={{
        background: `linear-gradient(135deg, ${c.glow} 0%, rgba(255,255,255,0.02) 75%)`,
        border: `1px solid ${c.border}`,
      }}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wider text-white/60 mb-1.5">{title}</div>
      <div className="text-3xl font-extrabold tracking-tight" style={{ color: c.fg }}>
        {primary}
        {primarySubtle && <span className="text-sm font-normal text-white/40 ml-1.5">{primarySubtle}</span>}
      </div>
      {rows && rows.length > 0 && (
        <div className="mt-3 space-y-1 text-xs">
          {rows.map((r, i) => (
            <div key={i} className="flex justify-between gap-2 text-white/65">
              <span>{r.label}</span>
              <span className="font-mono text-white/90">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CountList({ title, rows }: { title: string; rows: { name: string; count: number }[] }) {
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-white/60 mb-3">{title}</div>
      <div className="space-y-2">
        {rows.map((r) => {
          const w = Math.round((r.count / max) * 100);
          return (
            <div key={r.name} className="flex items-center gap-3 text-xs">
              <div className="flex-1 truncate text-white/80">{r.name}</div>
              <div className="w-32 h-2 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full transition-all"
                  style={{ width: `${w}%`, background: `linear-gradient(90deg, ${ACCENTS.cyan.fg}AA 0%, ${ACCENTS.cyan.fg} 100%)` }}
                />
              </div>
              <div className="w-10 text-right font-mono font-semibold text-white/85">{r.count}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-bold uppercase tracking-wider text-white/85 mb-3 flex items-center gap-2">
        {icon && <span className="text-base">{icon}</span>}
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Stacked horizontal bar — used in the SMS-volume table to visualize
 *  per-day source mix. Scales each bar to the busiest day in the window
 *  so days with little volume don't disappear. */
function StackedBar({
  segments,
  max,
}: {
  segments: { value: number; color: string }[];
  max: number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const widthPct = max > 0 ? (total / max) * 100 : 0;
  return (
    <div className="w-full h-2 rounded-full bg-white/5 overflow-hidden flex" style={{ width: `${widthPct}%`, minWidth: total > 0 ? "2px" : 0 }}>
      {segments.map((s, i) => {
        if (s.value === 0) return null;
        const segPct = (s.value / total) * 100;
        return (
          <div
            key={i}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ width: `${segPct}%`, backgroundColor: s.color }}
          />
        );
      })}
    </div>
  );
}
