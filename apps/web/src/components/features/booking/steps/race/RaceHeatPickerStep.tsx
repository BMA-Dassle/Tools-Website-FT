"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PartyMember, RaceHeatAssignment, RaceItem, StepDef } from "~/features/booking";
import {
  bookingKeys,
  packageIdForCategory,
  BOOKED_HEATS_POLL_MS,
  RACE_AVAILABILITY_POLL_MS,
} from "~/features/booking";
import {
  bmiAdapter,
  type BmiAvailabilityResponse,
  type BmiBlock,
  type BmiProposal,
} from "~/features/booking/data";
import {
  getRaceProductById,
  type RaceProduct,
  type RaceTier,
} from "~/features/booking/service/race-products";
import {
  collidesWithOtherCategory,
  crossCategoryCollisionMessage,
  EXISTING_RESERVATION_CONFLICT_TOOLTIP,
  findHeatConflict,
  HEAT_CONFLICT_TOOLTIP,
  heatsConflict,
} from "~/features/booking/service/conflict";
import { evaluateRaceRestrictions } from "~/features/booking/service/race-restriction-rules";
import { businessDayYmdET } from "@/lib/race-business-day";
import { releaseHeatBmiLines } from "~/features/booking/service/checkout";
import { useCrossTierBlocks } from "./useCrossTierBlocks";
import { holdPickedHeats } from "~/features/booking/service/race";
import { RacerSelectorModal } from "./RacerSelectorModal";
import {
  getGroupEventForDate,
  getRaceBlockWindowsForDate,
  getPublicReopenMinutes,
  raceWindowAppliesToTrack,
} from "@/lib/group-events";
import { getPackage } from "~/features/booking/service/packages";
import { packageComponentsCovered } from "~/features/booking/service/package-picks";
import { PackageHeatPicker } from "./PackageHeatPicker";
import { useEagerHeatHold } from "./useEagerHeatHold";
import { TRACK_BADGE, TRACK_CARD, DISABLED_CARD, TrackInfoBanner } from "./track-visuals";
import KartingCheckInBanner from "./KartingCheckInBanner";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { useT } from "~/features/kiosk/i18n";
import type { OnTimeSnapshot } from "~/features/racing/on-time";
import { raceByAtMs } from "~/features/racing/on-time-display";

/**
 * Race step — pick heats for ONE category (adult or junior).
 *
 * v1 parity: strict port of `apps/web/app/book/race/components/HeatPicker.tsx`.
 * Identical visual: uniform `border-white/10 bg-white/5` cards, cyan ring on
 * selection, opacity 40 on disabled. Start time + arrow + stop time + heat
 * name + status line + capacity bar — same as v1.
 *
 * v2 architectural divergences (forced, cannot mirror v1 literally):
 *   - Per-category split into `RaceHeatPickerStepAdult` / `Junior` (v2 wizard
 *     runs ONE StepDef at a time; v1's bookingCategory cycling is a single
 *     component switching internally)
 *   - No inline "Continue" CTA pane — v2's BookingFlow owns Next at the wizard
 *     footer. v1's CTA pane is a duplicate primary action.
 *   - Click-to-toggle (multi-heat 3-Pack aware) replaces v1's confirm-then-
 *     advance flow. Picked heats are visible from the cyan ring on each card.
 *   - Per-racer assignment via RacerSelectorModal when ANY returning racer is
 *     in the category — `item.heats` carries one entry per (block × racer)
 *     so BMI bookHeat (commit 10) lands one bill line per racer with the
 *     right `bmiPersonId`.
 *
 * Lead time: heats starting too close to "now" are filtered out so the racer
 * has time to check in before their heat (v1 HeatPicker:159-166 +
 * page.tsx:2280-2288). Web: new racers only (NEW_RACER_LEAD_MINUTES). Kiosk:
 * every party — see the KIOSK_*_LEAD_MINUTES constants below.
 * Private event guard: full-screen "Private Event" block when the date is a
 * buyout (v1 HeatPicker:211-237).
 */

// Minimum minutes between "now" and a heat start the grid will show.
// Web = 40, new racers only: the racer still has to get to the building and
// check in (returning racers with waivers see everything). Kiosk applies to
// EVERYONE (owner 2026-07-19: "15 minutes for starters and 10 minutes for all
// others") — the party is already IN the building at the device, so starters
// (new racers) only need the license + kart briefing buffer and returning
// racers just need to reach the grid.
const NEW_RACER_LEAD_MINUTES = 40;
const KIOSK_NEW_RACER_LEAD_MINUTES = 15;
const KIOSK_RETURNING_LEAD_MINUTES = 10;

// Single-race products have no fixed raceCount and NO per-racer heat cap
// (owner 2026-07-02: racers may book as many heats as they like) — the
// heat-conflict spacing check is the only limit on how picks stack up.

type Category = "adult" | "junior";
type Track = "Red" | "Blue" | "Mega";
type TrackOrNull = Track | null;

interface FetchPlanItem {
  productId: string;
  pageId: string;
  track: TrackOrNull;
}

interface TrackedProposal {
  proposal: BmiProposal;
  block: BmiBlock;
  productId: string;
  track: TrackOrNull;
  /** Set when a restriction rule disables (but doesn't hide) this slot — e.g.
   *  the Mega opening-heats express-lane rule. Drives the disabled card label. */
  restriction?: { cardLabel?: string; reason?: string };
}

/** Pick identity = product + start time, so heats stay uniquely keyed even as a
 *  racer accumulates picks across products/tracks via "Add another race". */
const heatKey = (productId: string, heatId: string): string => `${productId}|${heatId}`;

function buildFetchPlan(product: RaceProduct): FetchPlanItem[] {
  if (product.trackProducts) {
    return Object.entries(product.trackProducts).map(([track, info]) => ({
      productId: info.productId,
      pageId: info.pageId,
      track: track as Track,
    }));
  }
  return [
    {
      productId: product.productId,
      pageId: product.pageId,
      track: (product.track as TrackOrNull) ?? null,
    },
  ];
}

function parseLocal(iso: string): Date {
  return new Date(iso.replace(/Z$/, ""));
}

function formatTime(iso: string): string {
  return parseLocal(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** Same clock format from epoch ms — the "racing by" estimate is arithmetic on a
 *  slot, so it never has an ISO string to start from. */
function formatMs(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function spotsLabel(free: number, capacity: number): { text: string; label: string } {
  if (free === 0) return { text: "text-red-400", label: "Full" };
  if (free / capacity <= 0.3) {
    return {
      text: "text-amber-400",
      label: `${free} spot${free === 1 ? "" : "s"} left`,
    };
  }
  return { text: "text-emerald-400", label: `${free} of ${capacity} open` };
}

function racersOfCategory(party: PartyMember[], category: Category): PartyMember[] {
  return party.filter((m) => (m.category ?? "adult") === category);
}

function productIdForCategory(item: RaceItem, category: Category): string | null {
  return category === "adult" ? item.productIdAdult : item.productIdJunior;
}

function heatsForCategory(item: RaceItem, productIds: Set<string>): RaceHeatAssignment[] {
  return item.heats.filter((h) => h.productId && productIds.has(h.productId));
}

/** The OTHER category's held (track, start) slots across every race item in
 *  the session — the cross-category collision signal (owner 2026-07-19:
 *  adults and juniors can't share one physical session). Includes booked
 *  (bmiLineId) heats — the kiosk books each leg eagerly on advance. */
function otherCategoryHeats(
  items: Array<{ kind: string; heats?: RaceHeatAssignment[] }>,
  category: Category,
): Array<{ heatId: string | null; track: TrackOrNull }> {
  return items
    .filter((i) => i.kind === "race" && Array.isArray(i.heats))
    .flatMap((i) => i.heats!)
    .filter((h) => h.heatId && (h.category ?? "adult") !== category)
    .map((h) => ({ heatId: h.heatId, track: h.track }));
}

function entriesForPick(
  block: BmiBlock,
  productId: string,
  track: TrackOrNull,
  racersForLine: PartyMember[],
  tier?: RaceTier,
  category?: Category,
): RaceHeatAssignment[] {
  return racersForLine.map((r) => ({
    productId,
    track,
    // $0 build-key parts (category:tier:track) so combo per-track component ids
    // — which aren't top-level RACE_PRODUCTS entries — still resolve a $0 pair.
    tier,
    category,
    heatId: block.start,
    bmiLineId: null,
    assignedTo: r.id,
  }));
}

/**
 * KIOSK-ONLY karting-check-in treatment, shared down to the cards.
 *
 * Owner 2026-08-17: "do only kiosk for now because web would get confusing on
 * when they check in upstairs or karting. Label check in here as Karting Check
 * In."
 *
 * That is the right call and the reason is structural: at heat-pick time we do
 * not yet know whether the party will be Express Lane. A standard web guest must
 * be at GUEST SERVICES on the 2nd floor half an hour earlier, so stamping
 * "Karting Check In" on a web card would send them to the wrong floor. On a kiosk
 * the guest is already standing in the building, at the karting end of it, and
 * the karting desk is the only check-in the screen can mean.
 *
 * WHY A CONTEXT RATHER THAN A PROP THREADED DOWN: the estimate needs the live
 * on-time snapshot, and a hook per card would mount twenty pollers on a
 * twenty-heat grid. The kiosk variant calls `useTrackStatus` ONCE and publishes
 * it here; the web variant never mounts the provider, so the web booking flow
 * gains no polling at all and its cards read the inert default.
 */
interface KartingCheckInCtx {
  enabled: boolean;
  onTime: OnTimeSnapshot | null;
}
const KartingCheckInContext = createContext<KartingCheckInCtx>({
  enabled: false,
  onTime: null,
});

/** Mounted by the kiosk variant only. One poll for the whole grid. */
function KartingCheckInProvider({ children }: { children: React.ReactNode }) {
  const status = useTrackStatus();
  const value = useMemo<KartingCheckInCtx>(
    () => ({ enabled: true, onTime: status?.onTime ?? null }),
    [status?.onTime],
  );
  return <KartingCheckInContext.Provider value={value}>{children}</KartingCheckInContext.Provider>;
}

function makeHeatPickerComponent(
  category: Category,
  /** Kiosk only — see KartingCheckInContext above. */
  kartingCheckIn = false,
): StepDef<RaceItem>["Component"] {
  const Component: StepDef<RaceItem>["Component"] = ({
    item,
    session,
    onChange,
    dispatch,
    setBusy,
    requestAdvance,
  }) => {
    const allRacers = session.party;
    const racers = racersOfCategory(allRacers, category);
    const productId = productIdForCategory(item, category);

    // Package flow: when a package is selected instead of an individual
    // product, delegate to PackageHeatPicker. The picker owns its own heat
    // writes + eager BMI holds (tap = held, single-race parity — owner
    // 2026-07-19) and derives its picks from item.heats, so it ALWAYS renders
    // live: no Confirm hand-off, no "Heats Selected" interstitial, and
    // back-nav lands on the grid with picks intact.
    const pkgId = productId ? null : packageIdForCategory(item, category);
    const pkg = useMemo(() => getPackage(pkgId), [pkgId]);

    // Express-lane eligibility — computed ABOVE the package early-return so
    // the package grid gets the same opening-heats signal as the single-race
    // grid. Feeds evaluateRaceRestrictions (expressEligible) + the new-racer
    // lead cutoff below.
    const anyNewInCategory = racers.some((r) => r.isNewRacer);
    const allReturningHaveWaivers =
      !anyNewInCategory &&
      session.party.filter((m) => !m.isNewRacer).every((m) => m.waiverValid === true);
    if (pkg && pkg.races.length > 0 && item.date) {
      return (
        <PackageHeatPicker
          pkg={pkg}
          date={item.date}
          racers={racers}
          mixedParty={hasCategory(session, "adult") && hasCategory(session, "junior")}
          category={pkg.category !== "any" ? pkg.category : category}
          expressEligible={allReturningHaveWaivers}
          kiosk={!!session.context?.kiosk}
          // Kiosk lead cutoff (same policy as the single-race grid): hide heats
          // starting within 15 min when a starter is in the party, 10 min
          // otherwise. Web packages keep their existing no-cutoff behavior.
          leadCutoffMs={
            session.context?.kiosk
              ? Date.now() +
                (anyNewInCategory ? KIOSK_NEW_RACER_LEAD_MINUTES : KIOSK_RETURNING_LEAD_MINUTES) *
                  60_000
              : 0
          }
          crossCategoryHeats={otherCategoryHeats(session.items, category)}
          item={item}
          session={session}
          onChange={onChange}
          dispatch={dispatch}
          setBusy={setBusy}
          requestAdvance={requestAdvance}
        />
      );
    }

    return (
      <SingleRaceHeatPicker
        item={item}
        session={session}
        onChange={onChange}
        dispatch={dispatch}
        setBusy={setBusy}
      />
    );
  };

  // Single-race (non-package) grid. Lives in its own component so ALL of its
  // hooks run unconditionally — the package branches in the guard above return
  // before any of them, which was a hooks-after-conditional-return violation.
  // Behavior is identical: this renders only when the guard falls through to
  // the single-race path.
  const SingleRaceHeatPicker: StepDef<RaceItem>["Component"] = ({
    item,
    session,
    onChange,
    dispatch,
    setBusy,
  }) => {
    const t = useT();
    // Inert on web — the provider is only mounted by the kiosk variant, so the
    // web booking flow gains no polling and its cards render exactly as before.
    const { enabled: kartingEnabled, onTime: kartingOnTime } = useContext(KartingCheckInContext);
    const racers = racersOfCategory(session.party, category);
    const partySize = racers.length;
    const productId = productIdForCategory(item, category);
    const product = useMemo(() => getRaceProductById(productId), [productId]);

    // Eager hold: heats are reserved with BMI the moment they're picked (single
    // racer) or confirmed (multi), not when the customer leaves the grid — so a
    // busy-day spot isn't lost while they linger. Machinery shared with the
    // package grid via useEagerHeatHold (serialization, optimistic write +
    // revert-on-failure, per-card "Holding…" key, wizard-Next busy wiring).
    const { holding, holdingKey, holdError, setHoldError, holdingRef, holdHeats } =
      useEagerHeatHold({ item, session, onChange, dispatch, setBusy });

    // Express-lane signal — mirrors the guard's computation (the package grid
    // there shares it) so the single-race grid applies the same new-racer lead
    // cutoff + evaluateRaceRestrictions expressEligible.
    const anyNewInCategory = racers.some((r) => r.isNewRacer);
    const allReturningHaveWaivers =
      !anyNewInCategory &&
      session.party.filter((m) => !m.isNewRacer).every((m) => m.waiverValid === true);

    // Combo packs require exactly raceCount heats. Single races (no raceCount)
    // are UNCAPPED — the conflict logic below (back-to-back / too-close picks)
    // is the only limit.
    const heatsMax = product?.raceCount ?? Infinity;

    // Locked-track filter: when ProductStep TrackPickerModal set
    // productTrackAdult/Junior, only fetch that track. Mirrors v1's
    // post-modal-pick behavior where HeatPicker receives a single
    // ClassifiedProduct already narrowed to the chosen track.
    const lockedTrack = category === "adult" ? item.productTrackAdult : item.productTrackJunior;
    const fetchPlan = useMemo(() => {
      if (!product) return [];
      const full = buildFetchPlan(product);
      if (lockedTrack && full.some((f) => f.track === lockedTrack)) {
        return full.filter((f) => f.track === lockedTrack);
      }
      return full;
    }, [product, lockedTrack]);

    // True when the grid spans more than one track (a combined Red+Blue single
    // race): each heat card then shows a track pill so the customer can tell them
    // apart, mirroring the Ultimate combo's per-heat track badge.
    const showTrackBadge = useMemo(
      () => new Set(fetchPlan.map((f) => f.track)).size > 1,
      [fetchPlan],
    );
    // Distinct tracks on the grid, for the track-info banner (Ultimate parity).
    const gridTracks = useMemo(
      () =>
        [...new Set(fetchPlan.map((f) => f.track))].filter(
          (t): t is Track => t === "Red" || t === "Blue" || t === "Mega",
        ),
      [fetchPlan],
    );
    // Track filter driven by tapping a TrackInfoBanner card. Only honored while
    // that track is actually on the grid — "Add another race" can swap the
    // product under us, and a stale filter must not blank the new grid.
    const [trackFilter, setTrackFilter] = useState<Track | null>(null);
    const activeTrackFilter = trackFilter && gridTracks.includes(trackFilter) ? trackFilter : null;

    const queries = useQueries({
      queries: fetchPlan.map(({ productId: pid, pageId }) => ({
        queryKey: bookingKeys.bmi.availability({
          center: session.center ?? "fort-myers",
          date: item.date ?? "",
          productId: pid,
        }),
        queryFn: (): Promise<BmiAvailabilityResponse> =>
          bmiAdapter.getAvailability({
            date: item.date!,
            productId: pid,
            pageId,
            quantity: partySize > 0 ? partySize : 1,
          }),
        enabled: !!item.date && fetchPlan.length > 0 && partySize > 0,
        staleTime: 60_000,
        // Semi-live grid: other guests' bookings surface without navigating
        // (spot counts drop, filled heats grey) — owner 2026-07-19.
        refetchInterval: RACE_AVAILABILITY_POLL_MS,
        refetchIntervalInBackground: false,
      })),
    });

    // Cross-tier occupancy fan-out (shared hook — see useCrossTierBlocks). An
    // occupied heat is tier-exclusive in BMI availability, so the rules that
    // see past the candidate's own tier (junior back-to-back + two-per-hour,
    // the adult-Starter room reserve) need the union of EVERY single-race
    // product's availability on the grid's track(s). Adult Starter grids skip
    // the fan-out — no cross-tier rule guards them. Shares query keys with
    // `queries`, so React Query dedupes the candidate product's own fetch.
    const crossTierTracks = useMemo<Track[]>(() => {
      if (!product) return [];
      if (product.tier === "starter" && category === "adult") return [];
      return [...new Set(buildFetchPlan(product).map((f) => f.track))].filter(
        (t): t is Track => !!t,
      );
      // `category` is a closure constant (makeHeatPickerComponent), not a dep.
    }, [product]);
    const crossTierBlocks = useCrossTierBlocks({
      tracks: crossTierTracks,
      schedule: product?.schedule ?? "weekday",
      racerType: product?.racerType ?? "existing",
      date: item.date ?? null,
      center: session.center ?? "fort-myers",
      quantity: partySize > 0 ? partySize : 1,
    });

    const returningRacers = useMemo(() => racers.filter((r) => !!r.bmiPersonId), [racers]);
    const hasReturning = returningRacers.length > 0;

    const [pendingHeat, setPendingHeat] = useState<TrackedProposal | null>(null);

    const categoryProductIds = useMemo(
      () => new Set(fetchPlan.map((f) => f.productId)),
      [fetchPlan],
    );
    const categoryHeats = useMemo(
      () => heatsForCategory(item, categoryProductIds),
      [item.heats, categoryProductIds],
    );
    const pickedBlocks = useMemo(() => {
      const seen = new Set<string>();
      const out: Array<{ heatId: string; track: TrackOrNull; productId: string }> = [];
      for (const h of categoryHeats) {
        if (!h.heatId || !h.productId) continue;
        const k = heatKey(h.productId, h.heatId);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ heatId: h.heatId, track: h.track as TrackOrNull, productId: h.productId });
      }
      return out;
    }, [categoryHeats]);
    const pickedSet = new Set(pickedBlocks.map((p) => heatKey(p.productId, p.heatId)));
    const atCap = pickedBlocks.length >= heatsMax;

    // Heats these racers ALREADY hold in other reservations on this date —
    // the cross-reservation spacing signal (matched by bmiPersonId). Greys the
    // same slots the server-side reserve guard would reject, so the dodge of
    // booking each heat in a separate reservation dies in the picker instead
    // of erroring at payment. Fail-open: no personIds / fetch error → empty.
    const racerPersonIds = useMemo(
      () =>
        [...new Set(racers.map((r) => r.bmiPersonId).filter((id): id is string => !!id))].sort(),
      [racers],
    );
    const bookedHeatsQuery = useQuery({
      queryKey: [
        "race-booked-heats",
        item.date ?? "",
        racerPersonIds.join(","),
        session.bmiBillId ?? "",
      ],
      queryFn: async (): Promise<{ heats: Array<{ heatId: string; track: string | null }> }> => {
        const params = new URLSearchParams({
          date: item.date!,
          personIds: racerPersonIds.join(","),
        });
        if (session.bmiBillId) params.set("excludeBillId", session.bmiBillId);
        const res = await fetch(`/api/booking/v2/booked-heats?${params.toString()}`);
        if (!res.ok) return { heats: [] };
        return res.json();
      },
      enabled: !!item.date && racerPersonIds.length > 0,
      staleTime: 60_000,
      // Semi-live: a heat the party books in ANOTHER reservation greys here
      // without a remount (cheap Neon read — gentler cadence than the grid).
      refetchInterval: BOOKED_HEATS_POLL_MS,
      refetchIntervalInBackground: false,
    });

    // Gap enforcement spans ALL of this category's heats — every product/track the
    // racer has added across the "Add another race" loop, not just the current
    // screen — so they can't end up booked back-to-back across tracks/products.
    // Kept SEPARATE from the racers' already-booked heats (other reservations,
    // above) so the card copy can say which one is blocking: "picked heat" vs
    // "existing reservation" (owner feedback 2026-07-02).
    const categoryRacerIds = new Set(racers.map((r) => r.id));
    const cartConflictBlocks = item.heats
      .filter((h) => h.heatId && h.assignedTo && categoryRacerIds.has(h.assignedTo))
      .map((h) => ({ heatId: h.heatId as string, track: h.track as TrackOrNull }));
    // Cross-category same-slot: the OTHER category's held sessions anywhere in
    // the cart (adults on the junior grid and vice versa) — exact (track,
    // start) match only, NOT the spacing rules (different racers still never
    // "conflict"; they just can't share one physical session).
    const crossCategoryBlocks = otherCategoryHeats(session.items, category);
    const existingConflictBlocks = (bookedHeatsQuery.data?.heats ?? []).map((h) => ({
      heatId: h.heatId,
      track: (h.track as TrackOrNull) ?? null,
    }));

    // (anyNewInCategory / allReturningHaveWaivers are computed above the
    // package early-return so the package grid shares the signal.)
    const kiosk = !!session.context?.kiosk;
    const leadMinutes = kiosk
      ? anyNewInCategory
        ? KIOSK_NEW_RACER_LEAD_MINUTES
        : KIOSK_RETURNING_LEAD_MINUTES
      : allReturningHaveWaivers
        ? 0
        : NEW_RACER_LEAD_MINUTES;
    const leadCutoffMs = anyNewInCategory || kiosk ? Date.now() + leadMinutes * 60_000 : 0;

    const allProposals = useMemo<TrackedProposal[]>(() => {
      const list: TrackedProposal[] = [];
      const nowMs = Date.now();
      queries.forEach((q, qi) => {
        const fp = fetchPlan[qi];
        if (!fp || !q.data?.proposals) return;
        // Restriction config keys off tier + track (e.g. Mega Pro). The blocks
        // for THIS query share the product, so they're the occupancy signal the
        // back-to-back rule reads (a neighbor with freeSpots < capacity = an
        // active same-tier session — see race-restriction-rules.ts).
        const tier = getRaceProductById(fp.productId)?.tier;
        const restrictionBlocks = q.data.proposals
          .map((p) => p.blocks?.[0]?.block)
          .filter((b): b is BmiBlock => !!b)
          .map((b) => ({
            startMs: parseLocal(b.start).getTime(),
            freeSpots: b.freeSpots,
            capacity: b.capacity,
          }));
        for (const p of q.data.proposals) {
          const block = p.blocks?.[0]?.block;
          if (!block) continue;
          if (leadCutoffMs > 0 && parseLocal(block.start).getTime() < leadCutoffMs) continue;
          // Apply restriction rules: "hide" drops the slot (back-to-back Mega
          // Pro / Junior, two-Junior-per-hour Mega); "disable" keeps it but greys
          // it out with a label (Mega opening-heats express-lane only).
          const verdict = evaluateRaceRestrictions({
            tier,
            category,
            track: fp.track,
            candidateStartMs: parseLocal(block.start).getTime(),
            candidateStartLocal: block.start,
            nowMs,
            productBlocks: restrictionBlocks,
            // A track with a failed union member passes undefined so the
            // union-fed rules no-op (fail-open pre-filter; the server guard
            // stays authoritative) instead of false-blocking on partial data.
            categoryTrackBlocks:
              category === "junior" && !crossTierBlocks.failedTracks.has(fp.track ?? "")
                ? crossTierBlocks.juniorByTrack.get(fp.track ?? "")
                : undefined,
            trackAllTierBlocks: crossTierBlocks.failedTracks.has(fp.track ?? "")
              ? undefined
              : crossTierBlocks.allByTrack.get(fp.track ?? ""),
            expressEligible: allReturningHaveWaivers,
            // Presentation-only: kiosk hides rules that carry a kioskPresentation
            // (VIP anchor holds) instead of greying them.
            kiosk: !!session.context?.kiosk,
          });
          if (verdict.blocked && verdict.action === "hide") continue;
          list.push({
            proposal: p,
            block,
            productId: fp.productId,
            track: fp.track,
            restriction: verdict.blocked
              ? { cardLabel: verdict.cardLabel, reason: verdict.reason }
              : undefined,
          });
        }
      });
      list.sort(
        (a, b) => parseLocal(a.block.start).getTime() - parseLocal(b.block.start).getTime(),
      );
      return list;
    }, [
      queries,
      fetchPlan,
      leadCutoffMs,
      allReturningHaveWaivers,
      crossTierBlocks,
      session.context?.kiosk,
    ]);

    // TEST KIOSK ONLY (kiosk 99, context.kioskTest): when TODAY's grid is
    // exhausted — availability settled and zero bookable proposals (all heats
    // past/full/lead-filtered) — roll the item ONE day forward so after-close
    // testing has a real grid (owner 2026-08-10: "kiosk 99 should show the
    // race grid for the next day… only when we run out of races today").
    // One roll per mount (ref): a closed tomorrow must show its own empty
    // state, never loop-scan the calendar. Guests never see this — real
    // kiosks have no kioskTest flag.
    const testRolledRef = useRef(false);
    const kioskTestRig = !!session.context?.kioskTest;
    // "Rolled" for DISPLAY derives from the date itself (not the per-mount
    // ref) so the staff banners survive a back-and-repick remount.
    const testShowingFutureDay = kioskTestRig && !!item.date && item.date > businessDayYmdET();
    const availabilitySettled =
      queries.length > 0 && queries.every((q) => q.isSuccess || q.isError);
    useEffect(() => {
      if (!kioskTestRig || testRolledRef.current) return;
      if (!item.date || !product) return;
      // Only ever roll off TODAY (operating day). The per-mount ref alone
      // isn't enough: re-picking a product remounts this step, and an empty
      // grid on the already-rolled date would walk another day forward.
      if (item.date > businessDayYmdET()) return;
      if (!availabilitySettled || allProposals.length > 0) return;
      testRolledRef.current = true;
      const next = new Date(item.date + "T12:00:00");
      next.setDate(next.getDate() + 1);
      onChange({ date: next.toISOString().slice(0, 10) });
    }, [kioskTestRig, availabilitySettled, allProposals.length, item.date, product, onChange]);

    // Display-only track filter (picked heats, conflicts, and caps still span
    // the full grid — hiding a track never releases or unpicks anything).
    const visibleProposals = activeTrackFilter
      ? allProposals.filter((tp) => tp.track === activeTrackFilter)
      : allProposals;

    const handleClickBlock = async (tp: TrackedProposal) => {
      if (holdingRef.current) return;
      const blockId = tp.block.start;
      if (pickedSet.has(heatKey(tp.productId, blockId))) {
        // Deselect: drop this block's heats from the cart. Any already booked on a
        // prior advance carry a bmiLineId — release those BMI lines too, or they
        // orphan on the shared bill: short the Square charge by one heat yet still
        // get confirmed at checkout ("shows both heats, charges one"). Cart is the
        // charge's source of truth, so drop first, then best-effort release.
        const removed = item.heats.filter(
          (h) => h.heatId === blockId && h.productId === tp.productId,
        );
        onChange({
          heats: item.heats.filter((h) => !(h.heatId === blockId && h.productId === tp.productId)),
        });
        if (removed.some((h) => h.bmiLineId)) {
          await releaseHeatBmiLines(session, removed);
        }
        return;
      }
      if (atCap) return;
      if (hasReturning) {
        setPendingHeat(tp);
        return;
      }
      const newEntries = entriesForPick(
        tp.block,
        tp.productId,
        tp.track,
        racers,
        product?.tier,
        category,
      );
      await holdHeats([...item.heats, ...newEntries], heatKey(tp.productId, tp.block.start));
    };

    const handleRacerSelectorConfirm = (selected: PartyMember[]) => {
      if (!pendingHeat) return;
      // Book exactly who the customer selected. The modal shows every category
      // racer (returning + new) with per-racer tier qualification and crosses
      // out anyone below the product tier, so an unqualified racer can never be
      // in `selected` — no separate new-racer auto-add here.
      const newEntries = entriesForPick(
        pendingHeat.block,
        pendingHeat.productId,
        pendingHeat.track,
        selected,
        product?.tier,
        category,
      );
      const holdKey = heatKey(pendingHeat.productId, pendingHeat.block.start);
      setPendingHeat(null);
      void holdHeats([...item.heats, ...newEntries], holdKey);
    };

    // Early returns
    if (!item.date) {
      return (
        <div className="bg-amber-500/8 rounded-xl border border-amber-500/30 p-4 text-sm text-amber-300">
          Pick a date first.
        </div>
      );
    }
    if (partySize === 0) {
      return (
        <div className="bg-amber-500/8 rounded-xl border border-amber-500/30 p-4 text-sm text-amber-300">
          No {category} racers in this party.
        </div>
      );
    }
    if (!product) {
      // No current product. If the racer already added races (the "Add another"
      // loop, which clears the product), show what they have + let them add more
      // or continue (the wizard Next is enabled via canAdvanceFor). Otherwise this
      // is the first visit — prompt to pick a race.
      const catRacerIds = new Set(racers.map((r) => r.id));
      const addedCount = item.heats.filter(
        (h) => h.heatId && h.assignedTo && catRacerIds.has(h.assignedTo),
      ).length;
      if (addedCount === 0) {
        return (
          <div className="bg-amber-500/8 rounded-xl border border-amber-500/30 p-4 text-sm text-amber-300">
            Pick a {category} race first.
          </div>
        );
      }
      return (
        <div className="space-y-5 text-center">
          <div>
            <h2 className="font-display mb-1 text-2xl tracking-widest text-white uppercase">
              {addedCount} {category} {addedCount === 1 ? "race" : "races"} added
            </h2>
            <p className="text-sm text-white/50">
              Add another race or track, or hit Continue below to move on.
            </p>
          </div>
          <button
            type="button"
            onClick={() => dispatch({ type: "back" })}
            className="mx-auto block rounded-xl border border-[#00E2E5]/40 bg-[#00E2E5]/5 px-5 py-2.5 text-sm font-semibold text-[#00E2E5] transition-colors hover:bg-[#00E2E5]/10"
          >
            + Add another race or track
          </button>
        </div>
      );
    }

    // Morning-only buyout: public booking reopens midday (e.g. 2:30 PM). The date
    // stays bookable and the heats before the reopen time are disabled below —
    // so skip the full-day "Private Event" guard on these dates.
    const reopenMins = getPublicReopenMinutes(item.date);

    // Private event guard — v1 HeatPicker:211-237
    const groupEventBlock = reopenMins == null ? getGroupEventForDate(item.date) : null;
    if (groupEventBlock) {
      const displayDate = new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
      });
      return (
        <div className="space-y-6">
          <div className="text-center">
            <h2 className="font-display mb-1 text-2xl tracking-widest text-white uppercase">
              Private Event
            </h2>
            <p className="text-sm text-white/50">{displayDate}</p>
          </div>
          <div className="bg-amber-500/8 mx-auto max-w-sm space-y-3 rounded-xl border border-amber-500/30 p-6 text-center">
            <p className="text-sm font-semibold text-amber-300">
              This date is reserved for a private event and is not available for public booking.
            </p>
            <p className="text-xs text-white/40">Please choose a different date.</p>
          </div>
        </div>
      );
    }

    // Event-window reservations (e.g. FastTrax 4:30–5:30) — heats overlapping a
    // reserved window are disabled for the public. Empty on dates with no such
    // event. (Full-day buyouts are handled by the groupEventBlock guard above.)
    const blockWindows = getRaceBlockWindowsForDate(item.date);

    const isLoading = queries.some((q) => q.isLoading);
    const hasError = queries.some((q) => q.isError);
    const displayDate = new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });

    return (
      <div className="space-y-6">
        {/* Header — v1 HeatPicker:241-248 */}
        <div className="text-center">
          <h2 className="font-display mb-1 text-2xl tracking-widest text-white uppercase">
            {heatsMax > 1 ? "Pick Your Heats" : "Pick a Heat"}
          </h2>
          <p className="text-sm text-white/50">
            <span className="text-white/80">{product.name}</span> · {displayDate}
          </p>
        </div>

        {/* KIOSK ONLY — the strip above the grid was empty, and this is the first
            place a guest ever sees one of these times. Owner 2026-08-17: "in all
            that empty space at the top I think we need to utilize it better."
            Not on web: see the note on KartingCheckInContext. */}
        {kartingEnabled && (
          <KartingCheckInBanner tracks={gridTracks.map((tr) => tr.toLowerCase())} />
        )}

        {/* Racer count summary — v1 HeatPicker:251-258 */}
        <div className="bg-white/3 mx-auto max-w-sm rounded-xl border border-white/8 p-3 text-center">
          <p className="text-xs text-white/50">
            Booking for{" "}
            <span className="font-semibold text-white">
              {partySize} racer{partySize !== 1 ? "s" : ""}
            </span>
          </p>
          {!product.raceCount && (
            <p className="mt-1 text-xs text-[#00E2E5]/70">
              Pick one or more heats — we&apos;ll keep them spaced out.
            </p>
          )}
        </div>

        {/* Track-info banner — shown when the grid spans both tracks (combined
            single race), so the customer knows each track's character before
            picking. Same banner the Ultimate combo grid uses. Tapping a card
            filters the grid to that track; tapping again shows all. */}
        {showTrackBadge && gridTracks.length > 1 && (
          <TrackInfoBanner
            tracks={gridTracks}
            activeTrack={activeTrackFilter}
            onTrackClick={(t) => setTrackFilter((cur) => (cur === t ? null : t))}
          />
        )}

        {/* Test-rig marker (staff-only device, English by design): the grid
            rolled to the next day because today's races were done. */}
        {testShowingFutureDay && (
          <div className="mx-auto max-w-sm rounded-xl border border-amber-500/30 bg-amber-500/5 p-2 text-center text-xs text-amber-300">
            Test kiosk: today&apos;s races are done — showing{" "}
            {new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
            .
          </div>
        )}

        {/* Eager-hold error (the in-progress "Holding…" state shows ON the card). */}
        {holdError && !holding && (
          <div className="mx-auto max-w-sm rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-center text-xs text-red-300">
            {holdError}
          </div>
        )}

        {isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        ) : hasError ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-center">
            <p className="text-sm text-red-300">Couldn&apos;t load time slots.</p>
            <button
              type="button"
              onClick={() => queries.forEach((q) => q.refetch())}
              className="mt-2 rounded-lg border border-white/15 px-4 py-1.5 text-xs font-semibold text-white/70 transition-colors hover:border-white/30 hover:text-white"
            >
              Retry
            </button>
          </div>
        ) : allProposals.length === 0 ? (
          testShowingFutureDay ? (
            // Test rig rolled to tomorrow but THIS product has no heats there
            // (schedule differs — e.g. a Red/Blue race on a Mega night, owner
            // 2026-08-10). The date is right; the product needs re-picking
            // against tomorrow's schedule. Staff-only device, English by design.
            <div className="mx-auto max-w-md space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-center text-sm text-amber-300">
              <p>
                Test kiosk:{" "}
                {new Date(item.date + "T12:00:00").toLocaleDateString("en-US", {
                  weekday: "long",
                })}{" "}
                runs a different race schedule — this race has no heats that day.
              </p>
              <button
                type="button"
                onClick={() => dispatch({ type: "back" })}
                className="mx-auto block rounded-xl border border-amber-400/40 px-5 py-2.5 text-sm font-semibold text-amber-300 transition-colors hover:bg-amber-400/10"
              >
                ← Pick a race that runs that day
              </button>
            </div>
          ) : (
            <div className="bg-white/3 rounded-xl border border-white/10 p-4 text-center text-sm text-white/50">
              No heats available for this date.
            </div>
          )
        ) : visibleProposals.length === 0 ? (
          <div className="bg-white/3 rounded-xl border border-white/10 p-4 text-center text-sm text-white/50">
            No {activeTrackFilter} Track heats for this date — tap the track above to show all.
          </div>
        ) : (
          // Heat grid — v1 HeatPicker:280-412
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {visibleProposals.map((tp, idx) => {
              const block = tp.block;
              const isSelected = pickedSet.has(heatKey(tp.productId, block.start));
              const blockStartMs = parseLocal(block.start).getTime();
              const conflictsWithCart =
                !isSelected &&
                cartConflictBlocks.some((p) =>
                  heatsConflict(parseLocal(p.heatId).getTime(), p.track, blockStartMs, tp.track),
                );
              // Blocked by a heat the racer holds in a PRIOR reservation (not
              // this cart) — same spacing rules, different copy. Cart wins when
              // both apply ("picked heat" is the one they can still unselect).
              const conflictsWithExisting =
                !isSelected &&
                !conflictsWithCart &&
                existingConflictBlocks.some((p) =>
                  heatsConflict(parseLocal(p.heatId).getTime(), p.track, blockStartMs, tp.track),
                );
              const isConflict = conflictsWithCart || conflictsWithExisting;
              // The OTHER category holds this exact (track, start) session —
              // adults and juniors can't share one physical heat.
              const isCrossCategory =
                !isSelected &&
                crossCategoryBlocks.length > 0 &&
                collidesWithOtherCategory(tp.track, block.start, crossCategoryBlocks);
              // A track-scoped window (raceWindowExtension) reserves only its own
              // track — the other track's heats in those minutes stay bookable.
              const isEventReserved =
                !isSelected &&
                blockWindows.some((w) => {
                  if (!raceWindowAppliesToTrack(w, tp.track ?? null)) return false;
                  const hS = blockStartMs;
                  const hE = parseLocal(block.stop).getTime();
                  const wS = parseLocal(w.startIso).getTime();
                  const wE = parseLocal(w.stopIso).getTime();
                  return hS < wE && hE > wS;
                });
              // Morning-only buyout: heats starting before the public reopen time
              // (ET wall-clock minutes-of-day) are reserved for the private event.
              const heatStart = parseLocal(block.start);
              const isBeforeReopen =
                !isSelected &&
                reopenMins != null &&
                heatStart.getHours() * 60 + heatStart.getMinutes() < reopenMins;
              const isLowCap = block.freeSpots < partySize;
              const isCapped = atCap && !isSelected;
              // Restriction rule that disables (not hides) this slot — e.g. the
              // Mega opening-heats express-lane rule (race-restriction-rules.ts).
              const isRestricted = !isSelected && !!tp.restriction;
              const isFull =
                isLowCap ||
                isConflict ||
                isCrossCategory ||
                isCapped ||
                isEventReserved ||
                isBeforeReopen ||
                isRestricted;
              const statusLabel = isRestricted
                ? (tp.restriction!.cardLabel ?? "Not available")
                : isEventReserved || isBeforeReopen
                  ? "Reserved for event"
                  : isCrossCategory
                    ? category === "junior"
                      ? "Adults race at this time — pick another"
                      : "Juniors race at this time — pick another"
                    : isConflict
                      ? conflictsWithExisting
                        ? "Too close to existing reservation"
                        : "Too close to picked heat"
                      : isLowCap
                        ? `Need ${partySize}, only ${block.freeSpots} left`
                        : isCapped
                          ? "Unselect a picked heat to change"
                          : spotsLabel(block.freeSpots, block.capacity).label;
              const statusClass =
                isRestricted || isEventReserved || isBeforeReopen || isConflict || isCrossCategory
                  ? "text-amber-400"
                  : isLowCap
                    ? "text-red-400"
                    : isCapped
                      ? "text-white/40"
                      : spotsLabel(block.freeSpots, block.capacity).text;
              const isThisHolding = holdingKey === heatKey(tp.productId, block.start);

              // On a combined (multi-track) grid, tint each card by its track to
              // match the Ultimate combo's color layout; single-track grids keep
              // the neutral cyan-on-white style.
              const trackTheme = tp.track ? TRACK_CARD[tp.track] : undefined;
              const useTheme = showTrackBadge && !!trackTheme;
              const cardClass = isSelected
                ? useTheme
                  ? trackTheme!.selected
                  : "border-[#00E2E5] bg-[#00E2E5]/15 ring-1 ring-[#00E2E5]/50"
                : isFull
                  ? useTheme
                    ? DISABLED_CARD
                    : "bg-white/3 cursor-not-allowed border-white/5 opacity-40"
                  : useTheme
                    ? `${trackTheme!.base} ${trackTheme!.baseHover} cursor-pointer`
                    : "cursor-pointer border-white/10 bg-white/5 hover:border-white/25 hover:bg-white/10";

              return (
                <button
                  key={`${block.start}-${tp.productId}-${idx}`}
                  type="button"
                  onClick={() => !isFull && !holding && handleClickBlock(tp)}
                  disabled={isFull || holding}
                  title={
                    isRestricted
                      ? tp.restriction!.reason
                      : isCrossCategory
                        ? crossCategoryCollisionMessage(block.start, tp.track)
                        : conflictsWithExisting
                          ? EXISTING_RESERVATION_CONFLICT_TOOLTIP
                          : isConflict
                            ? HEAT_CONFLICT_TOOLTIP
                            : undefined
                  }
                  className={`relative rounded-xl border p-3 text-left transition-all duration-150 ${cardClass}`}
                >
                  {isThisHolding && (
                    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 rounded-xl border border-[#00E2E5]/60 bg-[#000418]/85 backdrop-blur-sm">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
                      <span className="text-[11px] font-semibold text-[#00E2E5]">Holding…</span>
                    </div>
                  )}
                  {showTrackBadge && tp.track && TRACK_BADGE[tp.track] && (
                    <div className="mb-1.5">
                      <span
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TRACK_BADGE[tp.track].bg} ${TRACK_BADGE[tp.track].text}`}
                      >
                        {tp.track}
                      </span>
                    </div>
                  )}
                  {/* KIOSK: the big time is a KARTING check-in deadline and now
                      says so. Unlabelled it read as a race time — the defect
                      lib/karting-checkin-copy.ts exists to prevent. Not on web:
                      Express Lane is unknown at pick time, so naming the karting
                      desk there could send a standard guest to the wrong floor. */}
                  {kartingEnabled && (
                    <div className="text-[10px] font-bold tracking-wide text-white/45 uppercase">
                      {t("race.heat.kartingCheckIn")}
                    </div>
                  )}
                  <div className="mb-0.5 text-base font-bold text-white">
                    {formatTime(block.start)}
                  </div>
                  {kartingEnabled ? (
                    /* Replaces "→ {block.stop}". `stop` is BMI's session end —
                       the slot plus the 7-minute race length — so the card
                       claimed the guest raced 3:00-3:07 and was finished, while
                       the flag actually drops a median 16 min after the slot.
                       This answers the question that range was being read for. */
                    <div className="mb-2 text-xs text-white/40">
                      {t("race.heat.racingBy", {
                        time: formatMs(
                          raceByAtMs(
                            parseLocal(block.start).getTime(),
                            kartingOnTime,
                            (tp.track ?? "").toLowerCase(),
                          ),
                        ),
                      })}
                    </div>
                  ) : (
                    <div className="mb-2 text-xs text-white/40">→ {formatTime(block.stop)}</div>
                  )}
                  <div className="mb-1 text-xs font-medium text-white/60">{block.name}</div>
                  <div className={`text-[13px] font-medium ${statusClass}`}>{statusLabel}</div>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                    <div
                      className={`h-full rounded-full ${
                        isLowCap
                          ? "bg-red-500"
                          : isConflict || isEventReserved || isCrossCategory
                            ? "bg-amber-400/50"
                            : block.freeSpots / block.capacity <= 0.3
                              ? "bg-amber-400"
                              : "bg-emerald-400"
                      }`}
                      style={{
                        width:
                          isConflict || isEventReserved || isCrossCategory
                            ? "100%"
                            : `${(block.freeSpots / block.capacity) * 100}%`,
                      }}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Reminders pane — v1 HeatPicker:469-479 */}
        <div className="bg-white/3 space-y-1 rounded-xl border border-white/8 p-4 text-xs text-white/40">
          <p>
            · Arrive <strong className="text-white/60">30 minutes early</strong> for check-in.
          </p>
          {anyNewInCategory && (
            <p>
              · A <strong className="text-white/60">$4.99 license fee</strong> per driver applies at
              first check-in.
            </p>
          )}
        </div>

        {/* Add another race: go back to the product step to pick a different race
            or track. Picked heats persist on item.heats and accumulate; the gap
            rule above spans every track/product the racer has added. */}
        {!product.raceCount && pickedBlocks.length > 0 && (
          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                // Clear the current product so the product step is a fresh pick,
                // then go back to it. Picked heats persist on item.heats.
                onChange(
                  category === "adult"
                    ? { productIdAdult: null, productTrackAdult: null }
                    : { productIdJunior: null, productTrackJunior: null },
                );
                dispatch({ type: "back" });
              }}
              className="inline-flex items-center gap-2 rounded-xl border border-[#00E2E5]/40 bg-[#00E2E5]/5 px-5 py-2.5 text-sm font-semibold text-[#00E2E5] transition-colors hover:bg-[#00E2E5]/10"
            >
              + Add another race or track
            </button>
            <p className="mt-1.5 text-xs text-white/40">
              Your picked heats are saved — pick a different race or track next.
            </p>
          </div>
        )}

        {pendingHeat && (
          <RacerSelectorModal
            racers={racers}
            raceTier={product.tier}
            alreadyBookedMemberIds={categoryHeats
              .filter(
                (h) =>
                  h.heatId === pendingHeat.block.start && h.productId === pendingHeat.productId,
              )
              .map((h) => h.assignedTo)
              .filter((id): id is string => !!id)}
            // Second race TYPE (the "Add another race" loop): default-select only
            // the guests who don't have a race yet — compared by TIER so same-tier
            // multi-heat/multi-track picks keep the select-everyone default.
            assignedOtherRaceMemberIds={categoryHeats
              .filter((h) => !!h.heatId && !!h.tier && h.tier !== product.tier)
              .map((h) => h.assignedTo)
              .filter((id): id is string => !!id)}
            onConfirm={handleRacerSelectorConfirm}
            onCancel={() => setPendingHeat(null)}
          />
        )}
      </div>
    );
  };
  if (!kartingCheckIn) return Component;

  // The provider has to sit OUTSIDE the component that reads the context, so the
  // kiosk variant is a thin wrapper rather than a flag inside the body.
  const KioskComponent: StepDef<RaceItem>["Component"] = (props) => (
    <KartingCheckInProvider>
      <Component {...props} />
    </KartingCheckInProvider>
  );
  KioskComponent.displayName = `KioskHeatPicker(${category})`;
  return KioskComponent;
}

function hasCategory(session: { party: PartyMember[] }, category: Category): boolean {
  return session.party.some((m) => (m.category ?? "adult") === category);
}

function canAdvanceFor(
  item: RaceItem,
  session: { party: PartyMember[] },
  category: Category,
): true | { reason: string } {
  if (!hasCategory(session, category)) return true;
  const productId = productIdForCategory(item, category);

  // Package flow: picks hold incrementally (tap = held), so the gate must
  // require EVERY component covered — an any-heat check would let Continue
  // pass with only the Starter picked. Scoped to THIS category's racers (a
  // mixed party's adult heats must not advance the junior step).
  const packageId = packageIdForCategory(item, category);
  if (!productId && packageId) {
    const pkg = getPackage(packageId);
    if (pkg && pkg.races.length > 0) {
      const categoryIds = new Set(
        session.party.filter((m) => (m.category ?? "adult") === category).map((m) => m.id),
      );
      const coverage = packageComponentsCovered(pkg, item.heats, categoryIds);
      return coverage.covered
        ? true
        : { reason: `Pick your ${coverage.missing[0]?.label ?? "package"} heat.` };
    }
  }

  const categoryRacerIdsForGuard = new Set(
    session.party.filter((m) => (m.category ?? "adult") === category).map((m) => m.id),
  );
  const hasAddedRaces = item.heats.some(
    (h) => h.heatId && h.assignedTo && categoryRacerIdsForGuard.has(h.assignedTo),
  );
  const product = getRaceProductById(productId);
  if (!product) {
    // No current product, but if they already added races (the "Add another"
    // loop clears the product), let them continue.
    return hasAddedRaces ? true : { reason: `Pick a ${category} race first.` };
  }
  const fetchPlan = buildFetchPlan(product);
  const categoryProductIds = new Set(fetchPlan.map((f) => f.productId));
  const categoryHeats = heatsForCategory(item, categoryProductIds);
  const heatsNeeded = product.raceCount ?? 1;
  const distinctBlocks = new Set(categoryHeats.filter((h) => !!h.heatId).map((h) => h.heatId!));
  if (distinctBlocks.size < heatsNeeded) {
    const remaining = heatsNeeded - distinctBlocks.size;
    return { reason: `Pick ${remaining} more ${category} heat${remaining === 1 ? "" : "s"}` };
  }
  // Conflict spans every product/track the racer added (the "Add another race"
  // loop accumulates heats across products), not just the current product.
  const categoryRacerIds = new Set(
    session.party.filter((m) => (m.category ?? "adult") === category).map((m) => m.id),
  );
  const allCategoryHeats = item.heats.filter(
    (h) => h.heatId && h.assignedTo && categoryRacerIds.has(h.assignedTo),
  );
  const byMember = new Map<string, Array<{ start: string; track: string | null }>>();
  for (const h of allCategoryHeats) {
    if (!h.assignedTo || !h.heatId) continue;
    const list = byMember.get(h.assignedTo) ?? [];
    list.push({ start: h.heatId, track: h.track });
    byMember.set(h.assignedTo, list);
  }
  for (const heats of byMember.values()) {
    if (heats.length < 2) continue;
    if (findHeatConflict(heats)) {
      return { reason: `Two of one ${category} racer’s heats are too close` };
    }
  }
  return true;
}

export const RaceHeatPickerStepAdult: StepDef<RaceItem> = {
  id: "race-heat-adult",
  title: "Adult Heats",
  Component: makeHeatPickerComponent("adult"),
  isVisible: (_item, session) => hasCategory(session, "adult"),
  canAdvance: (item, session) => canAdvanceFor(item, session, "adult"),
};

export const RaceHeatPickerStepJunior: StepDef<RaceItem> = {
  id: "race-heat-junior",
  title: "Junior Heats",
  Component: makeHeatPickerComponent("junior"),
  isVisible: (_item, session) => hasCategory(session, "junior"),
  canAdvance: (item, session) => canAdvanceFor(item, session, "junior"),
};

/**
 * KIOSK VARIANTS — same step, plus the karting-check-in treatment.
 *
 * Identical ids so the kiosk registry can swap them in with `replaceStep` and
 * every breadcrumb, URL hash and canAdvance gate keeps working. The ONLY
 * difference is that the karting context is mounted; see
 * KartingCheckInContext for why this is kiosk-only.
 */
export const RaceHeatPickerStepAdultKiosk: StepDef<RaceItem> = {
  ...RaceHeatPickerStepAdult,
  Component: makeHeatPickerComponent("adult", true),
};

export const RaceHeatPickerStepJuniorKiosk: StepDef<RaceItem> = {
  ...RaceHeatPickerStepJunior,
  Component: makeHeatPickerComponent("junior", true),
};
