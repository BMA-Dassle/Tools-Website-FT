"use client";

import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";
import { KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS } from "~/features/booking/service/kbf-pricing";
import { isPerLaneExperience } from "~/features/booking/service/bowling-offer";
import { clarityEvent } from "~/lib/clarity";
import { formatHourLabel } from "./availability-client";
import {
  useBowlingOffers,
  formatBookedTime as formatTime,
  centsToDollars,
  validDurationOptionsFor,
  isNearClosingOnly,
} from "~/features/booking/hooks/useBowlingOffers";

// Bowling wizard accent — owner 2026-07-19: bowling reads BLUE ("red just
// seems negative"); FastTrax red stays on racing only. VIP keeps gold.
const BLUE = "#00E2E5";
const GOLD = "#FFD700";
const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

// VIP suite perks for the upgrade modal (owner 2026-07-19 wording). Core
// amenities apply to every VIP lane; some experiences add their own
// inclusions (shoes, pizza) on top.
const VIP_CORE_PERKS = [
  "Semi-private 8-lane VIP suite",
  "Private bar",
  "Pool table",
  "NeoVerse video wall",
  "HyperBowling + premium glow lighting",
  "Complimentary chips & salsa",
];
const VIP_EXTRA_PERKS: Record<string, string[]> = {
  "fun-4-all-vip": ["Bowling shoes included"],
  "pizza-bowl-vip": ["Large one-topping pizza", "Pitcher of soda", "Shoes for up to 6"],
};

type BowlingLikeItem = BowlingItem | KbfItem;

const BowlingOfferStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
}) => {
  // All data + behavior (experiences fetch, QAMF probe/widen, hold, VIP upsell
  // state) lives in the shared hook — this component is the web skin only.
  const {
    kind,
    experiences,
    visibleExperiences,
    slotsForOffer,
    loading,
    holdBusy,
    reservingAt,
    error,
    widened,
    selectedHour,
    selectedDurationOpt,
    setSelectedDurationOpt,
    vipUpgrade,
    setVipUpgrade,
    acceptVipUpgrade,
    selectSlot,
  } = useBowlingOffers({ item, session, onChange, dispatch });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl uppercase tracking-widest text-white">
          Choose a Package
        </h2>
        <p className="mt-1 text-sm text-white/40">
          {selectedHour === null || widened
            ? "Select your bowling experience"
            : `${formatHourLabel(selectedHour)} · change the time on the previous step`}
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-center text-sm text-red-400">
          {error}
        </div>
      )}

      {widened && selectedHour !== null && (
        <div
          className="rounded-xl px-3 py-2.5 text-center text-sm font-medium"
          style={{ backgroundColor: `${GOLD}14`, color: GOLD }}
        >
          ⚠ Nothing open at {formatHourLabel(selectedHour)}. The earliest available times are below
          — picking one changes your start time.
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div
            className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
            style={{ borderTopColor: BLUE }}
          />
        </div>
      ) : visibleExperiences.length === 0 ? (
        <p className="py-8 text-center text-sm text-white/40">
          No availability this day. Go back and try another date.
        </p>
      ) : (
        <>
          <div className="space-y-4">
            {visibleExperiences.map((exp) => {
              const expSlots = slotsForOffer(exp.qamfWebOfferId);
              const isVip = exp.isVip;
              const accent = isVip ? GOLD : BLUE;
              const videoUrl = isVip
                ? `${BLOB}/videos/headpinz-neoverse-v2.mp4`
                : `${BLOB}/videos/headpinz-bowling.mp4`;

              const primaryItem = exp.items.find((i) => i.sortOrder === 0);
              const priceCents = primaryItem?.priceCents ?? 0;
              const isPerLane = isPerLaneExperience(exp);
              const hasDurationOptions = (exp.durationOptions?.length ?? 0) > 0;

              // Duration buttons filtered to only the options that actually
              // fit (optionsVerified-gated — see validDurationOptionsFor).
              const validDurationOptions = validDurationOptionsFor(exp, expSlots);

              // Fun 4 All near-closing notice: primary option (90min) not available
              const showNearClosingNotice = isNearClosingOnly(exp, expSlots);

              const isSelected = item.experienceId === exp.id;

              return (
                <div
                  key={exp.id}
                  className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]"
                >
                  {/* Video header */}
                  <div className="relative h-32 overflow-hidden">
                    <video
                      src={videoUrl}
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="h-full w-full object-cover opacity-50"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 p-4">
                      <h3
                        className="font-display text-lg uppercase tracking-widest"
                        style={{ color: accent }}
                      >
                        {exp.label}
                      </h3>
                      <p className="mt-0.5 text-xs text-white/50">{exp.description}</p>
                    </div>
                  </div>

                  <div className="p-4">
                    {/* Near-closing notice for Fun 4 All */}
                    {showNearClosingNotice && (
                      <div
                        className="mb-3 rounded-lg px-3 py-2 text-center text-xs font-medium"
                        style={{ backgroundColor: `${GOLD}18`, color: GOLD }}
                      >
                        Only 1 hour available near closing
                      </div>
                    )}

                    {/* Price display. KBF games are free; the VIP lane carries a
                    $2/person upcharge that IS charged at checkout, so surface it
                    here rather than showing "$0.00". */}
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-lg font-bold text-white">
                        {kind === "kbf" && !isVip ? (
                          "Free"
                        ) : kind === "kbf" && isVip ? (
                          <>
                            {centsToDollars(KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS)}
                            <span className="text-xs font-normal text-white/40">
                              {" "}
                              /person · VIP lane
                            </span>
                          </>
                        ) : (
                          <>
                            {centsToDollars(priceCents)}
                            <span className="text-xs font-normal text-white/40">
                              /{isPerLane ? "lane" : "person"}
                            </span>
                          </>
                        )}
                      </span>
                      {isVip && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                          style={{ backgroundColor: `${GOLD}20`, color: GOLD }}
                        >
                          VIP
                        </span>
                      )}
                    </div>

                    {/* Duration options — filtered by QAMF available option IDs */}
                    {validDurationOptions.length > 0 && (
                      <div className="mb-3">
                        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-white/30">
                          Duration
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {validDurationOptions.map((opt) => {
                            const isActive =
                              selectedDurationOpt?.id === opt.id && item.experienceId === exp.id;
                            // Per-duration total = unit (1hr) price × the
                            // duration's multiplier (v1 parity: BowlingWizard
                            // 4951-4952). Without the multiplier, 1.5h and 2h
                            // render the same price.
                            const optPrice = Math.round(
                              (opt.overridePriceCents ?? priceCents) * opt.squareMultiplier,
                            );
                            return (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => setSelectedDurationOpt(isActive ? null : opt)}
                                className="rounded-lg px-3 py-2 text-sm font-medium transition-all"
                                style={{
                                  backgroundColor: isActive ? accent : `${accent}15`,
                                  color: isActive ? "#0a1628" : accent,
                                  fontWeight: isActive ? 800 : 500,
                                  boxShadow: isActive ? `0 0 12px ${accent}60` : undefined,
                                }}
                              >
                                {opt.label}
                                <span className="ml-1.5 text-xs opacity-60">
                                  {centsToDollars(optPrice)}/{isPerLane ? "lane" : "person"}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Time slots */}
                    {hasDurationOptions && !selectedDurationOpt ? (
                      <p className="text-xs text-white/30">
                        Select a duration to see available times
                      </p>
                    ) : expSlots.length === 0 ? (
                      <p className="text-xs text-white/30">No availability at this time</p>
                    ) : expSlots.length === 1 && !isSelected ? (
                      /* Auto-select UX: single slot gets a full-width button */
                      <button
                        type="button"
                        disabled={holdBusy}
                        onClick={() =>
                          void selectSlot(
                            exp,
                            expSlots[0],
                            hasDurationOptions ? selectedDurationOpt : null,
                          )
                        }
                        className="flex w-full items-center justify-center gap-2 rounded-full px-4 py-3 text-sm font-bold uppercase tracking-wider transition-all hover:scale-[1.01] disabled:opacity-60"
                        style={{
                          backgroundColor: `${accent}1a`,
                          color: accent,
                          border: `1px solid ${accent}55`,
                        }}
                      >
                        {reservingAt === expSlots[0].bookedAt ? (
                          <>
                            <span
                              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                              aria-hidden
                            />
                            Reserving…
                          </>
                        ) : (
                          <>Select {formatTime(expSlots[0].bookedAt)}</>
                        )}
                      </button>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {expSlots.map((slot, i) => {
                          const isSlotSelected = isSelected && item.bookedAt === slot.bookedAt;
                          return (
                            <button
                              key={`${slot.webOfferId}-${slot.bookedAt}-${i}`}
                              type="button"
                              disabled={holdBusy}
                              onClick={() =>
                                void selectSlot(
                                  exp,
                                  slot,
                                  hasDurationOptions ? selectedDurationOpt : null,
                                )
                              }
                              className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all disabled:opacity-60"
                              style={{
                                backgroundColor: isSlotSelected ? accent : `${accent}15`,
                                color: isSlotSelected ? "#0a1628" : accent,
                                fontWeight: isSlotSelected ? 800 : 500,
                                boxShadow: isSlotSelected ? `0 0 12px ${accent}60` : undefined,
                              }}
                            >
                              {reservingAt === slot.bookedAt && (
                                <span
                                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                                  aria-hidden
                                />
                              )}
                              {isSlotSelected ? "✓ " : ""}
                              {formatTime(slot.bookedAt)}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* VIP upgrade upsell — shown after a Regular pick (v1 parity) */}
      {vipUpgrade &&
        (() => {
          const regExp = experiences.find((e) => e.id === item.experienceId);
          const regPrice = regExp?.items.find((i) => i.sortOrder === 0)?.priceCents ?? 0;
          const vipPrice = vipUpgrade.exp.items.find((i) => i.sortOrder === 0)?.priceCents ?? 0;
          const delta = vipPrice - regPrice;
          const vipPerLane = isPerLaneExperience(vipUpgrade.exp);
          return (
            <div
              className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
              style={{ backgroundColor: "rgba(0,0,0,0.78)" }}
            >
              <div
                className="w-full max-w-md overflow-hidden rounded-2xl"
                style={{ backgroundColor: "#0d1f3c", border: `2px solid ${GOLD}55` }}
              >
                <div className="relative h-36 overflow-hidden">
                  <video
                    autoPlay
                    muted
                    loop
                    playsInline
                    preload="metadata"
                    className="absolute inset-0 h-full w-full object-cover"
                  >
                    <source src={`${BLOB}/videos/headpinz-neoverse-v2.mp4`} type="video/mp4" />
                  </video>
                  <div
                    className="absolute inset-0"
                    style={{
                      background: "linear-gradient(to bottom, transparent 30%, #0d1f3c 100%)",
                    }}
                  />
                  <span
                    className="absolute bottom-3 left-4 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest"
                    style={{ backgroundColor: GOLD, color: "#0a1628" }}
                  >
                    VIP Upgrade
                  </span>
                </div>

                <div className="p-5">
                  <h3
                    className="mb-1 font-display text-xl uppercase tracking-wider text-white"
                    style={{ textShadow: `0 0 20px ${GOLD}40` }}
                  >
                    Upgrade to VIP?
                  </h3>
                  <p className="mb-4 text-sm text-white/55">{vipUpgrade.exp.description}</p>

                  <ul className="mb-5 space-y-2">
                    {[...VIP_CORE_PERKS, ...(VIP_EXTRA_PERKS[vipUpgrade.exp.slug] ?? [])].map(
                      (perk) => (
                        <li key={perk} className="flex items-center gap-2">
                          <span
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                            style={{ backgroundColor: `${GOLD}25`, color: GOLD }}
                          >
                            ✓
                          </span>
                          <span className="text-sm text-white/75">{perk}</span>
                        </li>
                      ),
                    )}
                  </ul>

                  {delta > 0 && (
                    <div
                      className="mb-5 flex items-center justify-between rounded-xl px-4 py-3"
                      style={{ backgroundColor: `${GOLD}12`, border: `1px solid ${GOLD}30` }}
                    >
                      <span className="text-sm text-white/55">VIP upgrade</span>
                      <span className="font-display text-lg font-bold" style={{ color: GOLD }}>
                        +{centsToDollars(delta)}
                        <span className="text-sm font-normal text-white/40">
                          /{vipPerLane ? "lane" : "person"}
                        </span>
                      </span>
                    </div>
                  )}

                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        clarityEvent("upsell:vip:declined");
                        setVipUpgrade(null);
                      }}
                      className="flex-1 rounded-full border border-white/20 py-3 text-sm font-bold uppercase tracking-wider text-white/60 transition-colors hover:border-white/40 hover:text-white"
                    >
                      No Thanks
                    </button>
                    <button
                      type="button"
                      disabled={holdBusy}
                      onClick={() => void acceptVipUpgrade()}
                      className="flex-1 rounded-full py-3 text-sm font-bold uppercase tracking-wider text-[#0a1628] transition-all hover:scale-[1.02] disabled:opacity-60"
                      style={{ backgroundColor: GOLD, boxShadow: `0 0 18px ${GOLD}40` }}
                    >
                      Upgrade
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
};

const BowlingOfferStep: StepDef<BowlingItem> = {
  id: "bowling-offer",
  title: "Package",
  Component: BowlingOfferStepComponent as StepDef<BowlingItem>["Component"],
  isVisible: () => true,
  canAdvance: (item) =>
    item.webOfferId && item.bookedAt && item.qamfReservationId
      ? true
      : { reason: "Select a time slot" },
};

export default BowlingOfferStep;
