/**
 * Resolve an AddOnContext from a completed combo booking's Redis record.
 *
 * Server-side only. Reads `bookingrecord:{billId}` (written by the confirmation
 * page) and derives:
 *   - the combo (must be addon-enabled), event date, center, contact
 *   - one race leg per the combo's race components, with the BMI productId
 *     resolved from the registry by (tier, track, schedule) — the SAME heat
 *     starts the original party holds (added guests run the same heats)
 *   - the bowling anchor (existing QAMF reservation + seated players/lanes)
 *
 * Defensive: the booking record is free-form JSON, so every field is read
 * tolerantly and a missing essential surfaces as a clear AddOnContextError.
 */
import redis from "@/lib/redis";
import {
  comboAddonEnabled,
  comboRaceLegs,
  getComboSpecial,
  type ComboSpecial,
} from "~/features/combos";
import { scheduleForDate } from "~/features/booking/service/race-pricing";
import {
  bmiBookingTarget,
  productsForSchedule,
  type RaceCategory,
} from "~/features/booking/service/race-products";

import type { AddOnContext, AddOnRaceLeg } from "./types";
import type { CapacityDeps } from "./capacity";

export class AddOnContextError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AddOnContextError";
    this.code = code;
  }
}

/** ET wall-clock minute key (strip Z / tz offset / seconds) for heat matching. */
function minuteKey(iso: string): string {
  return iso
    .replace(/Z$/, "")
    .replace(/[+-]\d{2}:\d{2}$/, "")
    .slice(0, 16);
}

interface RecordRacer {
  product?: string;
  heatStart?: string;
  track?: string | null;
  tier?: string | null;
  personId?: string | null;
}
interface RecordBowling {
  kind?: string;
  date?: string;
  bookedAt?: string;
  experienceSlug?: string;
  laneCount?: number;
  playerCount?: number;
  qamfReservationId?: string;
  qamfCenterId?: number;
}
interface BookingRecord {
  comboSpecial?: string | null;
  date?: string;
  center?: string;
  bowlingLane?: string | null;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  contact?: { firstName?: string; lastName?: string; email?: string; phone?: string };
  racers?: RecordRacer[];
  bowling?: RecordBowling[];
}

/** QAMF center id by complex (mirrors combo-booking QAMF_CENTER_CODES). */
function qamfCenterIdFor(center: string): number {
  return center === "naples" ? 3148 : 9172;
}

function resolveBmiClientKey(center: string): string {
  return center === "naples" ? "headpinznaples" : "headpinzftmyers";
}

/**
 * Resolve the BMI productId for a race leg from (tier, track, schedule). Returns
 * null when no single-race product matches (e.g. junior Starter on Mega Tuesday)
 * — the caller treats that as "leg not resolvable, can't add".
 */
function resolveLegProductId(
  dateYmd: string,
  tier: string,
  track: string | null,
  category: RaceCategory,
): string | null {
  const schedule = scheduleForDate(dateYmd);
  const pick = (racerType: "existing" | "new") =>
    productsForSchedule(schedule, racerType).filter(
      (p) =>
        p.tier === tier &&
        p.category === category &&
        !p.packType &&
        !p.trackProducts &&
        (track == null || p.track === track),
    );
  const existing = pick("existing");
  const list = existing.length ? existing : pick("new");
  return list[0]?.productId ?? null;
}

/**
 * Build the add-on race legs: one per the combo's race components (in itinerary
 * order), each carrying the heat start + track the original party holds. Heat
 * starts come from the booking record's racers, matched to legs by tier when the
 * record carries it, else by chronological order (sorted distinct heat starts).
 */
function buildRaceLegs(combo: ComboSpecial, rec: BookingRecord, eventDate: string): AddOnRaceLeg[] {
  const legs = comboRaceLegs(combo);
  const racers = rec.racers ?? [];

  // Distinct (heatStart, track, tier?) the party booked, in time order.
  const distinct = new Map<string, { heatStart: string; track: string | null; tier?: string }>();
  for (const r of racers) {
    if (!r.heatStart) continue;
    const key = minuteKey(r.heatStart);
    if (!distinct.has(key)) {
      distinct.set(key, {
        heatStart: r.heatStart,
        track: r.track ?? null,
        tier: r.tier ?? undefined,
      });
    }
  }
  const booked = [...distinct.values()].sort((a, b) =>
    minuteKey(a.heatStart).localeCompare(minuteKey(b.heatStart)),
  );

  return legs.map((leg, i) => {
    // Prefer a record heat whose tier matches this leg; else fall back to the
    // i-th booked heat in chronological order (matches itinerary order).
    const byTier = booked.find((b) => b.tier && b.tier === leg.tier);
    const anchor = byTier ?? booked[i] ?? booked[0];
    const track = anchor?.track ?? null;
    const productId = anchor ? resolveLegProductId(eventDate, leg.tier, track, "adult") : null;
    return {
      tier: leg.tier,
      productId: productId ?? "",
      track,
      heatStart: anchor?.heatStart ?? "",
    };
  });
}

/**
 * Server-side heat free-spots lookup for the capacity check — drives the
 * `/api/bmi` proxy via the request `origin` (same approach as rebuildRaceBill,
 * since the client bmiAdapter can't be used server-side). Returns the proposal
 * block's freeSpots for the leg's heat start, or 0 when the heat is gone.
 */
export function serverHeatFreeSpots(origin: string, clientKey: string): CapacityDeps {
  return {
    heatFreeSpots: async (leg) => {
      try {
        const target = bmiBookingTarget(leg.productId, { track: leg.track });
        const payload = JSON.stringify({
          ProductId: Number(target.productId),
          PageId: Number(target.pageId),
          Quantity: 1,
          OrderId: null,
          PersonId: null,
          DynamicLines: [],
        });
        const qs = new URLSearchParams({
          endpoint: "availability",
          clientKey,
          date: leg.heatStart.slice(0, 10),
        });
        const res = await fetch(`${origin}/api/bmi?${qs.toString()}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
          cache: "no-store",
        });
        if (!res.ok) return 0;
        const data = (await res.json().catch(() => ({}))) as {
          proposals?: Array<{ blocks?: Array<{ block?: { start?: string; freeSpots?: number } }> }>;
          Proposals?: Array<{ blocks?: Array<{ block?: { start?: string; freeSpots?: number } }> }>;
        };
        const proposals = data.proposals ?? data.Proposals ?? [];
        const want = minuteKey(leg.heatStart);
        for (const p of proposals) {
          const block = p.blocks?.[0]?.block;
          if (block?.start && minuteKey(block.start) === want) return block.freeSpots ?? 0;
        }
        return 0;
      } catch {
        return 0;
      }
    },
  };
}

export async function loadAddOnContext(billId: string): Promise<AddOnContext> {
  let raw: string | null = null;
  try {
    const v = await redis.get(`bookingrecord:${billId}`);
    raw = typeof v === "string" ? v : v ? JSON.stringify(v) : null;
  } catch (err) {
    throw new AddOnContextError("RECORD_READ_FAILED", `Could not read booking ${billId}: ${err}`);
  }
  if (!raw) throw new AddOnContextError("NOT_FOUND", "We couldn't find that booking.");

  let rec: BookingRecord;
  try {
    rec = JSON.parse(raw) as BookingRecord;
  } catch {
    throw new AddOnContextError("RECORD_PARSE_FAILED", "That booking record is unreadable.");
  }

  const comboId = rec.comboSpecial ?? null;
  if (!comboId) throw new AddOnContextError("NOT_A_COMBO", "This booking isn't a combo special.");
  const combo = getComboSpecial(comboId);
  if (!combo) throw new AddOnContextError("UNKNOWN_COMBO", "Unknown combo on this booking.");
  if (!comboAddonEnabled(combo)) {
    throw new AddOnContextError("ADDON_DISABLED", "Guests can't be added to this package online.");
  }

  const center = (rec.center as string) || combo.center;
  const eventDate = rec.date || rec.bowling?.[0]?.date || rec.bowling?.[0]?.bookedAt?.slice(0, 10);
  if (!eventDate) throw new AddOnContextError("NO_DATE", "This booking has no event date.");

  const raceLegs = buildRaceLegs(combo, rec, eventDate);
  if (raceLegs.some((l) => !l.productId || !l.heatStart)) {
    throw new AddOnContextError(
      "HEATS_UNRESOLVED",
      "We couldn't line up the races to add guests to — please call us.",
    );
  }

  const b = rec.bowling?.find((x) => x.qamfReservationId) ?? rec.bowling?.[0] ?? null;
  const bowling = b
    ? {
        qamfReservationId: b.qamfReservationId ?? "",
        qamfCenterId: b.qamfCenterId ?? qamfCenterIdFor(center),
        bookedAt: b.bookedAt ?? `${eventDate}T00:00:00`,
        // webOffer/option/duration are resolved at book time from the experiences
        // catalog for the combo's bowling component (not stored on the record).
        webOfferId: 0,
        optionType: "Time",
        durationMinutes:
          combo.components.find((c) => c.kind === "bowling")?.kind === "bowling"
            ? (combo.components.find(
                (c): c is Extract<typeof c, { kind: "bowling" }> => c.kind === "bowling",
              )?.durationMinutes ?? 90)
            : 90,
        laneCount: b.laneCount ?? 1,
        playerCount: b.playerCount ?? 0,
        lane: rec.bowlingLane ?? null,
      }
    : null;

  const c = rec.contact ?? {};
  const contact = {
    firstName: rec.firstName ?? c.firstName ?? "",
    lastName: rec.lastName ?? c.lastName ?? "",
    email: rec.email ?? c.email ?? "",
    phone: rec.phone ?? c.phone ?? "",
  };

  return {
    comboSpecialId: comboId,
    originalBillId: billId,
    clientKey: resolveBmiClientKey(center),
    center: center as AddOnContext["center"],
    eventDate,
    raceLegs,
    bowling,
    contact,
  };
}
