"use client";

/**
 * GUEST race history — the racer's own account on the Your Crew page (owner
 * 2026-09-05: staff mode already shows this per roster card; "we might as well
 * show it to the racer" — plus their credits by kind: races, gel blaster,
 * laser tag, headsock…).
 *
 * Mount pattern mirrors StaffPersonActions: `GuestRaceHistoryActions` renders
 * inside every roster card and is NULL unless (a) the page opted in by
 * providing `GuestRaceHistorySurface` (only KioskCrewFlow does — the booking
 * wizard's people step stays focused on building the party) and (b) the member
 * resolved a BMI account. The sheet is a guest re-skin of the staff
 * RaceHistorySheet: same Office personStats/races data and the same
 * racing/qualify.ts cutoffs, so "0.84 s off Pro" here and the level-up text a
 * racer gets after a heat can never disagree — minus memberships, which stay
 * staff-only, plus the guest-facing credits section.
 *
 * Data rides /api/kiosk/race-history (read-only, no staff token — the guest's
 * own personId, obtained by signing in, is the capability).
 */
import { createContext, useContext, useEffect, useState } from "react";
import type { StaffLocation } from "../staff-mode/types";
import type { RaceHistoryRow, RaceHistorySummary, TrackKey } from "../staff-mode/race-history";
import { formatGapMs, formatLapMs } from "../staff-mode/race-history";
import { useLocale } from "../i18n/LocaleProvider";

/** Provided by pages that want guest race history on their roster cards
 *  (KioskCrewFlow). Default null = the button renders nowhere else. */
export const GuestRaceHistorySurface = createContext<{ location: StaffLocation } | null>(null);

// Track names stay English (brand/product glossary), colours match the staff
// sheet and the briefing board.
const TRACK_LABEL: Record<TrackKey, string> = { blue: "Blue", red: "Red", mega: "Mega" };
const TRACK_COLOR: Record<TrackKey, string> = { blue: "#4fa9ff", red: "#e53935", mega: "#f0b341" };
const TRACKS: TrackKey[] = ["blue", "red", "mega"];

interface GuestAccount {
  licenseActive: boolean | null;
  credits: Array<{ kind: string; balance: number }> | null;
  heats: RaceHistoryRow[] | null;
  summary: RaceHistorySummary | null;
}

/** "Red Starter" out of "46 - Red Starter" — the heat number is on its own. */
function heatParts(heat: string): { num: string; type: string } {
  const m = /^\s*(\d+)\s*-\s*(.+)$/.exec(heat);
  return m ? { num: m[1], type: m[2].trim() } : { num: "", type: heat };
}

export function GuestRaceHistoryActions({
  member,
}: {
  member: { firstName: string; lastName?: string; bmiPersonId?: string };
}) {
  const surface = useContext(GuestRaceHistorySurface);
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  if (!surface || !member.bmiPersonId) return null;
  const name = `${member.firstName} ${member.lastName ?? ""}`.trim();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="k-tap flex items-center gap-[10px] rounded-full border-[1.5px] border-[#00e2e5]/45 bg-[#00e2e5]/5 px-[24px] py-[12px] text-[22px] font-bold text-[#00e2e5]"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7 v5 l3.5 2" />
        </svg>
        {t("rh.button")}
      </button>
      {open && (
        <GuestRaceHistorySheet
          name={name}
          personId={member.bmiPersonId}
          location={surface.location}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function GuestRaceHistorySheet({
  name,
  personId,
  location,
  onClose,
}: {
  name: string;
  personId: string;
  location: StaffLocation;
  onClose: () => void;
}) {
  const { t, locale } = useLocale();
  const [account, setAccount] = useState<GuestAccount | null>(null);
  const [error, setError] = useState(false);

  const dateLocale = locale === "es" ? "es-US" : "en-US";
  const shortDate = (iso: string | null): string => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(dateLocale, { month: "short", day: "numeric", year: "numeric" });
  };
  const heatDate = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(dateLocale, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "2-digit" }),
    });
  };

  // One read per mount — opening the sheet for a different person is a fresh
  // mount with fresh (null) state, same as the staff sheet.
  useEffect(() => {
    let cancelled = false;
    void fetch(
      `/api/kiosk/race-history?personId=${encodeURIComponent(personId)}&location=${location}`,
    )
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(true);
          return;
        }
        setAccount((await res.json()) as GuestAccount);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [personId, location]);

  const summary = account?.summary ?? null;
  // "N this month" tile sub — computed from the visible heats, current month.
  const thisMonth = (() => {
    if (!account?.heats?.length) return 0;
    const now = new Date();
    return account.heats.filter((h) => {
      const d = new Date(h.when);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;
  })();

  return (
    <div className="fixed inset-0 z-[78] flex items-center justify-center bg-black/75 p-[44px] backdrop-blur-sm">
      <div className="k-glass flex max-h-full w-full max-w-[940px] flex-col gap-[26px] overflow-y-auto p-[44px]">
        <div>
          <div className="k-eyebrow">{t("rh.eyebrow")}</div>
          <div className="k-display mt-[10px] text-[56px]" style={{ textTransform: "none" }}>
            {name}
          </div>
          {(summary?.first || account?.licenseActive) && (
            <div className="mt-[8px] text-[24px] text-white/55">
              {[
                summary?.first ? t("rh.since", { date: shortDate(summary.first) }) : null,
                account?.licenseActive ? t("rh.licenceOnFile") : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
        </div>

        {!account && !error && (
          <div className="flex items-center gap-[16px] text-[26px] text-white/60">
            <span className="h-[28px] w-[28px] animate-spin rounded-full border-2 border-[#00e2e5]/30 border-t-[#00e2e5]" />
            {t("rh.loading")}
          </div>
        )}
        {error && <div className="text-[24px] text-[#f0b341]">{t("rh.error")}</div>}

        {account && (
          <>
            {/* Stat tiles — races + best per track, same numbers staff see. */}
            <div className="grid grid-cols-4 gap-[12px]">
              <Stat
                label={t("rh.races")}
                value={summary ? String(summary.races) : "—"}
                sub={thisMonth > 0 ? t("rh.thisMonth", { n: thisMonth }) : undefined}
              />
              {TRACKS.map((k) => (
                <Stat
                  key={k}
                  label={t("rh.best", { track: TRACK_LABEL[k] })}
                  value={formatLapMs(summary?.best[k])}
                  sub={
                    summary?.earned[k]
                      ? t("rh.pace", { level: summary.earned[k] as string })
                      : summary?.best[k]
                        ? t("rh.pace", { level: "Starter" })
                        : t("rh.notYet")
                  }
                  color={TRACK_COLOR[k]}
                />
              ))}
            </div>

            {/* Next-level line — the same qualify.ts cutoffs as the level-up
                texts, so the two can never disagree. */}
            {summary?.next && (
              <div className="rounded-[16px] border border-[#f0b341]/35 bg-[#f0b341]/10 px-[22px] py-[16px] text-[24px]">
                <b className="text-[#f0b341]">
                  {t("rh.nextGap", {
                    gap: formatGapMs(summary.next.gapMs),
                    level: summary.next.level,
                  })}
                </b>{" "}
                {t("rh.nextRest", {
                  track: TRACK_LABEL[summary.next.track],
                  time: formatLapMs(summary.next.targetMs),
                })}
              </div>
            )}

            {/* Credits by kind (owner 2026-09-05: "gel, laser, headsock, etc"). */}
            <div>
              <SectionLabel>{t("rh.credits")}</SectionLabel>
              {account.credits === null ? (
                <div className="text-[24px] text-white/45">{t("rh.creditsFailed")}</div>
              ) : account.credits.length === 0 ? (
                <div className="text-[24px] text-white/45">{t("rh.noCredits")}</div>
              ) : (
                <div className="flex flex-wrap gap-[12px]">
                  {account.credits.map((c) => (
                    <span
                      key={c.kind}
                      className="rounded-[14px] border border-white/10 bg-white/[0.04] px-[20px] py-[12px] text-[24px]"
                    >
                      <span className="k-display k-num mr-[10px] text-[30px] text-[#46d68c]">
                        {c.balance}
                      </span>
                      {c.kind}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Heats table — date, heat, kart, best/avg lap, laps, position. */}
            <div>
              <SectionLabel>{t("rh.heats")}</SectionLabel>
              {account.heats === null ? (
                <div className="text-[24px] text-white/45">{t("rh.error")}</div>
              ) : account.heats.length === 0 ? (
                <div className="text-[24px] text-white/45">{t("rh.noneYet")}</div>
              ) : (
                <div className="max-h-[520px] overflow-y-auto">
                  <table className="w-full border-collapse text-[24px] tabular-nums">
                    <thead>
                      <tr className="text-left">
                        <Th>{t("rh.th.date")}</Th>
                        <Th>{t("rh.th.heat")}</Th>
                        <Th>{t("rh.th.kart")}</Th>
                        <Th right>{t("rh.th.best")}</Th>
                        <Th right>{t("rh.th.avg")}</Th>
                        <Th right>{t("rh.th.laps")}</Th>
                        <Th right>{t("rh.th.pos")}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {account.heats.map((h, i) => {
                        const { num, type } = heatParts(h.heat);
                        return (
                          <tr key={`${h.when}-${i}`} className="border-t border-white/10">
                            <td className="py-[10px] pr-[10px] whitespace-nowrap">
                              {heatDate(h.when)}
                            </td>
                            <td className="py-[10px] pr-[10px]">
                              {num && <span className="mr-[10px] text-white/40">#{num}</span>}
                              {type}
                            </td>
                            <td className="py-[10px] pr-[10px] text-white/60">{h.kart || "—"}</td>
                            <td className="py-[10px] pr-[10px] text-right font-bold">
                              {formatLapMs(h.bestMs)}
                            </td>
                            <td className="py-[10px] pr-[10px] text-right text-white/60">
                              {formatLapMs(h.avgMs)}
                            </td>
                            <td className="py-[10px] pr-[10px] text-right text-white/60">
                              {h.laps ?? "—"}
                            </td>
                            <td className="py-[10px] text-right">{h.position ?? "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {/* Inline flex per the .kiosk-canvas cascade gotcha: k-btn-primary's
            flex:1 squashes its height in a column layout. */}
        <button
          type="button"
          onClick={onClose}
          className="k-btn-primary k-tap"
          style={{ flex: "0 0 auto" }}
        >
          {t("rh.close")}
        </button>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="k-eyebrow mb-[10px] text-[17px] tracking-[0.18em] text-white/45">
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-[16px] border border-white/10 bg-white/[0.04] px-[18px] py-[16px]">
      <div
        className="k-eyebrow text-[17px] tracking-[0.18em] text-white/45"
        style={color ? { color } : undefined}
      >
        {label}
      </div>
      <div className="k-display k-num mt-[4px] text-[40px]">{value}</div>
      {sub && <div className="mt-[2px] text-[18px] text-white/45">{sub}</div>}
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`k-eyebrow pb-[8px] pr-[10px] text-[17px] tracking-[0.18em] text-white/45 ${right ? "text-right" : ""}`}
    >
      {children}
    </th>
  );
}
