"use client";

/**
 * Kiosk "Choose a Package" — the CLASSIC bowling offer step, kiosk-native
 * (Podium glass at 1080-canvas px). Replaces the reused web BowlingOfferStep
 * + its `zoom: 1.3` shim in the kiosk registry. The v3 single-time-pick flow
 * has its own kiosk-variant steps and is untouched — this step rides the same
 * classicOnly gate as the other kiosk classic bowling steps.
 *
 * Layout blend (owner-approved mockup 2026-07-20):
 *  - ONE package for the picked tier (the common case — tier was chosen on the
 *    previous step) → "configurator": photo hero confirming the pick, then
 *    the big decisions — how long, what time, reserve — with a running
 *    lane-math total.
 *  - TWO OR MORE packages (e.g. hourly lanes vs Pizza Bowl Party) → stacked
 *    full-bleed photo cards; tapping a card expands its config tray in place
 *    (cyan ring + ✓ badge, same idiom as the tier step).
 *
 * The web VIP upsell MODAL is replaced by an always-visible gold strip that
 * switches item.tier to "vip" (the hook re-probes; the guest reserves the VIP
 * package normally). Reserve auto-advances via requestAdvance once the hold
 * lands (owner pattern: pick, pick, done — no extra Continue tap). All
 * data/behavior — experiences fetch, QAMF accurate probe + widen, duration
 * validation, line items, hold + superseded-hold release — comes from the
 * shared useBowlingOffers hook, so pricing/reserve logic is byte-identical
 * to the web step.
 */

import { useState } from "react";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";
import type {
  BowlingExperienceWithDetails,
  BowlingExperienceDurationOption,
} from "@/lib/bowling-db";
import { KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS } from "~/features/booking/service/kbf-pricing";
import { isPerLaneExperience } from "~/features/booking/service/bowling-offer";
import {
  useBowlingOffers,
  formatBookedTime,
  centsToDollars,
  validDurationOptionsFor,
  isNearClosingOnly,
} from "~/features/booking/hooks/useBowlingOffers";
import { formatHourLabel } from "~/components/features/booking/steps/bowling/availability-client";
import { KIOSK_PHOTOS } from "../assets";
import { useResilientImages } from "../hooks/useResilientImage";
import { BrandedLoader } from "../components/BrandedLoader";

type BowlingLikeItem = BowlingItem | KbfItem;

// Bowling reads BLUE on the kiosk too (owner 2026-07-19, matches the tier
// step); VIP keeps the kiosk gold (NOT the web's #FFD700).
const BLUE = "#00E2E5";
const VIP_GOLD = "#e8b14c";
const WARN = "#f0b341";

function accentFor(exp: BowlingExperienceWithDetails): string {
  return exp.isVip ? VIP_GOLD : BLUE;
}

function photoFor(exp: BowlingExperienceWithDetails, kind: string): string {
  if (kind === "kbf") return KIOSK_PHOTOS.kbf;
  return exp.isVip ? KIOSK_PHOTOS.vipLanes : KIOSK_PHOTOS.bowl;
}

/** Package total in cents for the current party, or null when free (KBF). */
function totalCentsFor(
  exp: BowlingExperienceWithDetails,
  durationOpt: BowlingExperienceDurationOption | null,
  kind: string,
  laneCount: number,
  playerCount: number,
): number | null {
  if (kind === "kbf") {
    return exp.isVip ? KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS * playerCount : null;
  }
  const primary = exp.items.find((i) => i.sortOrder === 0);
  const baseCents = primary?.priceCents ?? 0;
  const unitCents = durationOpt
    ? Math.round((durationOpt.overridePriceCents ?? baseCents) * durationOpt.squareMultiplier)
    : baseCents;
  return unitCents * (isPerLaneExperience(exp) ? laneCount : playerCount);
}

/** "/lane per hour" · "/lane" · "/person" — matches the tier step's phrasing. */
function unitSuffix(exp: BowlingExperienceWithDetails): string {
  if (!isPerLaneExperience(exp)) return "/person";
  return exp.kind === "hourly" ? "/lane per hour" : "/lane";
}

const KioskBowlingOfferStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
  setBusy,
  requestAdvance,
}) => {
  const {
    kind,
    playerCount,
    laneCount,
    selectedHour,
    experiences,
    visibleExperiences,
    slotsForOffer,
    loading,
    holdBusy,
    reservingAt,
    error,
    widened,
    selectedDurationOpt,
    setSelectedDurationOpt,
    selectSlot,
  } = useBowlingOffers({ item, session, onChange, dispatch, offerVipUpsell: false });

  // Which card's config tray is open (multi-package layout). Falls back to the
  // already-reserved experience, then the first visible package.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // The time chip the guest tapped but hasn't reserved yet (per expanded card).
  const [pendingBookedAt, setPendingBookedAt] = useState<string | null>(null);

  // Self-heal the hero photos if a flaky-WiFi fetch fails (they're CSS
  // background-images, which never retry on their own). `hero` is a render
  // closure inside a .map, so it can't call a hook itself — resolve the whole
  // set up here (before any early return) and look each URL up below.
  const resolvePhoto = useResilientImages(visibleExperiences.map((e) => photoFor(e, kind)));

  if (loading) {
    return (
      <div className="flex justify-center py-[48px]">
        <BrandedLoader brand="headpinz" size={160} label="Checking lane availability…" />
      </div>
    );
  }

  const solo = visibleExperiences.length === 1;
  const activeId =
    expandedId ??
    item.experienceId ??
    (visibleExperiences.length ? visibleExperiences[0].id : null);

  const openCard = (exp: BowlingExperienceWithDetails) => {
    if (exp.id === activeId) return;
    setExpandedId(exp.id);
    setPendingBookedAt(null);
    setSelectedDurationOpt(null);
  };

  /** Hold the slot; on success advance through the host's full handleNext
   *  (owner pattern: the Reserve tap IS the confirmation — no extra Continue).
   *  setBusy guards the flow's own Next against a mid-flight hold; it's back
   *  to false BEFORE requestAdvance fires, so the advance isn't swallowed. */
  const reserve = async (
    exp: BowlingExperienceWithDetails,
    slot: Parameters<typeof selectSlot>[1],
    durationOpt: BowlingExperienceDurationOption | null,
  ) => {
    setBusy?.(true);
    let ok = false;
    try {
      ok = await selectSlot(exp, slot, durationOpt);
    } finally {
      setBusy?.(false);
    }
    if (ok) requestAdvance?.();
  };

  // VIP cross-sell strip (replaces the web upsell modal): visible while the
  // guest is on the Regular tier and a VIP counterpart exists at this center.
  const vipExp = experiences.find((e) => e.isVip);
  const showVipStrip = item.tier === "regular" && !!vipExp;
  const regPrimary = experiences
    .find((e) => !e.isVip && e.kind === "hourly")
    ?.items.find((i) => i.sortOrder === 0)?.priceCents;
  const vipPrimary = vipExp?.items.find((i) => i.sortOrder === 0)?.priceCents;
  const vipDeltaCents =
    kind === "kbf"
      ? KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS
      : regPrimary != null && vipPrimary != null && vipPrimary > regPrimary
        ? vipPrimary - regPrimary
        : null;

  const switchToVip = () => {
    setExpandedId(null);
    setPendingBookedAt(null);
    setSelectedDurationOpt(null);
    onChange({ tier: "vip" } as Partial<BowlingLikeItem>);
  };

  /** Duration + start-time + reserve tray — shared by both layouts. */
  const configTray = (exp: BowlingExperienceWithDetails) => {
    const expSlots = slotsForOffer(exp.qamfWebOfferId);
    const allDurations = exp.durationOptions ?? [];
    const validDurations = validDurationOptionsFor(exp, expSlots);
    const validIds = new Set(validDurations.map((d) => d.id));
    const hasDurations = allDurations.length > 0;
    const durationSel =
      hasDurations && selectedDurationOpt && validIds.has(selectedDurationOpt.id)
        ? selectedDurationOpt
        : null;

    const reservedHere =
      item.experienceId === exp.id && !!item.qamfReservationId && !!item.bookedAt;
    // Chip preselection is render-derived (no effect — strict-mode safe):
    // pending tap wins, then the reserved time, then the only/first slot.
    const chosenBookedAt =
      pendingBookedAt && expSlots.some((s) => s.bookedAt === pendingBookedAt)
        ? pendingBookedAt
        : reservedHere && expSlots.some((s) => s.bookedAt === item.bookedAt)
          ? item.bookedAt!
          : (expSlots[0]?.bookedAt ?? null);
    const chosenSlot = expSlots.find((s) => s.bookedAt === chosenBookedAt) ?? null;
    const isReservedAsChosen =
      reservedHere && chosenBookedAt === item.bookedAt && (!hasDurations || durationSel != null);

    const totalCents = totalCentsFor(exp, durationSel, kind, laneCount, playerCount);
    const needsDuration = hasDurations && !durationSel;
    const ctaDisabled = holdBusy || !chosenSlot || needsDuration;

    return (
      <div className="space-y-[36px] bg-[#071027] px-[40px] pb-[40px] pt-[32px]">
        {isNearClosingOnly(exp, expSlots) && (
          <div className="rounded-[14px] border border-[#f0b341]/40 bg-[#f0b341]/10 px-[24px] py-[16px] text-[24px] text-[#f0b341]">
            Only 1 hour available this close to closing.
          </div>
        )}

        {hasDurations && (
          <div>
            <div className="k-eyebrow mb-[16px]">How long?</div>
            <div className="flex flex-wrap gap-[18px]">
              {allDurations.map((opt) => {
                const valid = validIds.has(opt.id);
                const active = durationSel?.id === opt.id;
                const optUnitCents = Math.round(
                  (opt.overridePriceCents ??
                    exp.items.find((i) => i.sortOrder === 0)?.priceCents ??
                    0) * opt.squareMultiplier,
                );
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={!valid}
                    onClick={() => setSelectedDurationOpt(active ? null : opt)}
                    className={`k-tap min-w-[220px] flex-1 rounded-[18px] border-2 px-[20px] py-[22px] text-center ${
                      valid ? "" : "cursor-not-allowed"
                    }`}
                    style={
                      valid
                        ? {
                            borderColor: active ? BLUE : "rgba(255,255,255,0.16)",
                            background: active ? "rgba(0,226,229,0.10)" : "rgba(255,255,255,0.02)",
                            boxShadow: active ? "0 0 30px rgba(0,226,229,0.28)" : undefined,
                          }
                        : {
                            borderStyle: "dashed",
                            borderColor: "rgba(240,179,65,0.5)",
                            background: "transparent",
                            opacity: 0.7,
                          }
                    }
                  >
                    <div className="k-display text-[38px] leading-none">{opt.label}</div>
                    <div
                      className="mt-[10px] text-[23px] tabular-nums"
                      style={{
                        color: valid
                          ? active
                            ? "rgba(0,226,229,0.9)"
                            : "rgba(245,236,238,0.58)"
                          : WARN,
                      }}
                    >
                      {valid
                        ? `${centsToDollars(optUnitCents)}${isPerLaneExperience(exp) ? "/lane" : "/person"}`
                        : "Past closing"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <div className="k-eyebrow mb-[16px]">Start time</div>
          {expSlots.length === 0 ? (
            <div className="text-[26px] text-white/50">
              No lanes open at this time — go back and pick another time.
            </div>
          ) : (
            <div className="flex flex-wrap gap-[18px]">
              {expSlots.map((slot) => (
                <button
                  key={`${slot.webOfferId}-${slot.bookedAt}`}
                  type="button"
                  disabled={holdBusy}
                  onClick={() => setPendingBookedAt(slot.bookedAt)}
                  className={`k-chip k-tap min-w-[210px] ${
                    chosenBookedAt === slot.bookedAt ? "sel" : ""
                  }`}
                >
                  {formatBookedTime(slot.bookedAt)}
                </button>
              ))}
            </div>
          )}
          {needsDuration && expSlots.length > 0 && (
            <p className="mt-[14px] text-[23px] text-white/40">Pick a duration first.</p>
          )}
        </div>

        {(totalCents ?? 0) > 0 && (
          <div className="flex items-baseline justify-between px-[8px] text-[26px] text-white/55">
            <span>
              {isPerLaneExperience(exp)
                ? `${laneCount} lane${laneCount === 1 ? "" : "s"}`
                : `${playerCount} bowler${playerCount === 1 ? "" : "s"}`}
              {durationSel ? ` · ${durationSel.label}` : ""}
              {exp.isVip ? " · VIP" : ""}
            </span>
            <span className="text-[32px] font-extrabold tabular-nums text-white">
              {centsToDollars(totalCents!)}
            </span>
          </div>
        )}

        <button
          type="button"
          disabled={ctaDisabled || isReservedAsChosen}
          onClick={() => {
            if (!chosenSlot) return;
            void reserve(exp, chosenSlot, hasDurations ? durationSel : null);
          }}
          className="k-btn-primary k-tap w-full"
          style={
            isReservedAsChosen
              ? { background: "#46d68c", color: "#04252b", opacity: 1, boxShadow: "none" }
              : undefined
          }
        >
          {reservingAt != null
            ? "Holding your lanes…"
            : isReservedAsChosen
              ? `✓ Reserved for ${formatBookedTime(item.bookedAt!)}`
              : chosenSlot
                ? `Reserve ${formatBookedTime(chosenSlot.bookedAt)}`
                : "No times available"}
        </button>
        {isReservedAsChosen && (
          <p className="text-center text-[24px] text-white/50">
            Lanes held — hit Continue below to keep going.
          </p>
        )}
      </div>
    );
  };

  /** Full-bleed photo hero — big card header (both layouts). */
  const hero = (exp: BowlingExperienceWithDetails, tall: boolean) => {
    const accent = accentFor(exp);
    const expSlots = slotsForOffer(exp.qamfWebOfferId);
    const primary = exp.items.find((i) => i.sortOrder === 0);
    return (
      <div
        className={`k-ph relative flex ${tall ? "h-[360px]" : "h-[260px]"} flex-col justify-end`}
        style={{ ["--k-img"]: `url(${resolvePhoto(photoFor(exp, kind))})` } as React.CSSProperties}
      >
        <div className="relative z-[1] flex items-end justify-between gap-[24px] p-[36px]">
          <div className="min-w-0">
            {exp.isVip && (
              <div className="k-eyebrow mb-[8px]" style={{ color: accent }}>
                VIP
              </div>
            )}
            <div className="k-display break-words text-[48px] leading-none">{exp.label}</div>
            {exp.description && (
              <div className="mt-[10px] break-words text-[24px] leading-snug text-white/65">
                {exp.description}
              </div>
            )}
            {expSlots.length > 0 && !widened && (
              <div className="k-avail mt-[14px]">
                <span className="dot" />
                Open at {formatBookedTime(expSlots[0].bookedAt)}
              </div>
            )}
          </div>
          <div className="shrink-0 text-right">
            {kind === "kbf" && !exp.isVip ? (
              <div className="text-[40px] font-extrabold">Free</div>
            ) : kind === "kbf" && exp.isVip ? (
              <div className="text-[36px] font-extrabold tabular-nums">
                {centsToDollars(KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS)}
                <span className="block text-[22px] font-semibold text-white/55">
                  /person · VIP lane
                </span>
              </div>
            ) : (
              <div className="text-[40px] font-extrabold tabular-nums">
                {centsToDollars(primary?.priceCents ?? 0)}
                <span className="block text-[22px] font-semibold text-white/55">
                  {unitSuffix(exp)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-[28px]">
      <p className="text-[26px] text-white/55">
        {widened && selectedHour !== null
          ? `Nothing open at ${formatHourLabel(selectedHour)} — the next open times are below.`
          : selectedHour !== null
            ? `Around ${formatHourLabel(selectedHour)} · ${playerCount} bowler${
                playerCount === 1 ? "" : "s"
              } on ${laneCount} lane${laneCount === 1 ? "" : "s"}.`
            : "Set up your lanes."}
      </p>

      {error && (
        <div className="rounded-[18px] border border-red-500/40 bg-red-500/10 px-[28px] py-[20px] text-[26px] text-red-400">
          {error}
        </div>
      )}

      {widened && selectedHour !== null && (
        <div className="rounded-[18px] border border-[#f0b341]/40 bg-[#f0b341]/10 px-[28px] py-[20px] text-[26px] text-[#f0b341]">
          Your picked time just filled up. Choosing one of the times below changes your start time.
        </div>
      )}

      {/* VIP first — owner 2026-07-20: the upgrade offer always sits ON TOP,
          above the package cards, never buried below the fold. */}
      {showVipStrip && (
        <button
          type="button"
          onClick={switchToVip}
          className="k-tap flex w-full items-center justify-between gap-[24px] rounded-[28px] border-2 px-[40px] py-[28px] text-left"
          style={{
            borderColor: "rgba(232,177,76,0.45)",
            background: "linear-gradient(135deg, rgba(232,177,76,0.10), rgba(134,82,255,0.08))",
          }}
        >
          <div className="min-w-0">
            <div className="k-display text-[34px]" style={{ color: VIP_GOLD }}>
              Make it VIP
            </div>
            <div className="mt-[6px] text-[23px] text-white/55">
              {kind === "kbf"
                ? `HyperBowling glow lanes · +${centsToDollars(KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS)}/person`
                : vipDeltaCents != null
                  ? `Private suite seating, lounge service · +${centsToDollars(vipDeltaCents)} /lane per hour`
                  : "Private suite seating, lounge service to your lane"}
            </div>
          </div>
          <div
            className="k-display shrink-0 rounded-full border-2 px-[30px] py-[16px] text-[26px]"
            style={{ color: VIP_GOLD, borderColor: "rgba(232,177,76,0.55)" }}
          >
            See VIP ›
          </div>
        </button>
      )}

      {visibleExperiences.length === 0 ? (
        <div className="k-glass p-[36px] text-center text-[28px] text-white/55">
          No lanes open around this time today — go back and pick another time, or the front desk
          can help with walk-ins.
        </div>
      ) : solo ? (
        // ── Configurator: one package for this tier — hero + big decisions ──
        <div className="overflow-hidden rounded-[28px] border-2 border-white/10">
          {hero(visibleExperiences[0], true)}
          {configTray(visibleExperiences[0])}
          <div
            className="h-[8px] w-full"
            style={{ background: accentFor(visibleExperiences[0]) }}
          />
        </div>
      ) : (
        // ── Podium cards: several packages — tap a card to open its tray ──
        <div className="space-y-[28px]">
          {visibleExperiences.map((exp) => {
            const open = exp.id === activeId;
            return (
              <div
                key={exp.id}
                className="relative overflow-hidden rounded-[28px] border-2"
                style={{
                  borderColor: open ? BLUE : "rgba(255,255,255,0.12)",
                  boxShadow: open ? "0 0 44px rgba(0,226,229,0.22)" : "none",
                }}
              >
                {open && (
                  <div className="absolute right-[24px] top-[24px] z-[2] grid h-[56px] w-[56px] place-items-center rounded-full bg-[#00e2e5] text-[32px] font-bold text-[#04252b]">
                    ✓
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => openCard(exp)}
                  aria-expanded={open}
                  aria-label={exp.label}
                  className="k-tap block w-full text-left"
                >
                  {hero(exp, open)}
                </button>
                {open && configTray(exp)}
                <div className="h-[8px] w-full" style={{ background: accentFor(exp) }} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const KioskBowlingOfferStep: StepDef<BowlingLikeItem> = {
  id: "bowling-offer", // keep the web id: downstream steps + cursors align
  title: "Package",
  Component: KioskBowlingOfferStepComponent,
  isVisible: () => true,
  canAdvance: (item) =>
    item.webOfferId && item.bookedAt && item.qamfReservationId
      ? true
      : { reason: "Reserve a lane time" },
};
