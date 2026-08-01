"use client";

/**
 * v3 bowling EXPERIENCE step — merged Tier + Package + duration screen
 * (single-time-pick flow, 2026-07-19).
 *
 * Replaces the classic BowlingTierStep + the package cards of
 * BowlingOfferStep: one tier-sectioned list (Classic coral / VIP gold —
 * mirrors the July RaceProductStep redesign), each package an ExperienceCard
 * with inline duration chips and an accurate "Next lane at …" hint from ONE
 * shared day scan. Selecting a card/duration writes the offer config only —
 * the TIME is picked exactly once, on the next step, from genuinely bookable
 * slots. All selection happens in click handlers, never effects (React 19
 * strict-mode rule).
 */

import { useMemo, useState } from "react";
import { qamfCenterIdForCode } from "~/features/booking";
import type { BowlingItem, KbfItem, StepDef } from "~/features/booking";
import type {
  BowlingExperienceWithDetails,
  BowlingExperienceDurationOption,
} from "@/lib/bowling-db";
import { KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS } from "~/features/booking/service/kbf-pricing";
import { QAMF_TO_CENTER_CODE } from "~/features/booking/service/bowling-hours";
import {
  isPerLaneExperience,
  releaseBowlingHold,
  slotAllowedForExperience,
} from "~/features/booking/service/bowling-offer";
import {
  useBowlingExperiences,
  useDayAvailability,
} from "~/features/booking/hooks/useBowlingAvailability";
import { IconCheck } from "@tabler/icons-react";
import { ExperienceCard, type DurationChip } from "../../bowling/ExperienceCard";
import { VIP_CORE_PERKS } from "../../bowling/VipUpgradeModal";
import { etMinutesOfDay, type AvailabilitySlot } from "./availability-client";

// Bowling wizard accent — owner 2026-07-19: bowling reads BLUE ("red just
// seems negative"); FastTrax red stays on racing only.
const BLUE = "#00E2E5";
// VIP accent ON THIS STEP: premium violet, not the site-wide gold — owner
// 2026-07-26 ("I don't like the yellow on VIP"). Matches the NeoVerse suite's
// purple glow in the VIP video. Other surfaces (upsell modal, checkout) still
// use gold; revisit globally if this look wins.
const VIP_VIOLET = "#A78BFA";
const BLOB = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com";

// ── Tier switcher (owner mockup 2026-07-26) ─────────────────────────────────
// The stacked Classic/VIP sections become a segmented tier switcher: one tier
// on screen at a time, VIP → Classic → PinBoyz order (owner). Video stays on
// the VIP banner ONLY — Classic and PinBoyz banners are photos.
//
// PINBOYZ SEAM: Old Time Lanes ("PinBoyz", HeadPinz FM, QAMF web offer 176)
// rides slug-prefixed experiences rows seeded IS_ACTIVE=FALSE, returned only
// to v3 surfaces via the ?preview=pinboyz include — the classic flow never
// lists them. Kill switch (no deploy): set the pinboyz-* rows'
// bowling_experience_offers.is_active = false. Cleanup: replace this seam
// with the lane-type enum migration (is_vip boolean → classic|pinboyz|vip).
const PINBOYZ_PREVIEW = true;
// PinBoyz accent stays in the bowling blues (owner 2026-07-26: "I like our
// blues" — copper/rust rejected): a deeper electric blue beside Classic cyan.
const PINBOYZ_BLUE = "#5D8BFF";
const PINBOYZ_CREAM = "#F3E7CF";
// Vintage display face for the PinBoyz tier (owner: "needs to look more
// classic") — everything else keeps the site's font-display.
const PINBOYZ_SERIF = 'Georgia, "Times New Roman", serif';
// public/images/ is gitignored (blob-hosted) — promo/ is the committed spot.
const PINBOYZ_PHOTO = "/promo/pinboyz-old-time-lanes.webp";
// Classic banner photo — same shot the kiosk uses, routed through the
// same-origin image optimizer (raw blob URLs can hit the firewall JS
// challenge; see lesson 2026-07-24).
const CLASSIC_PHOTO = `/_next/image?url=${encodeURIComponent(
  `${BLOB}/images/headpinz/gallery-bowling.webp`,
)}&w=1200&q=75`;

type TierTab = "vip" | "classic" | "pinboyz";

// PinBoyz experiences are keyed by slug prefix until the lane-type enum
// migration lands. MODULE scope on purpose: component consts live in the
// render body's temporal dead zone, and this is called from closures
// (visibleDurations → bookable filter) that run before later consts init.
function isPinboyz(e: BowlingExperienceWithDetails): boolean {
  return e.slug.startsWith("pinboyz-");
}

type BowlingLikeItem = BowlingItem | KbfItem;

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch {
    return iso;
  }
}

const BowlingExperienceStepComponent: StepDef<BowlingLikeItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
}) => {
  // Resolve from the item's stamped center, else the SELECTED session center —
  // never a hardcoded fallback (rule: refuse rather than default to FM).
  const centerId = item.qamfCenterId ?? qamfCenterIdForCode(session.center);
  const centerCode = centerId != null ? (QAMF_TO_CENTER_CODE[centerId] ?? null) : null;
  const kind =
    item.kind === "kbf" ? "kbf" : (item as BowlingItem).variant === "hourly" ? "hourly" : "open";
  const availKind = kind === "kbf" ? "kbf" : "open,hourly";
  const playerCount =
    item.kind === "bowling"
      ? (item as BowlingItem).playerCount
      : (item as KbfItem).bowlers.length + (item as KbfItem).paidAdults;
  const kiosk = !!session.context?.kiosk;
  const variant = kiosk ? ("kiosk" as const) : ("web" as const);

  const expQuery = useBowlingExperiences(centerCode, kind === "kbf");
  const dayAvail = useDayAvailability({
    centerId,
    date: item.date,
    players: Math.max(playerCount, 1),
    kind: availKind,
    leadMinutes: kiosk ? 0 : 15,
  });

  // Day-of-week + kind + world-cup filtering (classic parity).
  const experiences = useMemo(() => {
    const raw = expQuery.data ?? [];
    const dow = item.date ? new Date(`${item.date}T12:00:00`).getDay() : new Date().getDay();
    return raw
      .filter((e) => !e.slug.startsWith("world-cup-"))
      .filter((e) => (kind === "kbf" ? true : e.kind !== "kbf"))
      .filter(
        (e) =>
          !Array.isArray(e.daysOfWeek) || e.daysOfWeek.length === 0 || e.daysOfWeek.includes(dow),
      );
  }, [expQuery.data, item.date, kind]);

  // First accurate slot for an offer, optionally requiring a specific option
  // id to be verified-available at that slot.
  const slotsByOffer = useMemo(() => {
    const m = new Map<number, AvailabilitySlot[]>();
    for (const s of dayAvail.data ?? []) {
      const arr = m.get(s.webOfferId) ?? [];
      arr.push(s);
      m.set(s.webOfferId, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.bookedAt.localeCompare(b.bookedAt));
    return m;
  }, [dayAvail.data]);

  // Hide packages with NOTHING bookable left this day (owner 2026-07-19:
  // "if the entire offer is not available, we should hide it" — e.g. Pizza
  // Bowl late at night). Judged PER EXPERIENCE, not per QAMF offer — Pizza
  // Bowl shares offer 158 with Regular Fri–Sun, so the offer having slots
  // says nothing about Pizza Bowl's fixed 120 minutes still fitting. An
  // experience stays when ANY of its durations has a verified slot. Only
  // once the accurate scan has settled — while loading or on scan failure
  // every card stays (fail-open, hint copy handles the rest).
  const scanSettled = !dayAvail.isLoading && dayAvail.data != null;
  // 1-hour options are a KIOSK-ONLY FALLBACK (owner 2026-07-19: "if 1.5 hours
  // isn't available offer the 1 hour"): the web never shows them, and the
  // kiosk surfaces one only when NO longer duration still has a slot today —
  // late-night walk-ups keep a bookable lane instead of a dead end.
  const isDuckpin = item.kind === "bowling" && (item as BowlingItem).isDuckpin;
  const visibleDurations = (exp: BowlingExperienceWithDetails) => {
    const all = exp.durationOptions ?? [];
    // FastTrax duckpin offers 30/60/90 as first-class durations — the 1-hour
    // "kiosk-only fallback" rule below is HeadPinz-specific (1hr is a fallback
    // under 1.5/2hr there) and must never suppress a duckpin price point.
    // PinBoyz likewise sells 1hr first-class (owner 2026-07-26: offer 176
    // "contains 1 hr, 1.5 hr and 2 hour").
    if (isDuckpin || isPinboyz(exp)) return all;
    return all.filter((o) => {
      if (o.durationMinutes !== 60) return true;
      if (!kiosk || !scanSettled) return false;
      return !all.some((l) => l.durationMinutes > 60 && firstSlotFor(exp, l.qamfOptionId) != null);
    });
  };
  const expHasAnySlot = (exp: BowlingExperienceWithDetails): boolean => {
    if ((exp.durationOptions ?? []).length === 0) {
      return firstSlotFor(exp, exp.qamfOptionId ?? null) != null;
    }
    return visibleDurations(exp).some((o) => firstSlotFor(exp, o.qamfOptionId) != null);
  };
  const bookable = scanSettled ? experiences.filter(expHasAnySlot) : experiences;
  const allSoldOut = scanSettled && experiences.length > 0 && bookable.length === 0;

  // PinBoyz (Old Time Lanes) is its OWN tier (rows are seeded is_active=false
  // and only the preview include returns them). Excluded from Classic
  // explicitly — its is_vip is false like Classic's.
  const pinboyzAll = experiences.filter(isPinboyz);
  const pinboyz = bookable.filter(isPinboyz);
  const regular = bookable.filter((e) => !e.isVip && !isPinboyz(e));
  const vip = bookable.filter((e) => e.isVip);

  // ── Tier switcher state ────────────────────────────────────────────────
  // The guest's explicit tab pick; null until they tap one. The EFFECTIVE tab
  // is derived per render so a tab that vanishes (tier sells out mid-session)
  // falls back gracefully — selection state changes only in click handlers
  // (React 19 strict-mode rule), never in effects.
  const [tierTabPick, setTierTabPick] = useState<TierTab | null>(null);
  // PinBoyz: real cards when the catalog rows exist for this center, else the
  // teaser at Fort Myers only — never on FastTrax duckpin or KBF.
  const FM_CENTER_CODE = "TXBSQN0FEKQ11";
  const showPinboyz =
    PINBOYZ_PREVIEW &&
    !isDuckpin &&
    kind !== "kbf" &&
    (pinboyzAll.length > 0 || centerCode === FM_CENTER_CODE);
  // Owner order 2026-07-26: VIP → Classic → PinBoyz.
  const tierTabs: TierTab[] = [
    ...(vip.length > 0 ? (["vip"] as const) : []),
    ...(regular.length > 0 ? (["classic"] as const) : []),
    ...(showPinboyz ? (["pinboyz"] as const) : []),
  ];
  // VIP is the DEFAULT tab (owner 2026-07-26); a guest's explicit prior pick
  // of a Classic package still brings them back to the Classic tab.
  const fallbackTab: TierTab | null =
    item.tier === "regular" && regular.length > 0
      ? "classic"
      : vip.length > 0
        ? "vip"
        : regular.length > 0
          ? "classic"
          : (tierTabs[0] ?? null);
  const tierTab: TierTab | null =
    tierTabPick && tierTabs.includes(tierTabPick) ? tierTabPick : fallbackTab;

  /** "from $60.00" for a tier's cheapest primary item, or null (KBF is free). */
  const fromLabel = (exps: BowlingExperienceWithDetails[]): string | null => {
    if (kind === "kbf") return null;
    const prices = exps
      .map((e) => e.items.find((i) => i.sortOrder === 0)?.priceCents ?? 0)
      .filter((c) => c > 0);
    if (!prices.length) return null;
    return `from ${centsToDollars(Math.min(...prices))}`;
  };

  function firstSlotFor(exp: BowlingExperienceWithDetails, optionId: number | null): string | null {
    const slots = slotsByOffer.get(exp.qamfWebOfferId) ?? [];
    for (const s of slots) {
      // Experience-scoped slot window (Midnight Madness shares the all-day
      // Fri-Sun offer but sells only 11:45 PM+) — without this the MM card
      // reads "Next lane 8:00 PM" and stays visible all day (2026-08-01
      // incident). Also drives expHasAnySlot, so out-of-window days hide
      // the card entirely.
      if (!slotAllowedForExperience(exp.slug, etMinutesOfDay(s.bookedAt))) continue;
      if (
        optionId != null &&
        s.optionsVerified &&
        s.availableTimeOptionIds?.length &&
        !s.availableTimeOptionIds.includes(optionId)
      ) {
        continue;
      }
      return s.bookedAt;
    }
    return null;
  }

  function selectExperience(
    exp: BowlingExperienceWithDetails,
    durationOpt: BowlingExperienceDurationOption | null,
  ) {
    const changed =
      item.experienceId !== exp.id || (item.durationOptionId ?? null) !== (durationOpt?.id ?? null);
    if (!changed) return;

    // Changing the package/duration invalidates any live hold + picked time.
    if (item.qamfReservationId && centerId != null) {
      void releaseBowlingHold(item.qamfCenterId ?? centerId, item.qamfReservationId);
      dispatch({ type: "clearBowlingHold", itemId: item.id });
    }

    onChange({
      tier: exp.isVip ? "vip" : "regular",
      experienceId: exp.id,
      experienceSlug: exp.slug,
      webOfferId: exp.qamfWebOfferId,
      optionId: durationOpt?.qamfOptionId ?? exp.qamfOptionId ?? null,
      optionType: (exp.qamfOptionType as "Game" | "Time" | "Unlimited" | null) ?? null,
      durationOptionId: durationOpt?.id ?? null,
      durationMinutes: durationOpt?.durationMinutes ?? exp.qamfOfferDurationMinutes ?? null,
      durationMultiplier: durationOpt?.squareMultiplier ?? 1,
      bookedAt: null,
      hour: null,
      minute: null,
      lineItems: [],
    } as Partial<BowlingLikeItem>);
  }

  if (centerId == null || !centerCode) {
    return (
      <p className="py-8 text-center text-sm text-white/40">
        We couldn&apos;t tell which location this is for. Go back and re-select your center.
      </p>
    );
  }

  if (expQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/15"
          style={{ borderTopColor: BLUE }}
        />
      </div>
    );
  }

  function renderCard(exp: BowlingExperienceWithDetails) {
    const isVip = exp.isVip;
    const vintage = isPinboyz(exp);
    const accent = vintage ? PINBOYZ_BLUE : isVip ? VIP_VIOLET : BLUE;
    const primaryItem = exp.items.find((i) => i.sortOrder === 0);
    const priceCents = primaryItem?.priceCents ?? 0;
    const perLane = isPerLaneExperience(exp);
    const selected = item.experienceId === exp.id;

    // KBF games are free; the VIP lane carries a $2/person upcharge that IS
    // charged at checkout, so surface it rather than "$0.00" (classic parity).
    const priceLabel =
      kind === "kbf" && !isVip
        ? "Free"
        : kind === "kbf" && isVip
          ? centsToDollars(KBF_VIP_LANE_UPCHARGE_PER_PERSON_CENTS)
          : centsToDollars(priceCents);
    const perLabel =
      kind === "kbf" && !isVip
        ? ""
        : kind === "kbf" && isVip
          ? " /person · VIP lane"
          : `/${perLane ? "lane" : "person"}`;

    // Per-duration total = unit price × the duration's multiplier (classic
    // parity — without it 1.5h and 2h render the same price). A chip is
    // unavailable when the ACCURATE day scan proves no slot fits it today.
    // visibleDurations applies the kiosk-only 1-hour fallback rule.
    const durations: DurationChip[] = visibleDurations(exp).map((opt) => {
      const optPrice = Math.round((opt.overridePriceCents ?? priceCents) * opt.squareMultiplier);
      const anySlot = firstSlotFor(exp, opt.qamfOptionId);
      return {
        opt,
        priceLabel: `${centsToDollars(optPrice)}/${perLane ? "lane" : "person"}`,
        active: selected && item.durationOptionId === opt.id,
        unavailable: !dayAvail.isLoading && dayAvail.data != null && anySlot == null,
      };
    });

    // Hint anchors on the first AVAILABLE visible duration (not blindly the
    // first row) so a kiosk showing only the 1-hour fallback reads "Next lane
    // 11:00 PM", not "Sold out this day".
    const defaultOptionId =
      durations.find((d) => !d.unavailable)?.opt.qamfOptionId ??
      durations[0]?.opt.qamfOptionId ??
      exp.qamfOptionId ??
      null;
    const first = firstSlotFor(exp, defaultOptionId);
    const hint = dayAvail.isLoading
      ? null
      : dayAvail.data == null
        ? null // hint fetch failed — hide rather than block (fail-open)
        : first
          ? `Next lane ${formatTime(first)}`
          : "Sold out this day";

    return (
      <ExperienceCard
        key={exp.id}
        variant={variant}
        exp={exp}
        accent={accent}
        selected={selected}
        priceLabel={priceLabel}
        perLabel={perLabel}
        durations={durations}
        hint={hint}
        hintLoading={dayAvail.isLoading}
        vintage={vintage}
        onSelect={(durationOpt) => selectExperience(exp, durationOpt)}
      />
    );
  }

  // One media banner per SECTION (owner 2026-07-19: the cards don't all need
  // video — put it under the section instead), with the section title overlaid.
  // Owner 2026-07-26: video is VIP-ONLY — Classic and PinBoyz banners are
  // photos. PinBoyz gets the vintage serif title and NO color overlay on the
  // photo beyond the standard legibility gradient (owner: no blue tint).
  const sectionBanner = (
    label: string,
    meta: string,
    accent: string,
    media: { videoUrl?: string; imageUrl?: string },
    vintage = false,
  ) => (
    <div
      className={`relative overflow-hidden rounded-2xl border border-white/10 ${
        kiosk ? "h-[300px]" : "h-40 sm:h-48"
      }`}
    >
      {media.videoUrl ? (
        <video
          src={media.videoUrl}
          autoPlay
          loop
          muted
          playsInline
          className="h-full w-full object-cover opacity-60"
        />
      ) : (
        // Decorative banner; sized by the container, optimizer URL pre-built.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={media.imageUrl}
          alt=""
          aria-hidden
          className="h-full w-full object-cover opacity-80"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 to-transparent" />
      <div
        className={`absolute inset-x-0 bottom-0 flex items-baseline justify-between gap-3 ${
          kiosk ? "p-[24px]" : "p-4"
        }`}
      >
        <h3
          className={
            vintage
              ? `font-bold uppercase ${kiosk ? "text-[30px]" : "text-lg"}`
              : `font-display uppercase tracking-widest ${kiosk ? "text-[32px]" : "text-lg"}`
          }
          style={
            vintage
              ? { color: accent, fontFamily: PINBOYZ_SERIF, letterSpacing: "0.12em" }
              : { color: accent }
          }
        >
          {label}
        </h3>
        <span className={`text-white/50 ${kiosk ? "text-[22px]" : "text-xs"}`}>{meta}</span>
      </div>
    </div>
  );

  /** Segmented tier switcher — VIP → Classic → PinBoyz (owner order). */
  const tierTabBtn = (tab: TierTab, label: string, sub: string | null, accent: string) => {
    const active = tierTab === tab;
    const vintage = tab === "pinboyz";
    return (
      <button
        key={tab}
        type="button"
        aria-pressed={active}
        onClick={() => setTierTabPick(tab)}
        className={`flex-1 rounded-xl text-center transition-colors ${
          kiosk ? "k-tap px-[10px] py-[16px]" : "px-2 py-2.5"
        }`}
        style={active ? { backgroundColor: accent, color: "#0a1628" } : undefined}
      >
        <span
          className={`block font-bold uppercase ${
            vintage ? "" : "font-display tracking-widest"
          } ${kiosk ? "text-[26px]" : "text-sm"} ${active ? "" : "text-white/60"}`}
          style={vintage ? { fontFamily: PINBOYZ_SERIF, letterSpacing: "0.1em" } : undefined}
        >
          {label}
        </span>
        {sub && (
          <span
            className={`block ${kiosk ? "text-[18px]" : "text-[10px]"} ${
              active ? "opacity-70" : "text-white/35"
            }`}
          >
            {sub}
          </span>
        )}
      </button>
    );
  };

  // VIP explanation (owner 2026-07-19: "VIP needs some explanation") — the
  // suite's amenities, shared with the upsell modal so the story stays one.
  const vipPerks = (
    <div
      className={`flex flex-wrap ${kiosk ? "gap-x-[28px] gap-y-[14px]" : "gap-x-5 gap-y-2"}`}
      aria-label="VIP suite amenities"
    >
      {VIP_CORE_PERKS.map((perk) => (
        <span
          key={perk}
          className={`flex items-center gap-1.5 text-white/70 ${kiosk ? "text-[24px]" : "text-xs"}`}
        >
          <span
            className={`flex shrink-0 items-center justify-center rounded-full ${
              kiosk ? "h-[26px] w-[26px]" : "h-4 w-4"
            }`}
            style={{ backgroundColor: `${VIP_VIOLET}25`, color: VIP_VIOLET }}
          >
            <IconCheck size={kiosk ? 18 : 11} stroke={3} aria-hidden />
          </span>
          {perk}
        </span>
      ))}
    </div>
  );

  // PinBoyz teaser perks — placeholder copy until the owner defines the
  // offering (preview branch only).
  const pinboyzPerks = (
    <div
      className={`flex flex-wrap ${kiosk ? "gap-x-[28px] gap-y-[14px]" : "gap-x-5 gap-y-2"}`}
      aria-label="PinBoyz lane features"
    >
      {["Restored vintage wood lanes", "Retro scoring", "Old-time alley atmosphere"].map((perk) => (
        <span
          key={perk}
          className={`flex items-center gap-1.5 text-white/70 ${kiosk ? "text-[24px]" : "text-xs"}`}
        >
          <span
            className={`flex shrink-0 items-center justify-center rounded-full ${
              kiosk ? "h-[26px] w-[26px]" : "h-4 w-4"
            }`}
            style={{ backgroundColor: `${PINBOYZ_BLUE}25`, color: PINBOYZ_BLUE }}
          >
            <IconCheck size={kiosk ? 18 : 11} stroke={3} aria-hidden />
          </span>
          {perk}
        </span>
      ))}
    </div>
  );

  return (
    <div className={`mx-auto ${kiosk ? "max-w-none space-y-5" : "max-w-2xl space-y-5"}`}>
      {/* No step title here — the flow shell already says EXPERIENCE (owner
          2026-07-26: it read as "Experience twice" and ate banner space). */}
      <p className={`text-center text-white/40 ${kiosk ? "text-[24px]" : "text-sm"}`}>
        Pick a package — you&apos;ll choose from real open lane times next
      </p>

      {experiences.length === 0 ? (
        <p className="py-8 text-center text-sm text-white/40">
          No bowling packages on this day. Go back and try another date.
        </p>
      ) : allSoldOut ? (
        <p className={`py-8 text-center text-white/40 ${kiosk ? "text-[26px]" : "text-sm"}`}>
          {kiosk
            ? "No lanes left to book tonight — the front desk can help with walk-in availability."
            : "No lanes left online for this day. Go back and try another date."}
        </p>
      ) : (
        <>
          {tierTabs.length > 1 && (
            <div
              className={`flex rounded-2xl bg-white/[0.05] ${kiosk ? "gap-[10px] p-[10px]" : "gap-1.5 p-1.5"}`}
              role="group"
              aria-label="Lane type"
            >
              {tierTabs.map((tab) =>
                tab === "vip"
                  ? tierTabBtn("vip", "VIP", fromLabel(vip), VIP_VIOLET)
                  : tab === "classic"
                    ? tierTabBtn("classic", "Classic", fromLabel(regular), BLUE)
                    : tierTabBtn(
                        "pinboyz",
                        "PinBoyz",
                        pinboyzAll.length > 0 ? fromLabel(pinboyzAll) : "coming soon",
                        PINBOYZ_BLUE,
                      ),
              )}
            </div>
          )}

          {tierTab === "vip" && vip.length > 0 && (
            <section className="space-y-4">
              {sectionBanner("VIP Suites", "The upgraded way to bowl", VIP_VIOLET, {
                videoUrl: `${BLOB}/videos/headpinz-neoverse-v2.mp4`,
              })}
              {vipPerks}
              <div className="space-y-4">{vip.map(renderCard)}</div>
            </section>
          )}

          {tierTab === "classic" && regular.length > 0 && (
            <section className="space-y-4">
              {sectionBanner("Classic Lanes", "Classic HeadPinz bowling", BLUE, {
                imageUrl: CLASSIC_PHOTO,
              })}
              <div className="space-y-4">{regular.map(renderCard)}</div>
            </section>
          )}

          {tierTab === "pinboyz" && showPinboyz && (
            <section className="space-y-4">
              {sectionBanner(
                "PinBoyz — Old Time Lanes",
                "Bowling the way it started",
                PINBOYZ_CREAM,
                { imageUrl: PINBOYZ_PHOTO },
                true,
              )}
              {pinboyzPerks}
              {pinboyz.length > 0 ? (
                // Real bookable PinBoyz packages — QAMF web offer 176.
                <div className="space-y-4">{pinboyz.map(renderCard)}</div>
              ) : pinboyzAll.length > 0 ? (
                // Catalog exists but nothing bookable today.
                <p
                  className={`py-6 text-center text-white/40 ${kiosk ? "text-[26px]" : "text-sm"}`}
                >
                  No Old Time Lanes left to book this day.
                </p>
              ) : (
                // Non-bookable teaser — catalog rows not seeded at this center.
                <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
                  <div className={kiosk ? "p-[24px]" : "p-4"}>
                    <h3
                      className={`font-bold uppercase ${kiosk ? "text-[34px]" : "text-lg"}`}
                      style={{
                        color: PINBOYZ_CREAM,
                        fontFamily: PINBOYZ_SERIF,
                        letterSpacing: "0.1em",
                      }}
                    >
                      PinBoyz Lanes
                    </h3>
                    <p className={`mt-0.5 text-white/50 ${kiosk ? "text-[22px]" : "text-xs"}`}>
                      Reserve an old-time lane by the hour — bowling the way it used to be.
                    </p>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span
                        className={`font-bold text-white ${kiosk ? "text-[26px]" : "text-base"}`}
                      >
                        Pricing coming soon
                      </span>
                      <span
                        className={`font-semibold ${kiosk ? "text-[22px]" : "text-[11px]"}`}
                        style={{ color: PINBOYZ_BLUE }}
                      >
                        Opening soon · HeadPinz Fort Myers
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
};

const BowlingExperienceStep: StepDef<BowlingItem> = {
  id: "bowling-experience",
  title: "Experience",
  Component: BowlingExperienceStepComponent as StepDef<BowlingItem>["Component"],
  isVisible: () => true,
  canAdvance: (item) => {
    if (item.webOfferId == null || item.experienceId == null) {
      return { reason: "Pick a package" };
    }
    return true;
  },
};

export default BowlingExperienceStep;
