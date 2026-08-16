"use client";

/**
 * Kiosk check-in BOWLER DETAILS screen — the kiosk mirror of the web self
 * check-in form (components/bowling/BowlingCheckin.tsx), restyled to the kiosk
 * canvas idiom of KioskBowlingDetailsStep (k-glass cards, category-first shoe
 * cascade, Yes/No bumpers).
 *
 * Same data rails as the web, deliberately: players load/save through
 * GET/PATCH /api/bowling/v2/reservations/{neonId}/players (Neon-first, then
 * best-effort QAMF setLanePlayers + the $0 shoe-KDS lines + KBF pref
 * write-back — all server-side in that route), and the lane phase comes from
 * GET .../checkin. This screen only edits details; opening the lane stays on
 * the done screen's LaneOpenPanel, phase-gated exactly as before.
 *
 * Web-parity semantics (unit-tested in bowler-details.ts):
 *  - "Bowler N" placeholders render empty and save as null
 *  - a rental size requires a real name; rentals never exceed shoePairsAllowed
 *  - lanes already open (409 / phase running) → details are read-only, check-in
 *    itself still completes
 *  - bowling-only check-ins need ≥1 real bowler name (the web's arm rule);
 *    a racing/attraction combo is never blocked on bowler names
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { IconClock } from "@tabler/icons-react";
import { formatPersonName } from "~/lib/helpers/name-format";
import { useT } from "../i18n";
import { SHOE_SIZES, SHOE_CATEGORIES, OWN_SHOES, categoryOf } from "../shoe-catalog";
import { BrandedLoader } from "../components/BrandedLoader";
import {
  bowlerPatchBody,
  firstBowlerIssue,
  hasAnyBowlerName,
  prefillBowlers,
  rentalCount,
  type ApiPlayerRow,
  type CheckinBowlerRow,
} from "./bowler-details";

/** The slice of a CheckinActivity this screen needs. */
export interface BowlingDetailsActivity {
  neonReservationId: number;
  title: string;
  timeLabel: string;
  totalCount: number;
}

interface ResState {
  loading: boolean;
  /** Players GET failed — the desk can still take details; never block check-in. */
  loadFailed: boolean;
  rows: CheckinBowlerRow[];
  shoePairsAllowed: number;
  /** Lane already Running/Completed (or PATCH said 409) — details locked. */
  laneOpen: boolean;
  laneLabel: string | null;
}

const emptyRes = (): ResState => ({
  loading: true,
  loadFailed: false,
  rows: [],
  shoePairsAllowed: 0,
  laneOpen: false,
  laneLabel: null,
});

export function CheckinBowlingDetails(props: {
  activities: BowlingDetailsActivity[];
  /** Bowling is the whole check-in → the web's "≥1 real name" rule arms the button. */
  requireName: boolean;
  /** Parent's finalize state + error (checkInEveryone / bindMsg). */
  finishing: boolean;
  finishError: string | null;
  /** Called once every editable reservation's details are saved. */
  onFinish: () => Promise<void> | void;
  /** Pauses the idle watcher while a save is in flight. */
  onBusyChange: (busy: boolean) => void;
}) {
  const { activities, requireName, finishing, finishError, onFinish, onBusyChange } = props;
  const t = useT();
  const [byRes, setByRes] = useState<Record<number, ResState>>(() =>
    Object.fromEntries(activities.map((a) => [a.neonReservationId, emptyRes()])),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Which shoe category is expanded per (reservation, slot). Undefined → derive
  // from the stored size, exactly like the booking details step.
  const [openCat, setOpenCat] = useState<Record<string, string>>({});

  const patch = (neonId: number, p: Partial<ResState>) =>
    setByRes((prev) => ({ ...prev, [neonId]: { ...(prev[neonId] ?? emptyRes()), ...p } }));

  // Load players + lane phase per reservation. Ref-guarded against StrictMode.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    for (const a of activities) {
      const neonId = a.neonReservationId;
      void (async () => {
        try {
          const [playersRes, checkinRes] = await Promise.all([
            fetch(`/api/bowling/v2/reservations/${neonId}/players`, { cache: "no-store" }),
            fetch(`/api/bowling/v2/reservations/${neonId}/checkin`, { cache: "no-store" }),
          ]);
          const phase = checkinRes.ok
            ? ((await checkinRes.json()) as { phase?: string; laneLabel?: string })
            : {};
          if (!playersRes.ok) throw new Error("players load failed");
          const data = (await playersRes.json()) as {
            players?: ApiPlayerRow[];
            shoePairsAllowed?: number;
          };
          patch(neonId, {
            loading: false,
            rows: prefillBowlers(data.players ?? []),
            shoePairsAllowed: data.shoePairsAllowed ?? 0,
            laneOpen: phase.phase === "running" || phase.phase === "completed",
            laneLabel: phase.laneLabel || null,
          });
        } catch {
          patch(neonId, { loading: false, loadFailed: true });
        }
      })();
    }
    // activities is stable for the life of this stage (set when the itinerary opened).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateRow = (neonId: number, slot: number, p: Partial<CheckinBowlerRow>) => {
    setSaveError(null);
    setByRes((prev) => {
      const res = prev[neonId];
      if (!res) return prev;
      return {
        ...prev,
        [neonId]: {
          ...res,
          rows: res.rows.map((r) => (r.slot === slot ? { ...r, ...p } : r)),
        },
      };
    });
  };

  const anyLoading = activities.some((a) => byRes[a.neonReservationId]?.loading);
  const editable = activities.filter((a) => {
    const s = byRes[a.neonReservationId];
    return s && !s.loading && !s.loadFailed && !s.laneOpen && s.rows.length > 0;
  });

  // First hard-rule violation across the editable reservations (web parity).
  const issue = useMemo(() => {
    for (const a of editable) {
      const s = byRes[a.neonReservationId];
      const found = firstBowlerIssue(s.rows, s.shoePairsAllowed);
      if (found) return found;
    }
    return null;
  }, [editable, byRes]);

  const anyName = editable.some((a) => hasAnyBowlerName(byRes[a.neonReservationId].rows));
  // The web arms "Open My Lane" on ≥1 real name — but only when bowling IS the
  // check-in AND there is anything editable at all. A combo (racing anchor) or
  // an all-locked/failed load must never dead-end here.
  const needsName = requireName && editable.length > 0 && !anyName;
  const disabled = anyLoading || saving || finishing || issue !== null || needsName;

  const finish = async () => {
    if (disabled) return;
    setSaving(true);
    setSaveError(null);
    onBusyChange(true);
    try {
      for (const a of editable) {
        const neonId = a.neonReservationId;
        const s = byRes[neonId];
        const res = await fetch(`/api/bowling/v2/reservations/${neonId}/players`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bowlerPatchBody(s.rows)),
        });
        if (res.status === 409) {
          // Lanes opened while the guest was typing — nothing left to save
          // here; the check-in itself still completes.
          patch(neonId, { laneOpen: true });
          continue;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setSaveError(data.error || t("checkin.bowl.saveFail"));
          return;
        }
      }
      await onFinish();
    } catch {
      setSaveError(t("checkin.bowl.saveFail"));
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  };

  if (anyLoading) {
    return (
      <div className="flex justify-center py-[48px]">
        <BrandedLoader brand="headpinz" label={t("checkin.bowl.loading")} />
      </div>
    );
  }

  return (
    <div className="space-y-[24px]">
      <p className="text-[26px] text-white/55">{t("checkin.bowl.intro")}</p>

      {activities.map((a) => {
        const s = byRes[a.neonReservationId];
        if (!s) return null;
        const showHeader = activities.length > 1;
        if (s.loadFailed) {
          return (
            <div key={a.neonReservationId} className="k-glass border-[#f0b341]/40 p-[28px]">
              {showHeader && <SectionHeader activity={a} />}
              <p className="text-[26px] text-[#f0b341]">{t("checkin.bowl.loadFail")}</p>
            </div>
          );
        }
        if (s.laneOpen) {
          return (
            <div key={a.neonReservationId} className="k-glass border-[#2dd4ea]/40 p-[28px]">
              {showHeader && <SectionHeader activity={a} />}
              <p className="flex items-center gap-[12px] text-[26px] text-white/70">
                <IconClock size={28} className="shrink-0 text-[#2dd4ea]" aria-hidden="true" />
                {t("checkin.bowl.laneOpenNoEdit", {
                  lane: s.laneLabel ?? a.title,
                })}
              </p>
            </div>
          );
        }
        const used = rentalCount(s.rows);
        return (
          <div key={a.neonReservationId} className="space-y-[20px]">
            {showHeader && <SectionHeader activity={a} />}
            {s.shoePairsAllowed > 0 && (
              <div className="flex justify-end">
                <span className="k-eyebrow text-[#00e2e5] tabular-nums">
                  {t("checkin.bowl.shoeCounter", { used, total: s.shoePairsAllowed })}
                </span>
              </div>
            )}
            {s.rows.map((p) => {
              const catKey = `${a.neonReservationId}:${p.slot}`;
              const hasShoes = s.shoePairsAllowed > 0;
              // Rental categories lock once the allowance is spent elsewhere —
              // the web disables its "Rental Shoes" toggle the same way.
              const allowanceSpent = !p.shoeSize && used >= s.shoePairsAllowed;
              const selCat = openCat[catKey] !== undefined ? openCat[catKey] : categoryOf(p.shoeSize);
              return (
                <div
                  key={p.slot}
                  className="k-glass p-[28px]"
                  style={{
                    borderLeft: `8px solid ${
                      p.name.trim() && p.bumpers !== null ? "#46d68c" : "rgba(255,255,255,0.15)"
                    }`,
                  }}
                >
                  <div className="mb-[16px] flex items-center justify-between">
                    <span className="k-display text-[34px]">
                      {t("bowlingDetails.bowlerN", { num: p.slot })}
                    </span>
                  </div>

                  <label
                    htmlFor={`checkin-bowler-name-${catKey}`}
                    className="mb-[8px] block text-[22px] font-semibold uppercase tracking-widest text-white/40"
                  >
                    {t("bowlingDetails.name")}
                  </label>
                  <input
                    id={`checkin-bowler-name-${catKey}`}
                    type="text"
                    value={p.name}
                    onChange={(e) => updateRow(a.neonReservationId, p.slot, { name: e.target.value })}
                    onBlur={(e) =>
                      updateRow(a.neonReservationId, p.slot, {
                        name: formatPersonName(e.target.value),
                      })
                    }
                    placeholder={t("bowlingDetails.bowlerN", { num: p.slot })}
                    autoComplete="off"
                    className="mb-[20px] w-full rounded-2xl border border-white/15 bg-white/5 px-[24px] py-[18px] text-[30px] text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                  />

                  {hasShoes && (
                    <>
                      <span className="mb-[8px] block text-[22px] font-semibold uppercase tracking-widest text-white/40">
                        {t("bowlingDetails.shoeSize")}
                      </span>
                      <div className="mb-[12px] flex flex-wrap gap-[10px]">
                        <button
                          type="button"
                          onClick={() => {
                            setOpenCat((c) => ({ ...c, [catKey]: OWN_SHOES }));
                            updateRow(a.neonReservationId, p.slot, { shoeSize: null });
                          }}
                          className={`rounded-2xl border-2 px-[28px] py-[16px] text-[24px] font-semibold ${
                            selCat === OWN_SHOES
                              ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                              : "border-white/10 text-white/50"
                          }`}
                        >
                          {t("bowlingDetails.ownShoes")}
                        </button>
                        {SHOE_CATEGORIES.map((cat) => (
                          <button
                            key={cat.value}
                            type="button"
                            disabled={allowanceSpent}
                            onClick={() => {
                              setOpenCat((c) => ({ ...c, [catKey]: cat.value }));
                              if (categoryOf(p.shoeSize) !== cat.value)
                                updateRow(a.neonReservationId, p.slot, { shoeSize: null });
                            }}
                            className={`rounded-2xl border-2 px-[28px] py-[16px] text-[24px] font-semibold disabled:opacity-35 ${
                              selCat === cat.value
                                ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                                : "border-white/10 text-white/50"
                            }`}
                          >
                            {t(cat.labelKey)}
                          </button>
                        ))}
                      </div>
                      {selCat && selCat !== OWN_SHOES && SHOE_SIZES[selCat] && (
                        <div className="mb-[20px] flex flex-wrap gap-[10px]">
                          {SHOE_SIZES[selCat].map((size) => {
                            const value = `${selCat} ${size}`;
                            const blocked = p.shoeSize !== value && allowanceSpent;
                            return (
                              <button
                                key={size}
                                type="button"
                                disabled={blocked}
                                onClick={() =>
                                  updateRow(a.neonReservationId, p.slot, { shoeSize: value })
                                }
                                className={`min-w-[74px] rounded-2xl border-2 px-[18px] py-[16px] text-center text-[24px] font-semibold tabular-nums disabled:opacity-35 ${
                                  p.shoeSize === value
                                    ? "border-[#00E2E5] bg-[#00E2E5]/10 text-white"
                                    : "border-white/10 text-white/50"
                                }`}
                              >
                                {size}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}

                  <div className="flex items-center gap-[20px]">
                    <span className="text-[22px] font-semibold uppercase tracking-widest text-white/40">
                      {t("bowlingDetails.bumpers")}
                    </span>
                    <div className="inline-flex overflow-hidden rounded-2xl border-2 border-white/15">
                      {([true, false] as const).map((v) => (
                        <button
                          key={String(v)}
                          type="button"
                          onClick={() => updateRow(a.neonReservationId, p.slot, { bumpers: v })}
                          className={`px-[36px] py-[14px] text-[26px] font-bold ${
                            p.bumpers === v ? "bg-[#00E2E5] text-[#04252b]" : "text-white/55"
                          }`}
                        >
                          {t(v ? "bowlingDetails.yes" : "bowlingDetails.no")}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      {(issue || saveError || finishError) && (
        <div className="rounded-2xl border-2 border-[#f0b341]/40 bg-[#f0b341]/10 px-[28px] py-[20px] text-[26px] text-[#f0b341]">
          {saveError ||
            finishError ||
            (issue?.kind === "name-needed"
              ? t("checkin.bowl.nameNeeded", { num: issue.slot })
              : t("checkin.bowl.tooManyShoes", { count: issue?.allowed ?? 0 }))}
        </div>
      )}

      <button
        type="button"
        onClick={() => void finish()}
        disabled={disabled}
        className="k-btn-primary k-tap h-[112px] w-full text-[36px] disabled:opacity-40"
      >
        {saving
          ? t("checkin.bowl.saving")
          : finishing
            ? t("checkin.checkingIn")
            : t("checkin.checkEveryone")}
      </button>
      {needsName && (
        <p className="text-center text-[24px] text-white/45">{t("checkin.bowl.needOneName")}</p>
      )}
    </div>
  );
}

function SectionHeader({ activity }: { activity: BowlingDetailsActivity }) {
  return (
    <div className="flex items-baseline justify-between gap-[16px]">
      <span className="k-display text-[32px]">{activity.title}</span>
      <span className="k-display text-[30px] text-[#2dd4ea]">{activity.timeLabel}</span>
    </div>
  );
}
