"use client";

/**
 * Race Info hub — "Race Records" sub-screen. Hall-of-Fame fastest laps from
 * the SMS-Timing best-times feed (/api/besttimes proxy — the same live data
 * as /leaderboards), per track + tier + class, with time-range filters.
 * The track/tier/class → rscId/scgId matrix comes from the shared
 * ~/lib/constants/race-records module.
 */
import { useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { IconTrophy } from "@tabler/icons-react";
import {
  RECORD_TRACKS,
  recordsStartDate,
  formatRecordDate,
  formatRecordTime,
  type BestTimeRecord,
  type RecordCategory,
  type RecordTimeRange,
} from "~/lib/constants/race-records";
import { useT } from "../../i18n";

type RecordClass = "adult" | "junior";
type RecordTier = "starter" | "intermediate" | "pro";

// Tier names (Starter / Intermediate / Pro) are racing proper nouns — kept
// untranslated to match the racing license + the racing-content constants.
const TIERS: Array<{ key: RecordTier; label: string }> = [
  { key: "starter", label: "Starter" },
  { key: "intermediate", label: "Intermediate" },
  { key: "pro", label: "Pro" },
];

/**
 * Resolve the SMS-Timing category for a (class, tier) on a track. Junior
 * groups aren't uniform (Red has one generic "Junior" group; Mega has no
 * junior Starter), so match by label with a generic-junior fallback.
 */
function categoryFor(
  trackKey: "blue" | "red" | "mega",
  cls: RecordClass,
  tier: RecordTier,
): RecordCategory | null {
  const track = RECORD_TRACKS.find((t) => t.key === trackKey);
  if (!track) return null;
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  if (cls === "adult") {
    return track.adult.find((c) => c.label === tierLabel) ?? null;
  }
  return (
    track.junior.find((c) => c.label === `Junior ${tierLabel}`) ??
    track.junior.find((c) => c.label === "Junior") ??
    null
  );
}

function chipRow<T extends string>(
  options: Array<{ key: T; label: string }>,
  active: T,
  onPick: (key: T) => void,
) {
  return (
    <div className="flex gap-[16px]">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`k-chip k-tap flex-1 ${active === o.key ? "sel" : ""}`}
          onClick={() => onPick(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function RaceRecords() {
  const t = useT();
  const [range, setRange] = useState<RecordTimeRange>("alltime");
  const [cls, setCls] = useState<RecordClass>("adult");
  const [tier, setTier] = useState<RecordTier>("pro");

  const ranges: Array<{ key: RecordTimeRange; label: string }> = [
    { key: "alltime", label: t("raceInfo.range.alltime") },
    { key: "year", label: t("raceInfo.range.year") },
    { key: "month", label: t("raceInfo.range.month") },
  ];

  const panels = RECORD_TRACKS.map((track) => ({
    track,
    category: categoryFor(track.key, cls, tier),
  })).filter((p): p is { track: (typeof RECORD_TRACKS)[number]; category: RecordCategory } =>
    Boolean(p.category),
  );

  const startDate = recordsStartDate(range);
  const queries = useQueries({
    queries: panels.map(({ category }) => ({
      queryKey: ["besttimes", category.rscId, category.scgId, startDate],
      queryFn: async (): Promise<BestTimeRecord[]> => {
        const url = `/api/besttimes?endpoint=records&rscId=${category.rscId}&scgId=${
          category.scgId
        }&startDate=${encodeURIComponent(startDate)}&maxResult=5`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`besttimes ${res.status}`);
        const data = await res.json();
        return (data.records ?? []) as BestTimeRecord[];
      },
      staleTime: 5 * 60_000,
    })),
  });

  // Hero = the overall fastest #1 across the visible panels. Mega scores are
  // "1:02.212" strings; convert to seconds for comparison.
  const toSeconds = (score: string): number => {
    if (score.includes(":")) {
      const [m, s] = score.split(":");
      return Number(m) * 60 + Number(s);
    }
    return parseFloat(score);
  };
  let hero: { record: BestTimeRecord; trackLabel: string } | null = null;
  queries.forEach((q, i) => {
    const first = q.data?.[0];
    if (!first) return;
    if (!hero || toSeconds(first.score) < toSeconds(hero.record.score)) {
      hero = { record: first, trackLabel: panels[i].track.label };
    }
  });
  const heroPanel = hero as { record: BestTimeRecord; trackLabel: string } | null;
  const isLoading = queries.some((q) => q.isLoading);

  return (
    <div className="flex flex-col gap-[28px] pb-[48px]">
      {chipRow(ranges, range, setRange)}
      {chipRow(
        [
          { key: "adult" as RecordClass, label: t("raceInfo.class.adult") },
          { key: "junior" as RecordClass, label: t("raceInfo.class.junior") },
        ],
        cls,
        setCls,
      )}
      {chipRow(TIERS, tier, setTier)}

      {heroPanel && (
        <div className="flex items-center gap-[32px] rounded-[28px] border border-[#e8b14c]/40 bg-gradient-to-b from-[#e8b14c]/10 to-transparent p-[32px]">
          <IconTrophy size={72} className="shrink-0 text-[#e8b14c]" aria-hidden="true" />
          <div>
            <div className="k-eyebrow text-[#e8b14c]">
              {t("raceInfo.records.trackRecord", { track: heroPanel.trackLabel })}
            </div>
            <div className="k-display k-num mt-[6px] text-[72px]">
              {formatRecordTime(heroPanel.record.score)}
            </div>
            <div className="text-[26px] text-white/65">
              {heroPanel.record.participant} · {formatRecordDate(heroPanel.record.date)}
            </div>
          </div>
        </div>
      )}

      {panels.map(({ track, category }, i) => {
        const records = queries[i]?.data ?? [];
        return (
          <div
            key={track.key}
            className="overflow-hidden rounded-[28px] border border-white/10 bg-[#071027]"
            style={{ borderLeft: `8px solid ${track.accent}` }}
          >
            <div className="flex items-center justify-between px-[32px] pt-[24px]">
              <span className="k-display text-[34px]">
                {t("raceInfo.records.topN", { track: track.label })}
              </span>
              <span
                className="rounded-full px-[18px] py-[6px] text-[20px] font-bold uppercase tracking-wide"
                style={{ background: `${category.color}26`, color: category.color }}
              >
                {category.label}
              </span>
            </div>
            <div className="flex flex-col gap-[14px] px-[32px] pb-[28px] pt-[18px]">
              {records.length === 0 ? (
                <div className="py-[12px] text-[24px] text-white/40">
                  {isLoading ? t("raceInfo.loading") : t("raceInfo.records.empty")}
                </div>
              ) : (
                records.map((r) => (
                  <div
                    key={`${r.position}-${r.participant}`}
                    className="flex items-center gap-[20px]"
                  >
                    <span className="k-num w-[36px] text-[26px] font-bold text-[#e8b14c]">
                      {r.position}
                    </span>
                    <span className="flex-1 truncate text-[26px] font-semibold text-white/85">
                      {r.participant}
                    </span>
                    <span className="text-[20px] text-white/40">{formatRecordDate(r.date)}</span>
                    <span className="k-num w-[160px] text-right text-[26px] font-bold">
                      {formatRecordTime(r.score)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
