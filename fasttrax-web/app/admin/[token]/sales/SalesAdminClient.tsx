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
    <div className="min-h-screen bg-[#0a1128] text-white">
      <div className="max-w-7xl mx-auto p-3 sm:p-6">
        <header className="mb-3 sm:mb-5">
          <h1 className="text-xl sm:text-2xl font-bold uppercase tracking-wider">Sales · Web Reservations</h1>
          <p className="text-white/50 text-xs sm:text-sm mt-0.5 sm:mt-1 hidden sm:block">
            Volume + product mix from confirmed bookings. Data starts the day this dashboard shipped — no historical backfill.
          </p>
        </header>

        {/* Filter bar */}
        <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
          <label className="flex flex-col gap-1 text-xs text-white/60">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-white/60">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-white"
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
                className="px-2.5 py-1.5 text-xs rounded border border-white/15 bg-white/[0.02] text-white/70 hover:bg-white/10 transition-colors"
              >
                {p.l}
              </button>
            ))}
            <button
              type="button"
              onClick={load}
              className="ml-auto px-3 py-1.5 text-xs rounded font-bold bg-[#00E2E5] text-[#000418] hover:bg-white"
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
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
              <Card label="Reservations" value={data.totals.reservations} />
              <Card label="Racers" value={data.totals.racers} subtle="across bookings" />
              <Card label="Racing" value={data.totals.racingReservations + data.totals.mixedReservations} subtle={`${pctText(data.totals.racingReservations + data.totals.mixedReservations, data.totals.reservations)} of all`} />
              <Card label="Attractions" value={data.totals.attractionReservations + data.totals.mixedReservations} subtle={`${pctText(data.totals.attractionReservations + data.totals.mixedReservations, data.totals.reservations)} of all`} />
            </div>

            {/* ── Racing breakdown ── */}
            {data.racing.reservations > 0 && (
              <Section title="Racing">
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
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                        {tiles.map((pkg) => (
                          <Tile
                            key={pkg.id}
                            title={pkg.label}
                            primary={`${pkg.count}`}
                            primarySubtle={`/ ${data.racing.reservations} racing`}
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
                  />
                  <Tile
                    title="Add-on attach"
                    primary={`${data.racing.addOnAttachCount}`}
                    primarySubtle={`/${data.racing.reservations} racing bookings`}
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
              <Section title="Attractions">
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
              <Section title="Videos · Post-Race">
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
              <Section title="Daily volume">
                <div className="flex items-end gap-1.5 overflow-x-auto pb-2">
                  {data.byDay.map((d) => {
                    const h = Math.max(4, Math.round((d.reservations / maxDay) * 100));
                    return (
                      <div key={d.ymd} className="flex flex-col items-center gap-1 shrink-0" style={{ width: "44px" }}>
                        <div
                          className="w-full rounded-t bg-[#00E2E5]/70 hover:bg-[#00E2E5] transition-colors"
                          style={{ height: `${h}px` }}
                          title={`${d.reservations} reservation${d.reservations === 1 ? "" : "s"} · ${d.racers} racer${d.racers === 1 ? "" : "s"}`}
                        />
                        <div className="text-[10px] text-white/40">{formatDate(d.ymd)}</div>
                        <div className="text-[10px] text-white/70 font-mono">{d.reservations}</div>
                      </div>
                    );
                  })}
                </div>
              </Section>
            )}

            {/* ── SMS volume by day + source ── */}
            {data.sms && data.sms.totals.attempts > 0 && (
              <Section title="SMS volume">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  <MiniStat
                    label="Booking confirmations"
                    value={data.sms.totals.bookingConfirm}
                  />
                  <MiniStat label="E-tickets" value={data.sms.totals.eTicket} />
                  <MiniStat label="Check-ins" value={data.sms.totals.checkIn} />
                  <MiniStat label="Videos" value={data.sms.totals.video} />
                </div>
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
                {data.sms.byDay.length > 0 && (
                  <div className="rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-white/5 text-xs uppercase text-white/50">
                          <tr>
                            <th className="text-left px-3 py-2">Date</th>
                            <th className="text-right px-3 py-2">Booking</th>
                            <th className="text-right px-3 py-2">E-ticket</th>
                            <th className="text-right px-3 py-2">Check-in</th>
                            <th className="text-right px-3 py-2">Video</th>
                            <th className="text-right px-3 py-2 text-white/40">Other</th>
                            <th className="text-right px-3 py-2">Total</th>
                            <th className="text-right px-3 py-2">Delivered</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...data.sms.byDay].reverse().map((d) => (
                            <tr key={d.date} className="border-t border-white/5">
                              <td className="px-3 py-2 text-white/80 whitespace-nowrap">
                                {formatDate(d.date)}
                              </td>
                              <td className="px-3 py-2 text-right text-white/85 font-mono">
                                {d.bySource.bookingConfirm || "—"}
                              </td>
                              <td className="px-3 py-2 text-right text-white/85 font-mono">
                                {d.bySource.eTicket || "—"}
                              </td>
                              <td className="px-3 py-2 text-right text-white/85 font-mono">
                                {d.bySource.checkIn || "—"}
                              </td>
                              <td className="px-3 py-2 text-right text-white/85 font-mono">
                                {d.bySource.video || "—"}
                              </td>
                              <td className="px-3 py-2 text-right text-white/40 font-mono">
                                {d.bySource.other || "—"}
                              </td>
                              <td className="px-3 py-2 text-right text-white font-mono font-semibold">
                                {d.attempts}
                              </td>
                              <td className="px-3 py-2 text-right text-emerald-300/80 font-mono text-xs">
                                {d.delivered}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </Section>
            )}

            {/* ── Raw entries ── */}
            <Section title={`Reservations (${data.entries.length})`}>
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

function Card({ label, value, subtle }: { label: string; value: number | string; subtle?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="text-[10px] uppercase tracking-wider text-white/50 mb-1">{label}</div>
      <div className="text-2xl font-bold text-white">{value}</div>
      {subtle && <div className="text-[11px] text-white/40 mt-0.5">{subtle}</div>}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-white/10 bg-white/[0.02] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-white/45">{label}</div>
      <div className="text-base font-bold text-white">{value}</div>
    </div>
  );
}

function Tile({
  title,
  primary,
  primarySubtle,
  rows,
}: {
  title: string;
  primary: string;
  primarySubtle?: string;
  rows?: { label: string; value: string }[];
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className="text-xs uppercase tracking-wider text-white/55 mb-1">{title}</div>
      <div className="text-3xl font-bold text-white">
        {primary}
        {primarySubtle && <span className="text-sm font-normal text-white/40 ml-1.5">{primarySubtle}</span>}
      </div>
      {rows && rows.length > 0 && (
        <div className="mt-3 space-y-1 text-xs">
          {rows.map((r, i) => (
            <div key={i} className="flex justify-between gap-2 text-white/70">
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
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="text-xs uppercase tracking-wider text-white/55 mb-2.5">{title}</div>
      <div className="space-y-1.5">
        {rows.map((r) => {
          const w = Math.round((r.count / max) * 100);
          return (
            <div key={r.name} className="flex items-center gap-2 text-xs">
              <div className="flex-1 truncate text-white/80">{r.name}</div>
              <div className="w-32 h-1.5 rounded-full bg-white/5 overflow-hidden">
                <div className="h-full bg-[#00E2E5]/70" style={{ width: `${w}%` }} />
              </div>
              <div className="w-8 text-right font-mono text-white/70">{r.count}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-sm font-bold uppercase tracking-wider text-white/80 mb-3">{title}</h2>
      {children}
    </section>
  );
}
