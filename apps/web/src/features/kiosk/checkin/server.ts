/**
 * Server-only glue for kiosk check-in lookup + itinerary (PR1, read-only).
 *
 * Route files can only export handlers, so all the Redis/Neon/Office logic
 * lives here. Nothing in this module mutates a reservation — PR1 only FINDS a
 * booking, proves possession (a scanned code, or an OTP to the booking
 * contact), and assembles the "what's next" envelope.
 *
 * PII posture: browse rows are "First L." + time + activities with an OPAQUE
 * ref (never a raw billId). Full names/contact only come back from the
 * itinerary envelope, and only with a valid proof token (short-lived, bound to
 * one billId). billId is a 17-digit BMI bigint — STRING end-to-end, never
 * Number() (except BigInt for the +1 office-project math).
 */
import { randomBytes } from "crypto";
import redis from "@/lib/redis";
import { recordSignageEvent } from "~/features/signage/events.server";
import { displayNameFromFull, makeDisplayName } from "@/lib/display-name";
import { verifyBillSignature } from "@/lib/booking-confirmation-link";
import { todayET } from "~/features/daily-events/format";
import { resolveCenter } from "~/features/cancellation/centers";
import { resolveBmiProject } from "~/features/cancellation/bmi-cancel";
import {
  getBowlingReservation,
  getBowlingReservationByBillId,
  getBowlingReservationByShortCode,
  listBowlingReservations,
  listCancelGroupReservations,
  getReservationsByContact,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { bowlIdFromKey, isBowlKey, isKioskBowlingRow, makeBowlKey } from "./res-key";
import { ATTRACTIONS } from "@/lib/attractions-data";
import { registerProjectPersonServer } from "~/features/kiosk/waiver/bmi-attach";
import { CENTER_TO_BMI_LOCATION_IDS } from "~/features/kiosk/waiver/locations";
import { getReservationDetail } from "~/features/daily-events/service";
import { appendProjectPrivateNote, KIOSK_CONFIRMATION_STATE_IDS } from "@/lib/bmi-office-actions";
import { isVipComboBooking } from "~/features/combos/combo-specials";
import { kioskCheckinAttachEnabled, kioskVoucherPrefillEnabled } from "../flags";
import { listJoinsForProject } from "../data/kiosk-waiver-joins-db";
import { officeProjectIdFromBillId } from "@/lib/bmi-office-ids";
import { getVoucher } from "~/features/game-cards/data/vouchers-db";
import {
  openCheckinEvent,
  getCheckinEvent,
  completeCheckinEvent,
  listCheckinPeople,
  upsertCheckinPerson,
  setCheckinPersonStatus,
} from "../data/kiosk-checkins-db";
import { heatsConflict } from "~/features/booking/service/conflict";
import {
  scheduleCheckinRacers,
  heatStopFor,
  type ScheduleRacer,
  type RacerOutcome,
} from "./schedule-racers";
import { checkRacerWaivers } from "./waiver";
import { isExpressBooking, isExpressRoster } from "./express";
import { getRaceProductById } from "~/features/booking/service/race-products";
import {
  assembleItinerary,
  fmtTime12,
  timeKey,
  toEtWallClock,
  type AttractionMeta,
} from "./itinerary";
import { classifyScan } from "./scan";
import { joinWasRemovedFromBmi, mergeRosterRows, type RosterRow } from "./roster-merge";
import { consumePriorSeats } from "./resume-seats";
import { browseRowIsOpen, browseRowTime, type BrowseLegLike } from "./browse-row";
import { reconcileHeatTimes, type BmiSchedule } from "./bmi-schedule-sync";
import { sql } from "@/lib/db";
import type {
  CheckinBindMember,
  CheckinBindResult,
  CheckinBrowseRow,
  CheckinItinerary,
  CheckinLookupMatch,
  CheckinPartyMember,
  CheckinRaceSlot,
  CheckinRosterPerson,
  CheckinSlotAssignment,
  CheckinVerifiedVia,
} from "./types";

// ── constants ──────────────────────────────────────────────────────────────
const REF_TTL = 900; // 15 min — a browse/scan handle
const PROOF_TTL = 1800; // 30 min — a verified flow token (survives a big party)
const OTP_COOLDOWN = 45; // per-reservation send throttle (anti-griefing)
// Browse shows the REST of today plus this far back (late arrivals). It used
// to be a ±3h window, which silently hid late-evening reservations (an 11pm
// race never showed until 8pm) — owner 2026-07-25: show the whole day ahead.
const BROWSE_LOOKBACK_MIN = 180;
const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";

export type CenterSlug = "fort-myers" | "naples";
export function isCenterSlug(v: string): v is CenterSlug {
  return v === "fort-myers" || v === "naples";
}

/** Both center_code namespaces (v1 Square codes + v2 slugs) for one center. */
const CENTER_CODES_FOR_SLUG: Record<CenterSlug, string[]> = {
  "fort-myers": ["TXBSQN0FEKQ11", "LAB52GY480CJF", "fort-myers", "fasttrax"],
  naples: ["PPTR5G2N0QXF7", "naples"],
};

function bmiClientKeyFor(slug: CenterSlug): string {
  return slug === "naples" ? "headpinznaples" : "headpinzftmyers";
}

// ── booking record (direct Redis read — the route's referer-auth 401s S2S) ───
interface BookingRecordRacer {
  racerName?: string;
  personId?: string | null;
  product?: string;
  track?: string | null;
  heatStart?: string;
  heatName?: string;
}
export interface BookingRecord {
  billId?: string;
  contact?: { firstName?: string; lastName?: string; email?: string; phone?: string };
  primaryPersonId?: string;
  racers?: BookingRecordRacer[];
  attractions?: Array<{ slug?: string; date?: string; slot?: string; qty?: number }>;
  bowling?: Array<{ kind?: string; date?: string; bookedAt?: string; playerCount?: number }>;
  reservationNumber?: string;
  reservationCode?: string;
  status?: string;
  date?: string;
  fastLane?: boolean;
}

async function readBookingRecord(billId: string): Promise<BookingRecord | null> {
  try {
    const raw = await redis.get(`bookingrecord:${billId}`);
    return raw ? (JSON.parse(raw) as BookingRecord) : null;
  } catch {
    return null;
  }
}

// ── token machinery ──────────────────────────────────────────────────────────
function newToken(): string {
  return randomBytes(18).toString("base64url");
}

interface RefHandle {
  billId: string;
  center: CenterSlug;
}

export async function mintRef(handle: RefHandle): Promise<string> {
  const token = newToken();
  await redis.set(`checkin:ref:${token}`, JSON.stringify(handle), "EX", REF_TTL);
  return token;
}
export async function readRef(token: string): Promise<RefHandle | null> {
  try {
    const raw = await redis.get(`checkin:ref:${token}`);
    return raw ? (JSON.parse(raw) as RefHandle) : null;
  } catch {
    return null;
  }
}
export async function mintProof(
  billId: string,
  center: CenterSlug,
  verifiedVia: CheckinVerifiedVia = "otp",
): Promise<string> {
  const token = newToken();
  await redis.set(
    `checkin:proof:${token}`,
    JSON.stringify({ billId, center, verifiedVia }),
    "EX",
    PROOF_TTL,
  );
  return token;
}
export async function readProof(
  token: string,
): Promise<{ billId: string; center: CenterSlug; verifiedVia?: CheckinVerifiedVia } | null> {
  try {
    const raw = await redis.get(`checkin:proof:${token}`);
    return raw
      ? (JSON.parse(raw) as {
          billId: string;
          center: CenterSlug;
          verifiedVia?: CheckinVerifiedVia;
        })
      : null;
  } catch {
    return null;
  }
}

/**
 * Test-kiosk OTP bypass — an env ALLOWLIST of kioskIds (comma-separated, e.g.
 * "fort-myers:99") whose check-in lookups skip the own-phone OTP and the
 * browse last-4/OTP gate (owner 2026-08-02: kiosk 99 shouldn't force phone or
 * OTP). Default UNSET = no bypass anywhere. The kioskId in the request body is
 * client-declared and therefore spoofable — that's why this is a server-side
 * env decision, opted into deliberately and killable without a deploy of the
 * kiosk. While a kioskId is listed, anyone who guesses it can open today's
 * reservations at that center without OTP — list it only while testing.
 */
export function checkinOtpBypassAllowed(kioskId: unknown): boolean {
  if (typeof kioskId !== "string" || !kioskId) return false;
  const raw = process.env.KIOSK_CHECKIN_OTP_BYPASS_KIOSK_IDS ?? "";
  const allowlisted = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(kioskId);
  if (allowlisted) return true;
  // TEST KIOSK 99, OFF PRODUCTION ONLY (owner 2026-08-07: "make kiosk 99 not
  // need otp for reservation select so I can test this"). Preview deployments
  // exist to be tested, and requiring both a Vercel env var and a live SMS to
  // the booking's own contact made check-in effectively untestable there.
  // Production is UNCHANGED — the env allowlist remains the only way in, because
  // the kioskId is client-declared and therefore spoofable, and a bypass opens
  // today's reservations at that center to anyone who guesses it.
  if (process.env.VERCEL_ENV === "production") return false;
  return isTestKioskId(kioskId);
}

/** Kiosk id is "center:number" (e.g. "fort-myers:99"); 99 is the test unit. */
function isTestKioskId(kioskId: string): boolean {
  return kioskId.split(":").pop()?.trim() === "99";
}

/** Lax per-IP limiter (fail-open — venue kiosks + phones share one NAT). */
export async function rateLimited(bucket: string, ip: string, max: number): Promise<boolean> {
  try {
    const key = `checkin:rl:${bucket}:${ip}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 300);
    return n > max;
  } catch {
    return false;
  }
}

// ── scan → billId resolution (needs Redis / Office) ──────────────────────────
/**
 * Resolve a scan/typed payload to a billId. `proven` is true ONLY when the
 * input carried a verifiable HMAC signature (a /s short link or a full signed
 * URL) — those open the itinerary directly. Everything enumerable (a native
 * code, the r{billId} fallback, a W-number) resolves the billId but is NOT
 * proof: billIds/W-numbers are sequential and self-disclosed, so the route
 * OTP-gates these to the reservation's own contact before revealing anything.
 */
export async function resolveScanToBillId(
  center: CenterSlug,
  raw: string,
): Promise<{ billId?: string; proven?: boolean; reason?: "not-found" | "invalid" }> {
  const c = classifyScan(raw);
  switch (c.kind) {
    case "signed-url": {
      if (c.sig && verifyBillSignature(c.value, c.sig)) return { billId: c.value, proven: true };
      return { reason: "invalid" };
    }
    case "shortcode": {
      // The /s mapping stores a SIGNED confirmation URL — a verified sig here is
      // real possession, so it opens directly.
      const url = await redis.get(`short:${c.value}`).catch(() => null);
      if (url) {
        const billId = billIdFromSignedUrl(url);
        if (billId) return { billId, proven: true };
      }
      // Not a signed short link → the code index. A hit here is a genuine
      // reservationCode (the emailed QR payload; the enumerable r{billId}
      // fallback classifies as "code", never "shortcode"), so scanning the QR is
      // proof and it opens directly — no OTP (owner 2026-07-25).
      const byCode = await redis.get(`bookingrecord:code:${c.value}`).catch(() => null);
      if (byCode) return { billId: byCode, proven: true };
      // A BOWLING confirmation link: /s/{code} where {code} IS the bowling
      // reservation's own short_code — the stored /s destination carries only
      // `?code=`, no billId, which is why these dead-ended here before.
      // Possession of the emailed/SMS link is proof (same bar as the racing
      // QR); the code is CSPRNG-shaped, not enumerable. HeadPinz lanes only —
      // an FT duckpin row never opens kiosk bowling check-in (owner rule).
      const bowl = await getBowlingReservationByShortCode(c.value).catch(() => null);
      if (bowl && isKioskBowlingRow(bowl)) {
        return { billId: bowl.bmiBillId ?? makeBowlKey(bowl.id), proven: true };
      }
      return { reason: "not-found" };
    }
    case "code": {
      const byCode = await redis.get(`bookingrecord:code:${c.value}`).catch(() => null);
      if (byCode) {
        // A genuine reservationCode (the emailed QR) opens directly — scanning
        // the QR is proof of possession (owner 2026-07-25, QR not OTP-gated).
        // The `r{billId}` fallback IS the billId (enumerable), so it stays gated.
        const enumerableFallback = /^r\d{15,19}$/i.test(c.value);
        return { billId: byCode, proven: !enumerableFallback };
      }
      return { reason: "not-found" };
    }
    case "wnumber": {
      // Server-written index (all go-forward bookings incl. kiosk); Office
      // search is the fallback for anything older. Enumerable → unproven.
      const byRes = await redis.get(`bookingrecord:res:${c.value}`).catch(() => null);
      if (byRes) return { billId: byRes, proven: false };
      const billId = await officeResolveWNumber(center, c.value);
      return billId ? { billId, proven: false } : { reason: "not-found" };
    }
    case "voucher": {
      // A booking-minted voucher (vouchers.bill_id, stamped at reserve). The
      // QR arrives in the same email as the reservation QR, so possession =
      // proof (owner 2026-07-25 posture). CSPRNG codes are non-enumerable.
      // Voided codes prove nothing; EXPIRED ones still do — expiry limits
      // redemption value, not identity. Flag-gated: OFF = today's not-found.
      if (!kioskVoucherPrefillEnabled()) return { reason: "not-found" };
      const voucher = await getVoucher(c.value).catch(() => null);
      if (voucher && !voucher.voidedAt && voucher.billId) {
        return { billId: voucher.billId, proven: true };
      }
      return { reason: "not-found" };
    }
    default:
      return { reason: "invalid" };
  }
}

function billIdFromSignedUrl(url: string): string | null {
  try {
    const u = new URL(url, SITE);
    const billId = u.searchParams.get("billId") || u.searchParams.get("orderId");
    const sig = u.searchParams.get("sig");
    if (billId && sig && verifyBillSignature(billId, sig)) return billId;
    // Some stored links carry only ?code= (bowling) — no billId to trust here.
    return null;
  } catch {
    return null;
  }
}

async function officeResolveWNumber(center: CenterSlug, wNumber: string): Promise<string | null> {
  try {
    const res = await resolveBmiProject({
      bmiClientKey: bmiClientKeyFor(center),
      bmiBillId: "", // W-only: resolveBmiProject searches by number, then uses projectId
      bmiReservationNumber: wNumber,
    });
    if (!res.projectId) return null;
    // billId = office projectId − 1 (string-safe BigInt; billId is 17-digit).
    return (BigInt(res.projectId) - BigInt(1)).toString();
  } catch {
    return null;
  }
}

/** Is this money-group row a bowling leg (bookedAt ≈ event time)? Race/attraction
 *  bookedAt is the BOOKING timestamp, never the event time. */
function isBowlingRow(r: BowlingReservation): boolean {
  return r.productKind === "open" || r.productKind === "kbf";
}

/** A racer heat persisted in a Neon race row's booking_metadata.heats. heatId
 *  is the naive-ET block start. Used as the racing fallback when the Redis
 *  booking record (which normally supplies racers) has been evicted. */
interface NeonHeat {
  heatId?: string;
  track?: string | null;
  tier?: string;
  category?: string;
  productId?: string | null;
  bmiPersonId?: string | null;
  racer?: string;
}
function neonHeats(group: BowlingReservation[]): NeonHeat[] {
  const out: NeonHeat[] = [];
  for (const r of group) {
    if (r.productKind !== "race") continue;
    const heats = (r.bookingMetadata as { heats?: unknown } | undefined)?.heats;
    if (Array.isArray(heats)) {
      for (const h of heats) if (h && typeof h === "object") out.push(h as NeonHeat);
    }
  }
  return out;
}
/**
 * Bring this reservation's RACE TIMES back in line with BMI, and persist the
 * correction to Neon.
 *
 * `booking_metadata.heats` is written once at booking and never hears about a
 * heat staff move in BMI. Live 2026-08-07: the kiosk offered 10:12 PM for a
 * race BMI had moved to 11:12 PM, and the assignment failed against a heat that
 * no longer existed. 2 of 25 recent race reservations were already stale.
 *
 * BMI owns the schedule (owner: "BMI is truth on this"), so we WRITE Neon
 * rather than just render around it.
 *
 * WHY IT MATTERS — the assignment, not the label. Pandora's `/bmi/schedule`
 * matches the session BY START TIME: `scheduleCheckinRacers` sends
 * `heatStart: heat.heatId`, so a stale time matches no session and the racer is
 * silently not assigned (owner 2026-08-07: "we use it for race assignment
 * endpoint in pandora, that's why it doesn't always assign because it don't
 * match"). That is the long-standing intermittent no-assign, not a cosmetic
 * wrong time on a screen. `race-session-assign-sweep` seats racers the same way
 * and fails the same way.
 *
 * NOT affected, contrary to an earlier version of this comment: the e-ticket
 * and check-in-alert crons. Both drive off PANDORA sessions (/sessions,
 * /races-current) and never read a heat time from Neon — the one mention of
 * `heats[].heatId` in pre-race-tickets is a timezone warning in a comment
 * (owner: "those fire off people in session not reservation").
 *
 * Per RACE ROW, and fails closed: `reconcileHeatTimes` only rewrites when the
 * race count and the per-race seat counts line up exactly, so a booking whose
 * shape has genuinely changed is left for the desk instead of being guessed at.
 * Never throws — a failed sync just leaves today's behaviour.
 */
async function syncRaceHeatsFromBmi(
  billId: string,
  center: CenterSlug | null,
  group: BowlingReservation[],
): Promise<void> {
  if (!center) return;
  const raceRows = group.filter((r) => r.productKind === "race");
  if (raceRows.length === 0) return;

  let schedules: BmiSchedule[] = [];
  const projectId = officeProjectIdFromBillId(billId);
  for (const locationId of CENTER_TO_BMI_LOCATION_IDS[center] ?? []) {
    try {
      const detail = await getReservationDetail(locationId, projectId);
      const s = (detail.schedules ?? []) as BmiSchedule[];
      if (s.length > 0) {
        schedules = s;
        break;
      }
    } catch {
      /* next venue, or leave Neon untouched */
    }
  }
  if (schedules.length === 0) return;

  for (const row of raceRows) {
    const heats = ((row.bookingMetadata as { heats?: unknown } | undefined)?.heats ??
      []) as NeonHeat[];
    if (!Array.isArray(heats) || heats.length === 0) continue;
    const result = reconcileHeatTimes(heats, schedules);
    if (result.changed === 0) {
      if (result.reason !== "ok") {
        console.warn(
          `[checkin] ${billId}: race times NOT synced (${result.reason}${result.detail ? ` — ${result.detail}` : ""}) — left as booked`,
        );
      }
      continue;
    }
    try {
      const q = sql();
      await q`
        UPDATE bowling_reservations
        SET booking_metadata = COALESCE(booking_metadata, '{}'::jsonb)
            || jsonb_build_object('heats', ${JSON.stringify(result.heats)}::jsonb)
        WHERE id = ${row.id}
      `;
      // Keep the in-memory group consistent so THIS check-in uses the new time
      // without a re-read.
      (row.bookingMetadata as { heats?: unknown }).heats = result.heats;
      console.warn(
        `[checkin] ${billId}: race time changed in BMI — synced ${result.changed} heat row(s) to Neon (${result.detail})`,
      );

      // A racer ALREADY seated on the old time is now stranded on a Pandora
      // session that no longer exists, and `completeCheckin` skips anyone whose
      // schedule_status is 'inserted' — so without this they are never re-seated
      // and simply vanish from the grid. Seen live on W58723: Test5 was seated
      // at 22:12 before the race moved, Eric was seated at 23:12 after, and only
      // Eric appeared. Clearing the stamp puts them back in the queue; the
      // Pandora insert is idempotent (already_linked), so a racer who somehow IS
      // still on the right session costs nothing.
      const movedFrom = new Set<string>();
      heats.forEach((h, i) => {
        const before = String(h.heatId ?? "").slice(0, 19);
        const after = String(result.heats[i]?.heatId ?? "").slice(0, 19);
        if (before && after && before !== after) movedFrom.add(before);
      });
      if (movedFrom.size > 0) {
        try {
          const event = await getCheckinEvent(billId, todayET());
          if (event) {
            for (const p of await listCheckinPeople(event.id)) {
              const bound = Array.isArray(p.boundHeats)
                ? (p.boundHeats as Array<{ heatId?: string }>)
                : [];
              const stranded = bound.some((h) =>
                movedFrom.has(String(h?.heatId ?? "").slice(0, 19)),
              );
              if (!stranded) continue;
              await q`
                UPDATE kiosk_checkin_people
                SET schedule_status = 'pending', bound_heats = NULL, updated_at = now()
                WHERE id = ${p.id}
              `;
              console.warn(
                `[checkin] ${billId}: "${p.displayName}" was seated on a race that MOVED — ` +
                  `cleared for re-scheduling onto the new time`,
              );
            }
          }
        } catch (err) {
          console.error(`[checkin] ${billId}: could not clear stranded seats:`, err);
        }
      }
    } catch (err) {
      console.error(`[checkin] ${billId}: heat sync write failed (non-fatal):`, err);
    }
  }
}

function raceHeatStartsFromNeon(group: BowlingReservation[]): string[] {
  return neonHeats(group)
    .map((h) => h.heatId ?? "")
    .filter(Boolean);
}

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

interface RaceSlotEntry {
  slot: CheckinRaceSlot;
  heat: NeonHeat;
}

/**
 * Purchased race slots from the Neon race rows' `booking_metadata.heats` — the
 * "who is who" assignment surface, paired with their source heat. Two racers in
 * the SAME heat share a `heatId`, so each seat gets a stable UNIQUE `slotKey`
 * (`heatId|productId|occurrence`) — the key the client assigns against and the
 * server re-resolves. Deterministically sorted (by start, then product) so the
 * slotKeys match between the itinerary GET and the complete POST, which both
 * call this. Built only from Neon heats (the authoritative per-slot record with
 * category/productId); a record-only fallback yields no slots.
 */
function buildRaceSlotEntries(group: BowlingReservation[]): RaceSlotEntry[] {
  const heats = neonHeats(group).filter((h) => h.heatId);
  const sorted = [...heats].sort(
    (a, b) =>
      timeKey(a.heatId).localeCompare(timeKey(b.heatId)) ||
      String(a.productId ?? "").localeCompare(String(b.productId ?? "")),
  );
  const seen = new Map<string, number>();
  return sorted.map((h) => {
    const base = `${h.heatId}|${h.productId ?? ""}`;
    const occ = seen.get(base) ?? 0;
    seen.set(base, occ + 1);
    const product = h.productId ? getRaceProductById(h.productId) : null;
    const tier = h.tier || product?.tier || "starter";
    const category = (h.category || product?.category || "adult") as "adult" | "junior";
    const track = h.track ?? product?.track ?? null;
    return {
      heat: h,
      slot: {
        slotKey: `${base}|${occ}`,
        heatId: h.heatId as string,
        productId: h.productId ?? null,
        classLabel: `${titleCase(tier)} ${titleCase(category)}` + (track ? ` · ${track}` : ""),
        tier,
        category,
        track,
        timeLabel: fmtTime12(h.heatId),
        occupantName: h.bmiPersonId ? (h.racer ? displayNameFromFull(h.racer) : "Racer") : null,
        open: !h.bmiPersonId,
      },
    };
  });
}

function buildRaceSlots(group: BowlingReservation[]): CheckinRaceSlot[] {
  return buildRaceSlotEntries(group).map((e) => e.slot);
}

// ── reservation summary (label / center / cancelled) ─────────────────────────
interface ResSummary {
  billId: string;
  center: CenterSlug | null;
  cancelled: boolean;
  label: string; // "Eric O."
  timeLabel: string;
  activitiesLabel: string;
  startKey: string; // tz-stripped minute for the earliest activity
  moneyGroup: BowlingReservation[];
  record: BookingRecord | null;
}

function activitiesLabelFrom(record: BookingRecord | null, group: BowlingReservation[]): string {
  const parts: string[] = [];
  const hasRacing =
    (record?.racers?.length ?? 0) > 0 || group.some((r) => r.productKind === "race");
  const hasBowling = group.some((r) => r.productKind === "open" || r.productKind === "kbf");
  const hasAttraction =
    (record?.attractions?.length ?? 0) > 0 || group.some((r) => r.productKind === "attraction");
  if (hasRacing) parts.push("Racing");
  if (hasBowling) parts.push("Bowling");
  if (hasAttraction) parts.push("Attraction");
  return parts.join(" + ") || "Reservation";
}

async function loadSummary(billId: string): Promise<ResSummary | null> {
  // `billId` is a reservation KEY (res-key.ts): bare digits = a BMI bill;
  // "bowl:{neonId}" = a bowling-only reservation (the hp/book wizard never
  // mints a bill, so its rows are unreachable by billId). A bowl key has no
  // Redis booking record — the Neon row is the whole truth — and it only ever
  // anchors on a HeadPinz bowling row (never FT duckpin, owner rule).
  const bowlId = bowlIdFromKey(billId);
  if (isBowlKey(billId) && !bowlId) return null;
  const record = bowlId ? null : await readBookingRecord(billId);
  const anchor = bowlId
    ? await getBowlingReservation(bowlId).catch(() => null)
    : await getBowlingReservationByBillId(billId).catch(() => null);
  if (bowlId && (!anchor || !isKioskBowlingRow(anchor))) return null;
  const moneyGroup = anchor ? await listCancelGroupReservations(anchor).catch(() => [anchor]) : [];

  if (!record && moneyGroup.length === 0) return null;

  const center: CenterSlug | null = anchor
    ? resolveCenter(anchor.centerCode, anchor.productKind).slug
    : null;

  const cancelled =
    record?.status === "cancelled" ||
    record?.status === "refunded" ||
    (moneyGroup.length > 0 && moneyGroup.every((r) => r.status === "cancelled"));

  // Earliest EVENT start (never a booking timestamp). Racing/attraction event
  // times come from the Redis record's naive-ET heatStart/slot, or the Neon
  // race row's booking_metadata.heats when the record is gone; bowling event
  // time is the row's eventAt/bookedAt normalized to ET wall-clock. Race/
  // attraction bookedAt is the BOOKING moment — never used as event time.
  const starts: string[] = [];
  for (const r of record?.racers ?? []) if (r.heatStart) starts.push(r.heatStart);
  for (const a of record?.attractions ?? []) if (a.slot) starts.push(a.slot);
  if ((record?.racers?.length ?? 0) === 0) {
    for (const iso of raceHeatStartsFromNeon(moneyGroup)) starts.push(iso);
  }
  for (const r of moneyGroup) {
    if (!isBowlingRow(r)) continue;
    const evt = toEtWallClock(r.eventAt || r.bookedAt);
    if (evt) starts.push(evt);
  }
  starts.sort((a, b) => timeKey(a).localeCompare(timeKey(b)));
  const startKey = starts[0] ? timeKey(starts[0]) : "";

  const fullName =
    (record?.contact
      ? `${record.contact.firstName ?? ""} ${record.contact.lastName ?? ""}`.trim()
      : "") ||
    moneyGroup.find((r) => r.guestName)?.guestName ||
    "";
  const label = fullName ? displayNameFromFull(fullName) : "Guest";
  const activitiesLabel = activitiesLabelFrom(record, moneyGroup);

  return {
    billId,
    center,
    cancelled,
    label,
    timeLabel: starts[0] ? fmtTime12(starts[0]) : "",
    activitiesLabel,
    startKey,
    moneyGroup,
    record,
  };
}

// ── within-window helper (naive-ET minute strings) ───────────────────────────
function etMinuteOffset(minutes: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(Date.now() + minutes * 60_000);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hh = g("hour") === "24" ? "00" : g("hour");
  return `${g("year")}-${g("month")}-${g("day")}T${hh}:${g("minute")}`;
}

// ── phone match ──────────────────────────────────────────────────────────────
function last10(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, "").slice(-10);
}

/** Is the guest's typed-own phone OTP-verified (sms-verify PUT set the flag)? */
export async function phoneIsVerified(phone: string): Promise<boolean> {
  try {
    return (await redis.get(`verified:${last10(phone)}`)) === "1";
  } catch {
    return false;
  }
}

/** A contact lookup's result: the openable matches, plus whether a REAL
 *  HeadPinz bowling-only reservation was withheld because the asking kiosk is
 *  in the FastTrax building — so the route can answer "check in at HeadPinz"
 *  instead of the confusing "no reservations found". */
interface ContactMatchResult {
  matches: CheckinLookupMatch[];
  bowlingSuppressed: boolean;
}

/**
 * Today's reservations at this center for one contact channel, each carrying
 * its own proof token.
 *
 * `getReservationsByContact` is SINGLE-CHANNEL by design (it refuses to run an
 * unfiltered scan), so phone and email are separate calls — `seen` is passed in
 * by callers that need to merge several channels for the same human without
 * minting two proofs for one booking.
 *
 * `venue` is the asking kiosk's BUILDING: "FT" withholds bowling-only
 * reservations, because bowling check-in (and the lane it would open) is a
 * HeadPinz-building action — owner 2026-08-16, "people being confused if they
 * try to do a lane from FT". Combos still match through their bill anchor;
 * only the bowl-key mint is withheld.
 */
async function matchByContact(
  center: CenterSlug,
  contact: { phone?: string; email?: string },
  verifiedVia: CheckinVerifiedVia,
  seen: Set<string> = new Set(),
  venue?: string,
): Promise<ContactMatchResult> {
  const rows = await getReservationsByContact({ ...contact, limit: 200 }).catch(() => []);
  const today = todayET();
  const matches: CheckinLookupMatch[] = [];
  let bowlingSuppressed = false;
  // Row order is event_at DESC; group by reservation KEY and keep today + this
  // center. A verified own-phone match IS proof of possession (the phone is the
  // booking contact), so each match carries its own proof token.
  for (const row of rows) {
    if (row.status === "cancelled") continue;
    if (resolveCenter(row.centerCode, row.productKind).slug !== center) continue;
    const dateStr = (row.eventAt || row.bookedAt || "").slice(0, 10);
    if (dateStr !== today) continue;
    let key = row.bmiBillId ?? null;
    if (!key) {
      // A bowling-only booking (the hp/book wizard) never gets a BMI bill, so
      // these rows were silently dropped and a bowling guest's phone lookup
      // said "no reservations". Key it on its own Neon row — but only when its
      // money group truly has no bill: a unified cart's bowling LEG also has a
      // NULL bill and must join its anchor's key instead of double-matching.
      // HeadPinz lanes only (never FT duckpin — owner rule 2026-08-16).
      if (!isKioskBowlingRow(row)) continue;
      if (venue === "FT") {
        bowlingSuppressed = true;
        continue;
      }
      const group = await listCancelGroupReservations(row).catch(() => [row]);
      key = group.find((r) => r.bmiBillId)?.bmiBillId ?? makeBowlKey(row.id);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    const summary = await loadSummary(key);
    if (!summary || summary.cancelled) continue;
    const proofToken = await mintProof(key, center, verifiedVia);
    matches.push({
      proofToken,
      label: summary.label,
      timeLabel: summary.timeLabel,
      activitiesLabel: summary.activitiesLabel,
    });
  }
  return { matches, bowlingSuppressed };
}

export async function matchByPhone(
  center: CenterSlug,
  phone: string,
  venue?: string,
): Promise<ContactMatchResult> {
  return matchByContact(center, { phone }, "otp", new Set(), venue);
}

/**
 * A racer's own reservations today — the person→booking half of a licence scan.
 *
 * The identity is already established by the caller (an Office token search on
 * the scanned code); this only turns that person into today's booking. It goes
 * through the SAME contact index the phone path uses rather than a new
 * personId→booking join, because the booking rows are keyed on the contact the
 * guest gave US, not on a BMI person.
 *
 * Several `contacts` because one human legitimately has several Office records
 * (the lookup deliberately returns every duplicate) with different phones on
 * them; the shared `seen` set keeps one booking from matching twice.
 */
export async function matchByRacerContacts(
  center: CenterSlug,
  contacts: Array<{ phone?: string; email?: string }>,
  venue?: string,
): Promise<CheckinLookupMatch[]> {
  const seen = new Set<string>();
  const matches: CheckinLookupMatch[] = [];
  for (const contact of contacts) {
    if (contact.phone) {
      const r = await matchByContact(center, { phone: contact.phone }, "racer", seen, venue);
      matches.push(...r.matches);
    }
    // Email is a FALLBACK, not a second pass: a racer whose Office record has
    // no mobile still has an address, and that is the only channel left.
    if (contact.email) {
      const r = await matchByContact(center, { email: contact.email }, "racer", seen, venue);
      matches.push(...r.matches);
    }
  }
  return matches;
}

// ── browse (today at this center — rest of the day, 3h lookback) ─────────────
function kindsToActivitiesLabel(kinds: Set<string>): {
  label: string;
  kind: CheckinBrowseRow["kind"];
} {
  const parts: string[] = [];
  if (kinds.has("race")) parts.push("Racing");
  if (kinds.has("open") || kinds.has("kbf")) parts.push("Bowling");
  if (kinds.has("attraction")) parts.push("Attraction");
  const label = parts.join(" + ") || "Reservation";
  const kind: CheckinBrowseRow["kind"] =
    parts.length > 1
      ? "mixed"
      : parts[0] === "Racing"
        ? "racing"
        : parts[0] === "Bowling"
          ? "bowling"
          : "attraction";
  return { label, kind };
}

export async function listBrowseRows(
  center: CenterSlug,
  /** Asking kiosk's building — "FT" keeps the list racing-only (bowling
   *  check-in is a HeadPinz-building action, owner 2026-08-16). */
  venue?: string,
): Promise<CheckinBrowseRow[]> {
  const today = todayET();
  const rows = await listBowlingReservations({
    startDate: today,
    endDate: today,
    centerCodes: CENTER_CODES_FOR_SLUG[center],
  }).catch(() => []);
  // No forward cutoff — the query is already scoped to today's business date,
  // so "everything from 3h ago on" IS the rest of the day (incl. 11pm+ slots).
  const lo = etMinuteOffset(-BROWSE_LOOKBACK_MIN);

  // Group Neon rows by MONEY GROUP — deposit order first, bill second, the row
  // itself last — the same precedence listCancelGroupReservations uses. Keying
  // on billId alone dropped every standalone bowling booking (the hp/book
  // wizard never mints a bill), which kept bowling-only guests out of this
  // list; grouping on the deposit order also keeps a combo's bill-less bowling
  // LEG in the same group as its bill-carrying anchor.
  interface Grp {
    /** Reservation KEY the row opens under: the group's bill, else bowl:{id}. */
    billKey: string;
    kinds: Set<string>;
    guestName: string;
    earliest: string;
    /** VIP combo id from whichever leg carries it (stamped on both combo
     *  legs) — free off the rows already fetched, no extra round trip. */
    comboSpecialId: string | null;
    /** Any HeadPinz bowling leg (open/kbf at HPFM/HPN — never FT duckpin)?
     *  Grants browse inclusion for non-racing groups (owner 2026-08-16). */
    hasHpBowling: boolean;
  }
  // Collect every leg per money group FIRST. Both decisions below — the time to
  // show and whether the reservation is open at all — are properties of the
  // WHOLE reservation, and judging them one leg at a time is what let a
  // cancelled booking stay selectable and a racing row advertise its booking
  // time.
  const groupKeyOf = (row: (typeof rows)[number]): string =>
    row.squareDepositOrderId ?? row.bmiBillId ?? `row:${row.id}`;
  const legsByGroup = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const gk = groupKeyOf(row);
    const list = legsByGroup.get(gk) ?? [];
    list.push(row);
    legsByGroup.set(gk, list);
  }

  const groups = new Map<string, Grp>();
  for (const row of rows) {
    if (row.status === "cancelled" || row.status === "no_show") continue;
    // Skip kiosk-booked reservations — that guest is already in-center (they
    // just booked AT the kiosk), so they never need to find themselves here to
    // check in (owner 2026-07-25).
    if (row.bookingSource === "kiosk") continue;
    const legs = legsByGroup.get(groupKeyOf(row)) ?? [row];
    // The key this reservation opens/verifies under: the group's bill when any
    // leg carries one; else the group's own HeadPinz bowling row (bowl:{id},
    // deterministic — lowest id). No bill and no HP bowling → unopenable; skip.
    const hpBowlingLegs = legs
      .filter((l) => isKioskBowlingRow(l))
      .sort((a, b) => a.id - b.id);
    const billKey =
      legs.find((l) => l.bmiBillId)?.bmiBillId ??
      (hpBowlingLegs.length > 0 ? makeBowlKey(hpBowlingLegs[0].id) : null);
    if (!billKey) continue;
    // CANCELLED IN BMI. Neon's status is our record and it goes stale, so judge
    // the whole reservation: any dead leg removes it. Owner hit the old
    // behaviour by opening a reservation cancelled in BMI (2026-08-07).
    if (!browseRowIsOpen(legs as BrowseLegLike[])) continue;
    // THE RACE TIME, not the booking time. `eventAt` maps to `event_at`, a
    // column this table does not have, so it was always undefined and every
    // racing row fell through to `bookedAt` — the moment they BOOKED. Measured
    // on 10 consecutive live rows: all wrong, by 22 min to 1h44m.
    const evt = browseRowTime(legs as BrowseLegLike[]).iso;
    const key = timeKey(evt);
    if (!key || key < lo) continue;
    const g = groups.get(billKey);
    if (g) {
      g.kinds.add(row.productKind);
      if (!g.guestName && row.guestName) g.guestName = row.guestName;
      if (timeKey(evt) < timeKey(g.earliest)) g.earliest = evt;
      if (!g.comboSpecialId && row.comboSpecialId) g.comboSpecialId = row.comboSpecialId;
      g.hasHpBowling = g.hasHpBowling || isKioskBowlingRow(row);
    } else {
      groups.set(billKey, {
        billKey,
        kinds: new Set([row.productKind]),
        guestName: row.guestName ?? "",
        earliest: evt,
        comboSpecialId: row.comboSpecialId ?? null,
        hasHpBowling: isKioskBowlingRow(row),
      });
    }
  }

  const ordered = [...groups.values()].sort((a, b) =>
    timeKey(a.earliest).localeCompare(timeKey(b.earliest)),
  );
  const out: CheckinBrowseRow[] = [];
  for (const g of ordered) {
    // Racing check-in (owner 2026-07-25) OR a HeadPinz bowling leg (owner
    // 2026-08-16 — bowling check-in at HPFM/HPN, never FT duckpin). An
    // attraction-only reservation still never lists here. FastTrax-building
    // kiosks stay racing-only: a bowling-only row there would invite the guest
    // to open a HeadPinz lane from the wrong building.
    if (!g.kinds.has("race") && (venue === "FT" || !g.hasHpBowling)) continue;
    const { label: activitiesLabel, kind } = kindsToActivitiesLabel(g.kinds);
    // Express Lane is per-RESERVATION truth, not "is this a race" — badging
    // every racing row (the pre-fix behaviour) told guests who DO need to check
    // in to skip it. The booking record carries the flag checkout wrote; read it
    // alongside the ref mint so this costs no extra round trip. Only a
    // racing-ONLY row can be express (a combo still needs its lane opened).
    const [record, ref] = await Promise.all([
      // A racing key is always a real billId (bowl keys only anchor bowling
      // groups), so the record read stays billId-shaped.
      kind === "racing" ? readBookingRecord(g.billKey) : Promise.resolve(null),
      mintRef({ billId: g.billKey, center }),
    ]);
    out.push({
      ref,
      label: g.guestName ? displayNameFromFull(g.guestName) : "Guest",
      timeLabel: fmtTime12(g.earliest),
      activitiesLabel,
      kind,
      express: isExpressBooking({ record, racingOnly: kind === "racing" }),
      // VIP is per-record truth off the group's own combo stamp — today only
      // the VIP packs set combo_special_id (admin board uses the same read).
      vip: !!g.comboSpecialId,
    });
  }
  return out;
}

// ── OTP to the booking contact (browse path) ─────────────────────────────────
export async function resolveContactPhone(billId: string): Promise<string | null> {
  const summary = await loadSummary(billId);
  const fromRecord = summary?.record?.contact?.phone;
  const fromNeon = summary?.moneyGroup.find((r) => r.guestPhone)?.guestPhone;
  const phone = (fromRecord || fromNeon || "").trim();
  return phone ? phone : null;
}

export function maskPhone(phone: string): string {
  const d = last10(phone);
  return d.length === 10 ? `(${d.slice(0, 3)}) •••-••${d.slice(-2)}` : "your number on file";
}

export async function sendContactOtp(
  billId: string,
  last4?: string,
): Promise<{ ok: boolean; mask?: string; reason?: "no-contact" | "rate-limited" | "mismatch" }> {
  const phone = await resolveContactPhone(billId);
  if (!phone) return { ok: false, reason: "no-contact" };
  // Ownership gate (owner 2026-07-25): the tapper must know the last 4 digits of
  // the number on file before any text goes out — so a browse tap can't
  // blind-OTP an arbitrary guest. Only a match/no-match is revealed, never the
  // number, and it's checked BEFORE the cooldown so a wrong guess never burns
  // the real owner's send window.
  const digits = phone.replace(/\D/g, "");
  const given = (last4 ?? "").replace(/\D/g, "").slice(-4);
  if (given.length < 4 || digits.slice(-4) !== given) {
    return { ok: false, reason: "mismatch" };
  }
  // Per-reservation cooldown (anti-griefing against every booking's contact).
  const cd = await redis
    .set(`checkin:otp:cd:${billId}`, "1", "EX", OTP_COOLDOWN, "NX")
    .catch(() => "OK");
  if (cd === null) return { ok: false, reason: "rate-limited" };
  // Reuse the one OTP implementation (server-to-server; the guest never sees
  // the number). HeadPinz sender via `from`. Report a REAL failure so the UI
  // doesn't advance to code entry when no code was actually sent.
  let sent = false;
  try {
    const res = await fetch(`${SITE}/api/sms-verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, from: "+12393022155" }),
    });
    const data = (await res.json().catch(() => ({}))) as { sent?: boolean };
    sent = res.ok && data.sent === true;
  } catch {
    sent = false;
  }
  if (!sent) {
    // Release the cooldown so a retry can send.
    await redis.del(`checkin:otp:cd:${billId}`).catch(() => {});
    return { ok: false, reason: "no-contact" };
  }
  return { ok: true, mask: maskPhone(phone) };
}

export async function confirmContactOtp(
  billId: string,
  center: CenterSlug,
  code: string,
): Promise<{ ok: boolean; proofToken?: string; attemptsLeft?: number }> {
  const phone = await resolveContactPhone(billId);
  if (!phone) return { ok: false };
  try {
    const res = await fetch(`${SITE}/api/sms-verify`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, code }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      verified?: boolean;
      attemptsLeft?: number;
    };
    if (data.verified) {
      const proofToken = await mintProof(billId, center, "browse-otp");
      return { ok: true, proofToken };
    }
    return { ok: false, attemptsLeft: data.attemptsLeft };
  } catch {
    return { ok: false };
  }
}

// ── itinerary envelope (proof-gated) ─────────────────────────────────────────
function attractionMeta(slug: string): AttractionMeta | null {
  const cfg = ATTRACTIONS[slug];
  return cfg ? { name: cfg.name, building: cfg.building } : null;
}

function racingBuildingFor(center: CenterSlug): string {
  return center === "naples" ? "HeadPinz Naples" : "FastTrax Racing";
}
function bowlingBuildingFor(center: CenterSlug): string {
  return center === "naples" ? "HeadPinz Naples" : "HeadPinz Fort Myers";
}

export async function buildItinerary(
  billId: string,
  center: CenterSlug,
): Promise<CheckinItinerary> {
  const summary = await loadSummary(billId);
  if (!summary) {
    return emptyItinerary(center, "not-found");
  }
  if (summary.cancelled) {
    return emptyItinerary(center, "cancelled");
  }
  const record = summary.record;
  const group = summary.moneyGroup;
  // BEFORE anything reads the heats. A race staff moved in BMI must be
  // corrected in Neon first, or the kiosk offers a time that no longer exists
  // and the assignment fails against a heat BMI has already retimed.
  await syncRaceHeatsFromBmi(billId, summary.center, group);

  // Racing — one activity at the earliest heat. Prefer the Redis booking record
  // (carries racer names + personIds); fall back to the Neon race row's
  // booking_metadata.heats when that record is gone (eviction / failed checkout
  // POST) so the race never silently drops.
  type RacerRow = {
    name: string;
    identified: boolean;
    personId: string | null;
    waiverValid: boolean;
  };
  let racing = null as null | { startIso: string; title: string; racers: RacerRow[] };
  const recRacers = record?.racers ?? [];
  if (recRacers.length > 0) {
    const sorted = [...recRacers].sort((a, b) =>
      timeKey(a.heatStart).localeCompare(timeKey(b.heatStart)),
    );
    const first = sorted[0];
    const track = first?.track ? `${first.track} Track` : "";
    racing = {
      startIso: first?.heatStart ?? "",
      title: track ? `Race · ${track}` : "Racing",
      racers: recRacers.map((r) => ({
        name: r.racerName ? displayNameFromFull(r.racerName) : "Racer",
        identified: !!r.personId,
        personId: r.personId ?? null,
        waiverValid: false,
      })),
    };
  } else {
    const heats = neonHeats(group);
    if (heats.length > 0) {
      const sorted = [...heats].sort((a, b) => timeKey(a.heatId).localeCompare(timeKey(b.heatId)));
      const first = sorted[0];
      const track = first?.track ? `${first.track} Track` : "";
      racing = {
        startIso: first?.heatId ?? "",
        title: track ? `Race · ${track}` : "Racing",
        racers: heats.map((h) => ({
          name: h.racer ? displayNameFromFull(h.racer) : "Racer",
          identified: !!h.bmiPersonId,
          personId: h.bmiPersonId ?? null,
          waiverValid: false,
        })),
      };
    }
  }

  // Main contact — BMI adds the booker to the project, so show them on the
  // roster too (with their waiver status) even when they aren't on a heat, so
  // they can just sign if their waiver's lapsed (owner 2026-07-25). Racing only
  // (the waiver check is at the racing location); deduped against the racers.
  const racerIds = new Set(
    (racing?.racers ?? []).map((r) => r.personId).filter((x): x is string => !!x),
  );
  const mainContact =
    racing &&
    record?.contact?.firstName &&
    record.primaryPersonId &&
    !racerIds.has(record.primaryPersonId)
      ? {
          name: displayNameFromFull(
            `${record.contact.firstName} ${record.contact.lastName ?? ""}`.trim(),
          ),
          personId: record.primaryPersonId,
        }
      : null;

  // Pull in existing valid waivers from the project (owner 2026-07-25): an
  // identified racer (or the main contact) whose Pandora waiver is still current
  // is ready and needs no re-sign. Best-effort + parallel; a failed/unknown
  // lookup leaves them as "needs a waiver" (the safe default, no regression).
  const waiverBy = await checkRacerWaivers([
    ...(racing?.racers ?? []).map((r) => r.personId),
    mainContact?.personId ?? null,
  ]);
  if (racing) {
    for (const r of racing.racers) {
      r.waiverValid = r.personId ? (waiverBy.get(r.personId) ?? false) : false;
    }
  }

  const attractions = (record?.attractions ?? []).map((a) => ({
    slug: a.slug ?? "",
    startIso: a.slot || (a.date ? `${a.date}T00:00:00` : ""),
    qtyPaid: a.qty ?? 1,
    readyCount: 0, // waiver readiness is a PR2 concern (party panel)
  }));

  const bowling = group.filter(isBowlingRow).map((r) => ({
    kind: (r.productKind === "kbf" ? "kbf" : "bowling") as "bowling" | "kbf",
    // Normalize the Neon TIMESTAMPTZ (UTC-Z) to ET wall-clock before display.
    startIso: toEtWallClock(r.eventAt || r.bookedAt),
    playerCount: r.playerCount ?? 0,
    laneLabel: r.dayofOrderLane ? `Lane ${r.dayofOrderLane}` : undefined,
    neonReservationId: r.id,
    // Kiosk bowler-details check-in (names/shoes/bumpers) — HeadPinz lanes
    // only, never FT duckpin (owner rule 2026-08-16). Cancelled legs are
    // display-only either way.
    checkinEligible: r.status !== "cancelled" && isKioskBowlingRow(r),
  }));

  const { activities, firstStop } = assembleItinerary({
    racing,
    attractions,
    bowling,
    meta: attractionMeta,
    racingBuilding: racingBuildingFor(center),
    bowlingBuilding: bowlingBuildingFor(center),
  });

  // Display-only balance: total − deposit across the (non-cancelled) group.
  const live = group.filter((r) => r.status !== "cancelled");
  const totalCents = live.reduce((s, r) => s + (r.totalCents || 0), 0);
  const depositCents = live.reduce((s, r) => s + (r.depositCents || 0), 0);
  const dueAtCenterCents = Math.max(0, totalCents - depositCents);

  // Read-only party panel: the main contact (booker) first, then the IDENTIFIED
  // racers. Unfilled slots carry category PLACEHOLDER names ("Adult 1",
  // "Junior 1") that must never render as roster members — they're handled by
  // the "Who's racing?" assignment step. waiverValid is pulled from the
  // project's Pandora waivers so a lapsed waiver shows as still-needed.
  const roster: CheckinRosterPerson[] = [
    ...(mainContact
      ? [
          {
            personId: null,
            pandoraPersonId: null,
            displayName: mainContact.name,
            waiverValid: waiverBy.get(mainContact.personId) ?? false,
            boundTo: ["Main contact"],
          },
        ]
      : []),
    ...(racing?.racers ?? [])
      .filter((r) => r.identified)
      .map((r) => ({
        personId: null,
        pandoraPersonId: null,
        displayName: r.name,
        waiverValid: r.waiverValid,
        boundTo: ["Racing"],
      })),
  ];

  const firstName = record?.contact?.firstName || (summary.label.split(" ")[0] ?? "there");

  return {
    ok: true,
    reservationNumber:
      record?.reservationNumber ??
      group.find((r) => r.bmiReservationNumber)?.bmiReservationNumber ??
      null,
    center,
    firstName,
    activities,
    firstStop,
    roster,
    raceSlots: buildRaceSlots(group),
    dueAtCenterCents,
    // Live express truth — we've already paid for the per-racer Pandora waiver
    // read above, so this is stricter than the browse list's booking-time flag
    // and catches a waiver that lapsed since booking. True → the flow shows the
    // guest where to go instead of walking them through check-in.
    express: isExpressRoster({
      racers: racing?.racers ?? [],
      racingOnly: !!racing && bowling.length === 0 && attractions.length === 0,
    }),
  };
}

function emptyItinerary(center: CenterSlug, reason: CheckinItinerary["reason"]): CheckinItinerary {
  return {
    ok: false,
    reservationNumber: null,
    center,
    firstName: "",
    activities: [],
    firstStop: null,
    roster: [],
    raceSlots: [],
    dueAtCenterCents: 0,
    express: false,
    reason,
  };
}

// ── party bind (PR2 — attach the added party to the reservation) ─────────────
/**
 * Attach the ready party members to an existing reservation as BMI
 * projectPersons, persisting to Neon FIRST (house hard rule) so an attach
 * failure never loses the record. This is the SAME proven primitive the
 * group-waiver flow uses (registerProjectPersonServer, behind
 * KIOSK_WAIVER_BMI_ATTACH); billId is passed as the public-booking "orderId"
 * exactly as the staff edit engine's late-add does (bmi-sync). Only people who
 * are actually playing reach here — signer-only guardians live in
 * session.guardians and are never in the party the client sends.
 *
 * PR2 stops at attach (roster + waiver %). Heat/lane assignment, Pandora
 * session scheduling, and the -5 Arrived stamp are PR3.
 */
export async function bindPartyMembers(args: {
  billId: string;
  center: CenterSlug;
  kioskId?: string | null;
  verifiedVia: CheckinVerifiedVia;
  members: CheckinBindMember[];
}): Promise<{ ok: boolean; results: CheckinBindResult[] }> {
  const businessDate = todayET();
  const event = await openCheckinEvent({
    billId: args.billId,
    center: args.center,
    kioskId: args.kioskId ?? null,
    verifiedVia: args.verifiedVia,
    businessDate,
  });
  const clientKey = bmiClientKeyFor(args.center);
  // Bowl keys have no BMI project to attach to — the client never sends
  // members for a bowling-only check-in, but if one ever arrives, persist to
  // Neon and skip the BMI write rather than POSTing a non-bill orderId.
  const attachEnabled = kioskCheckinAttachEnabled() && !isBowlKey(args.billId);
  const results: CheckinBindResult[] = [];

  for (const m of args.members) {
    // Ready players only (identified + waivered) — mirrors the people step's
    // peopleReady gate; anything else the client shouldn't have sent.
    if (!m.bmiPersonId || !m.waiverValid) continue;
    const displayName = m.firstName ? makeDisplayName(m.firstName, m.lastName ?? "") : "Guest";
    const slotKey = m.pandoraPersonId || m.bmiPersonId;

    // Neon FIRST — never gated on the external attach.
    const row = event
      ? await upsertCheckinPerson({
          eventId: event.id,
          slotKey,
          personId: m.bmiPersonId,
          pandoraPersonId: m.pandoraPersonId ?? null,
          displayName,
          firstName: m.firstName,
          lastName: m.lastName ?? null,
          waiverValid: true,
        })
      : null;

    // Re-attach guard (mirrors the group-waiver route): the Neon row carries
    // the prior status across reloads / return visits, so an already-attached
    // person is never re-POSTed — no duplicate projectPerson, no
    // attached→failed status downgrade. Durable, unlike the client's boundIds.
    if (row?.bmiAttachStatus === "attached") {
      results.push({ displayName, attach: "attached" });
      continue;
    }

    let attach: CheckinBindResult["attach"] = "skipped";
    // Persist-first house rule: only write to BMI once we have a durable Neon
    // row. If the DB is unavailable (event/row null) we do NOT fire a BMI write
    // that would leave no recoverable record.
    if (attachEnabled && row) {
      try {
        const res = await registerProjectPersonServer({
          clientKey,
          // A BILL id — which is what the public-booking endpoint means by orderId.
          // This flow is the PROVEN one (it already adds people at check-in); the
          // parameter was renamed from `projectId` to `orderId` so it stops implying
          // otherwise. Behaviour here is unchanged.
          orderId: args.billId,
          personId: m.bmiPersonId,
          firstName: m.firstName,
          lastName: m.lastName ?? "",
        });
        attach = res.ok ? "attached" : "failed";
      } catch {
        attach = "failed";
      }
      await setCheckinPersonStatus(row.id, {
        bmiAttachStatus: attach,
        error:
          attach === "failed" ? { step: "attach", message: "registerProjectPerson failed" } : null,
      });
    }
    results.push({ displayName, attach });
  }

  return { ok: true, results };
}

// ── complete ("check in everyone") — PR3 finalize ────────────────────────────
// Comfortably longer than the worst-case finalize (one ~10s schedule POST per
// id-batch + the state stamp's confirm reads + the memo round trips) so a
// "busy, tap again" retry can't acquire a prematurely-expired lock and re-run
// the pipeline. The old 34s straggler ladder is gone — sync-lag retries live in
// the kiosk-bmi-sync-sweep cron now, not in this request.
const LOCK_TTL = 150; // seconds — single-flight per billId

/** Best-effort single-flight lock. Returns a release fn, or null if held. */
async function acquireBillLock(billId: string): Promise<null | (() => Promise<void>)> {
  const key = `checkin:lock:${billId}`;
  const token = newToken();
  try {
    const ok = await redis.set(key, token, "EX", LOCK_TTL, "NX");
    if (ok === null) return null;
    return async () => {
      // Only release if we still own it.
      try {
        const cur = await redis.get(key);
        if (cur === token) await redis.del(key);
      } catch {
        /* lock self-expires */
      }
    };
  } catch {
    // Redis down — proceed without a lock (the DB unique keys are the backstop).
    return async () => {};
  }
}

function etTimeLabel(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(Date.now());
}

/** Already on the Pandora session — either we inserted them or Pandora said
 *  they were linked. Both mean "do not seat this person again". */
function isScheduled(status: string): boolean {
  return status === "inserted" || status === "already_linked";
}

export interface CompleteResult {
  ok: boolean;
  alreadyComplete?: boolean;
  /** True when this call finalized people added AFTER an earlier finalize —
   *  the late half of a party checking in separately. */
  resumed?: boolean;
  /** Guest-facing count: persons confirmed on the session PLUS persons queued
   *  as 'waiting-sync' (the sweep seats those within minutes — owner 2026-08-12:
   *  count everyone at the done screen). */
  scheduled?: number;
  /** How many of `scheduled` are still queued (observability; the kiosk UI
   *  does not surface this). */
  schedulePending?: number;
  scheduleUnlinked?: string[];
  stateStamped?: boolean;
  /** True when the "Confirmation Kiosk"/VIP state stamp was QUEUED behind the
   *  party-ready barrier (whole party synced + waivers verified). The state
   *  arriving in BMI is the signal that the on-site sync finished — owner
   *  2026-08-12: "state arriving later would be fine and would show sync is
   *  done". */
  stateQueued?: boolean;
  laneOpenEnabled?: boolean;
  reason?: "cancelled" | "busy";
}

/**
 * Finalize check-in for the whole party. Assigns the added people to the
 * reservation's open heat slots — by the guest's explicit person→slot choice
 * (`assignments`, class-validated client-side) when provided, else the legacy
 * earliest-first positional auto-assign — schedules them onto the Pandora
 * session, stamps the BMI project to the "Confirmation Kiosk" custom state, and
 * writes the staff memo. All external writes (schedule / state / memo) are gated
 * behind the KIOSK_CHECKIN_BMI_ATTACH kill switch (default ON — set "0" to go
 * dark); the local event/record stamps always run. Idempotent: a completed
 * event returns alreadyComplete without re-writing.
 *
 * The schedule step makes ONE fast attempt; anything Pandora reports as
 * retryable (person_not_on_project — the cloud attach hasn't synced down yet)
 * is recorded 'waiting-sync' and seated by the kiosk-bmi-sync-sweep cron over
 * the following minutes. The guest is never held at the kiosk waiting on sync.
 */
export async function completeCheckin(args: {
  billId: string;
  center: CenterSlug;
  kioskId?: string | null;
  verifiedVia: CheckinVerifiedVia;
  /** Guest's person→slot choices (racing). Empty → legacy auto-assign. */
  assignments?: CheckinSlotAssignment[];
}): Promise<CompleteResult> {
  const { billId, center } = args;
  const businessDate = todayET();

  const release = await acquireBillLock(billId);
  if (!release) return { ok: false, reason: "busy" };

  try {
    const summary = await loadSummary(billId);
    if (summary?.cancelled) return { ok: false, reason: "cancelled" };

    const event = await openCheckinEvent({
      billId,
      center,
      kioskId: args.kioskId ?? null,
      verifiedVia: args.verifiedVia,
      businessDate,
    });
    // RESUMABLE, not terminal. `completed_at` used to end this reservation's
    // check-in for the whole business day: a second group arriving later still
    // got bound to BMI by /checkin/join (which has no completed-check), but
    // /complete short-circuited here — so they were never seated on a heat,
    // never scheduled onto the Pandora session, no memo, no re-stamp — and the
    // done screen still looked right because the count returned was the FIRST
    // group's. Now a replay with nothing new still returns alreadyComplete
    // (double-tap / resolved busy-retry), but a replay carrying people who were
    // never scheduled runs the pipeline for THOSE people only.
    // ALWAYS TRY TO ASSIGN when the guest has explicitly said who drives what
    // (owner 2026-08-07: "you just need to make sure it always tries to assign
    // regardless"). This is computed HERE, above the short-circuit, because the
    // short-circuit is what silently swallowed a whole check-in: every row said
    // 'inserted' from an earlier pass, `pending` came out empty, and the
    // function returned `alreadyComplete` reporting the OLD inserted count — the
    // "3 racers added" the kiosk showed while Pandora had none of them. The
    // pipeline never ran, and the fix further down never got reached.
    //
    // Safe to re-run: the Pandora insert is idempotent, proven directly against
    // the endpoint on this very reservation.
    const explicitAssignments = (args.assignments ?? []).filter((a) => a?.slotKey && a?.personId);
    const hasExplicit = explicitAssignments.length > 0;

    let resuming = false;
    if (event) {
      const existing = await getCheckinEvent(billId, businessDate);
      if (existing?.completedAt) {
        const priorPeople = await listCheckinPeople(event.id);
        const pending = priorPeople.filter((p) => !isScheduled(p.scheduleStatus));
        if (pending.length === 0 && !hasExplicit) {
          return {
            ok: true,
            alreadyComplete: true,
            scheduled: priorPeople.filter((p) => p.scheduleStatus === "inserted").length,
            stateStamped: existing.bmiStateStatus === "set",
            laneOpenEnabled: kioskCheckinAttachEnabled(),
          };
        }
        resuming = true;
        console.warn(
          `[kiosk-checkin] ${billId}: resuming a completed check-in — ` +
            `${pending.length} person(s) added after the first finalize`,
        );
      }
    }

    const group = summary?.moneyGroup ?? [];
    const record = summary?.record ?? null;
    const heats = neonHeats(group);
    const hasRacing = heats.length > 0 || (record?.racers?.length ?? 0) > 0;
    const officeProjectId = (() => {
      try {
        return (BigInt(billId) + BigInt(1)).toString();
      } catch {
        return null;
      }
    })();
    // Racing BMI project lives on the FastTrax Pandora location; bowling/
    // attraction-only reservations use the venue slug.
    const stateCenterCode: string = hasRacing ? "fasttrax" : center;

    const attachEnabled = kioskCheckinAttachEnabled();
    const allPeople = event ? await listCheckinPeople(event.id) : [];

    // AN EXPLICIT ASSIGNMENT IS THE DESIRED END STATE — reconcile to it.
    //
    // `schedule_status` is OUR record, and it goes stale the moment staff
    // change the grid in BMI. Live on W58723: both racers were unassigned in
    // BMI, our rows still said 'inserted', so the filter below removed everyone
    // and check-in submitted NOBODY — it silently trusted itself over BMI, the
    // same mistake as the roster and the heat times.
    //
    // When the guest has explicitly said who drives what, that IS the answer:
    // seat exactly them, whatever we previously recorded. Safe because the
    // Pandora insert is idempotent — a racer genuinely still on the session
    // comes back `already_linked` and nothing is duplicated (proven live:
    // POST /bmi/schedule returned inserted:1 for a racer we had already
    // marked inserted). The stale-status filter survives only for the LEGACY
    // positional path, where nobody stated an intent and re-seating really
    // could double up.
    const people = hasExplicit
      ? allPeople
      : allPeople.filter((p) => !isScheduled(p.scheduleStatus));
    // Seats consumed by an EARLIER pass, so a resume places new arrivals in
    // what's genuinely left. Not applied to an explicit assignment: the guest's
    // slot choices already say which seat each racer takes.
    const priorBoundHeats: NeonHeat[] = hasExplicit
      ? []
      : allPeople
          .filter((p) => isScheduled(p.scheduleStatus))
          .flatMap((p) => (Array.isArray(p.boundHeats) ? (p.boundHeats as NeonHeat[]) : []));

    let scheduled = 0;
    // Names we must flag to staff: TERMINAL failures only — people with no
    // resolved short id, a vendor refusal, or no open slot. Sync-lag racers are
    // NOT in here: they go to `waitingNames` and the kiosk-bmi-sync-sweep cron
    // auto-seats them (memoing staff would send them to hand-seat in the local
    // client, which is what created the duplicate-projectPerson WSync jams).
    const memoFailures: string[] = [];
    // Racers handed to the sync sweep ('waiting-sync') — counted as checked in
    // for the guest (owner 2026-08-12: count everyone, say nothing extra).
    const waitingNames: string[] = [];
    const unplaced: string[] = [];
    // Persons CONFIRMED on the session this call — the staff memo's honest count
    // (guest-facing `scheduled` adds the syncing ones on top).
    let scheduledLinked = 0;
    /** The state stamp is no longer done here — it is QUEUED behind the
     *  party-ready barrier and lands once everyone is synced and waivered. This
     *  records that the followup was accepted, not that BMI shows the state. */
    let stateQueued = false;
    /**
     * The racer→heat pairs this check-in actually bound, hoisted out of the
     * scheduling block because the state stamp below needs them: the
     * "Confirmation - Express" flip waits on these seats being on the GRID, not
     * merely on the party being local and waivered. Empty for a check-in with no
     * racing seats, which degrades the gate to plain party-ready.
     */
    const seatRefs: Array<{ personId: string; heatStart: string }> = [];

    if (attachEnabled && hasRacing) {
      // Assign the added people to open heat slots (no bmiPersonId). The guest's
      // explicit person→slot choices (class-validated at the kiosk) win; without
      // them we fall back to the legacy earliest-first positional auto-assign.
      // Seat-unique slotKey → heat (two racers in one heat are distinct slots),
      // minus the seats an earlier pass already filled (consumePriorSeats — a
      // multiset take, so a 2-seat heat with 1 prior racer keeps 1 seat free).
      const freeEntries = consumePriorSeats(
        buildRaceSlotEntries(group).filter((e) => !e.heat.bmiPersonId),
        priorBoundHeats,
      );
      const openBySlotKey = new Map(freeEntries.map((e) => [e.slot.slotKey, e.heat]));
      // The legacy positional path reads this list; it must see the SAME seats
      // as the map above or a resume would double-seat through the fallback.
      const openHeats = freeEntries.map((e) => e.heat).filter((h) => h.heatId);
      // Match an assignment's personId against either id the person row carries.
      const personByIdKey = new Map<string, (typeof people)[number]>();
      for (const p of people) {
        if (p.pandoraPersonId) personByIdKey.set(p.pandoraPersonId, p);
        if (p.personId) personByIdKey.set(p.personId, p);
      }

      const racers: ScheduleRacer[] = [];
      // personId here is the SHORT Pandora id ONLY — a 17-digit Office id 500s
      // the whole batch, so anyone without a resolved short id is isolated to
      // the memo instead of being POSTed (review H1).
      const bound: { personRowId: number; personId: string }[] = [];
      const usedSlotKeys = new Set<string>();
      // A person may take SEVERAL slots (multi-race bookings — e.g. a red then
      // a blue race), subject to web booking's per-racer heat-spacing rules
      // (heatsConflict: same-track heats skip the adjacent slot, cross-track
      // needs the 30-min walk buffer). Checked against BOTH the heats seated
      // this call AND heats already filled at booking time that belong to the
      // same person (matched on either id, mirroring findCrossBookingConflict).
      const prefilled = heats.filter((h) => h.bmiPersonId && h.heatId);
      const heatsByPerson = new Map<number, NeonHeat[]>();
      const violatesSpacing = (p: (typeof people)[number], heat: NeonHeat): boolean => {
        const ms = Date.parse(String(heat.heatId).replace(/Z$/, ""));
        if (!Number.isFinite(ms)) return true;
        const mine = [
          ...(heatsByPerson.get(p.id) ?? []),
          ...prefilled.filter(
            (h) => h.bmiPersonId === p.personId || h.bmiPersonId === p.pandoraPersonId,
          ),
        ];
        return mine.some((h) => {
          const hMs = Date.parse(String(h.heatId).replace(/Z$/, ""));
          return (
            !Number.isFinite(hMs) || heatsConflict(hMs, h.track ?? null, ms, heat.track ?? null)
          );
        });
      };

      // Place one person on one open heat: build the schedule row from the
      // slot's own product, and persist the binding (boundHeats) Neon-first.
      // Multi-slot people upsert their FULL accumulated heat list each time
      // (the upsert REPLACES bound_heats, so a partial list would drop heats).
      const assignToSlot = async (p: (typeof people)[number], heat: NeonHeat): Promise<void> => {
        const name = p.firstName || p.displayName || "Racer";
        // A schedulable id is a SHORT Pandora id, or an Office id whose record
        // has been REPAIRED (birthdate written, Pandora resolving it) — Set up
        // adopts that id as pandoraPersonId precisely because Pandora answers
        // for it. The two are posted in separate batches below, so an Office id
        // the endpoint still refuses cannot cost anyone else their seat.
        const schedulableId = p.pandoraPersonId || p.personId;
        if (!schedulableId) {
          // Nothing usable at all — flag for the desk, don't poison the batch.
          memoFailures.push(name);
          await setCheckinPersonStatus(p.id, { scheduleStatus: "failed" });
          return;
        }
        const productId = heat.productId ?? null;
        const product = productId ? getRaceProductById(productId) : null;
        racers.push({
          racerName: name,
          personId: schedulableId,
          // The id we did NOT post under. The cloud roster may list this human
          // under either form, and the guard must not read "absent" merely
          // because the roster used the other one.
          altPersonId: schedulableId === p.pandoraPersonId ? p.personId : p.pandoraPersonId,
          product: product?.name ?? "Race",
          productId,
          tier: heat.tier || product?.tier || "starter",
          track: (heat.track as ScheduleRacer["track"]) ?? null,
          category: heat.category || product?.category || "adult",
          heatName: product?.name ?? "Race",
          heatStart: heat.heatId as string,
          heatStop: heatStopFor(heat.heatId as string),
        });
        if (!bound.some((b) => b.personRowId === p.id)) {
          bound.push({ personRowId: p.id, personId: schedulableId });
        }
        seatRefs.push({ personId: schedulableId, heatStart: heat.heatId as string });
        const personHeats = heatsByPerson.get(p.id) ?? [];
        personHeats.push(heat);
        heatsByPerson.set(p.id, personHeats);
        if (event) {
          await upsertCheckinPerson({
            eventId: event.id,
            slotKey: p.slotKey,
            displayName: p.displayName,
            boundHeats: personHeats,
          });
        }
      };

      const assignments = explicitAssignments;
      if (assignments.length > 0) {
        // Explicit guest choice, keyed by the seat-unique slotKey. First
        // assignment per slot wins; a filled/unknown slot, an unknown person,
        // or a heat too close to one the person already holds (the web
        // spacing rules — the kiosk picker enforces the same) is skipped.
        // Unassigned bound people are deliberately not racing.
        for (const a of assignments) {
          if (usedSlotKeys.has(a.slotKey)) continue;
          const heat = openBySlotKey.get(a.slotKey);
          const p = personByIdKey.get(a.personId);
          if (!heat || !p) continue;
          if (violatesSpacing(p, heat)) {
            // The kiosk picker enforces the same rules, so this only fires on a
            // stale/forged payload or a pre-filled-heat collision — flag for the
            // desk rather than silently leaving the seat empty.
            console.warn(
              `[kiosk-checkin] ${billId}: assignment ${a.slotKey} skipped — violates heat spacing for ${p.displayName}`,
            );
            memoFailures.push(p.firstName || p.displayName || "Racer");
            continue;
          }
          // Class guard (defense in depth — the picker already filters by class):
          // a stated racer class must match the slot's class, else don't seat them.
          const prod = heat.productId ? getRaceProductById(heat.productId) : null;
          const slotCat = heat.category || prod?.category || "adult";
          if (a.category && a.category !== slotCat) {
            memoFailures.push(p.firstName || p.displayName || "Racer");
            continue;
          }
          usedSlotKeys.add(a.slotKey);
          await assignToSlot(p, heat);
        }
      } else {
        // Legacy fallback: earliest-heat-first, positional (person i → slot i),
        // no class match — preserved for callers that don't send assignments.
        const openSlots = [...openHeats].sort((a, b) =>
          timeKey(a.heatId).localeCompare(timeKey(b.heatId)),
        );
        for (let i = 0; i < people.length; i++) {
          const slot = openSlots[i];
          if (!slot) {
            unplaced.push(people[i].firstName || people[i].displayName || "Racer");
            continue;
          }
          await assignToSlot(people[i], slot);
        }
      }

      const reservationNumber =
        record?.reservationNumber ??
        group.find((r) => r.bmiReservationNumber)?.bmiReservationNumber ??
        "";

      if (racers.length > 0) {
        /**
         * Read the CLOUD roster ONCE for the whole schedule pass.
         *
         * Racers the cloud no longer carries are held back rather than posted —
         * Pandora would resolve their project-person from the center's stale
         * LOCAL copy and write a participant that orphans the moment the delete
         * syncs down, wedging Fast WSync's upload batch (2026-08-16,
         * T_PARTICIPANT 58922217). See projectRosterCloudBarrier.
         *
         * A roster we cannot READ yields null, and null disables the guard: an
         * Office hiccup must never stop a check-in. Held racers are classified
         * WAITING, so the sweep re-attaches and re-seats them.
         */
        let cloudRoster: ReadonlySet<string> | null = null;
        if (officeProjectId) {
          try {
            const { projectRosterCloudBarrier } = await import("@/lib/bmi-sync-barriers");
            const roster = await projectRosterCloudBarrier(
              bmiClientKeyFor(center),
              officeProjectId,
            );
            cloudRoster = roster.verdict === "open" ? roster.personIds : null;
            console.log(
              `[kiosk-checkin] ${billId}: cloud roster ${roster.verdict} — ${roster.detail}`,
            );
          } catch (err) {
            console.error("[kiosk-checkin] cloud roster read failed (guard off):", err);
          }
        }

        // TWO BATCHES, deliberately. One bad id fails the WHOLE Pandora batch
        // (schedule-racers header, W52109), so a racer riding a 17-digit Office
        // id must never share a post with the known-good short ids.
        //
        // They can now be here at all because a repaired person (birthdate
        // written, record resolving in Pandora) adopts its own id as the
        // schedulable one. Whether /bmi/schedule tolerates that id is UNPROVEN
        // — the W52109 note predates the discovery that the 500 was a null-DOB
        // response-validation error, so it may have been this same red herring.
        // Isolating them means we find out for free: if the endpoint accepts
        // them the racer gets on the grid, and if it refuses, only that batch
        // fails and everyone else is already seated.
        const isShortId = (id: string | null) => !!id && id.length < 15;
        const shortBatch = racers.filter((r) => isShortId(r.personId));
        const officeBatch = racers.filter((r) => !isShortId(r.personId));

        const outcomes: RacerOutcome[] = [];
        for (const [label, batch] of [
          ["short", shortBatch],
          ["office-id", officeBatch],
        ] as const) {
          if (batch.length === 0) continue;
          const part = await scheduleCheckinRacers({
            reservationNumber,
            racers: batch,
            cloudRoster,
          });
          outcomes.push(...part.outcomes);
          if (label === "office-id") {
            console.warn(
              `[kiosk-checkin] ${reservationNumber}: repaired-id batch scheduled ` +
                `${part.linked}/${batch.length}` +
                (part.unlinked.length > 0 ? ` — unlinked: ${part.unlinked.join(", ")}` : ""),
            );
          }
        }
        // Per-person verdict across that person's heats, matched by personId
        // (never by name — duplicate first names would collide, review L6).
        // Any REFUSED heat is terminal (desk memo); otherwise any WAITING heat
        // hands the person to the kiosk-bmi-sync-sweep cron ('waiting-sync' —
        // the vendor's own "retryable, NOT failed"); all-linked is done.
        let refusedPersons = 0;
        for (const b of bound) {
          const mine = outcomes.filter((o) => o.personId === b.personId);
          if (mine.length === 0) continue;
          const name = mine[0].racerName;
          const refused = mine.find((o) => o.kind === "refused");
          const waiting = mine.find((o) => o.kind === "waiting");
          if (refused) {
            refusedPersons++;
            memoFailures.push(name);
            await setCheckinPersonStatus(b.personRowId, {
              scheduleStatus: "failed",
              error: { step: "schedule", message: `refused: ${refused.vendorStatus}` },
            });
          } else if (waiting) {
            waitingNames.push(name);
            await setCheckinPersonStatus(b.personRowId, {
              scheduleStatus: "waiting-sync",
              error: {
                step: "schedule",
                message: `retryable: ${waiting.vendorStatus} — kiosk-bmi-sync-sweep re-seats`,
              },
            });
          } else {
            scheduledLinked++;
            await setCheckinPersonStatus(b.personRowId, { scheduleStatus: "inserted" });
          }
        }
        // Guest-facing count includes the queued seats (owner 2026-08-12) —
        // they auto-land within minutes, well before the heat; the memo below
        // keeps the linked-vs-syncing split honest for staff.
        scheduled = scheduledLinked + waitingNames.length;
        console.log(
          `[kiosk-checkin] ${reservationNumber}: scheduled ${scheduledLinked} person(s), ` +
            `${waitingNames.length} waiting on sync, ${refusedPersons} refused ` +
            `(${outcomes.length} racer-heat pairs attempted)`,
        );
      }
    }

    // "Confirmation Kiosk" custom state — the staff-visible "party is here and
    // checked in" signal, the SAME state the kiosk post-reserve rail and
    // express-lane web bookings land in (owner 2026-07-24, superseding -5).
    // Unlike -5 "Arrived", this is NOT an arrival state, so it does not trigger
    // race-dayof-pay to settle the day-of order early. Custom ids (no leading
    // "-") go Office-API-first in setProjectState; Pandora 200-no-ops them.
    //
    // An Ultimate VIP Experience stays in "Confirmation - VIP" through check-in
    // (owner 2026-08-02: VIP wins over kiosk wherever they collide). The party's
    // waivers-signed / here-now fact still lands in the composed staff memo
    // below, which is written on the same rail either way.
    const comboSpecialId = group.find((r) => r.comboSpecialId)?.comboSpecialId ?? null;
    const kioskStateId = KIOSK_CONFIRMATION_STATE_IDS[stateCenterCode];
    /**
     * THE STATE IS NOW SYNC-GATED (owner 2026-08-12): "the flip from confirmation
     * to confirmation (kiosk - express) should happen only when the rest of the
     * party has sync'ed and we have verified all have the waivers."
     *
     * It used to be stamped right here, unconditionally — which made it a claim
     * about work that had not finished. Staff read "Confirmation Kiosk" as "this
     * party is here and checked in", so a stamp landing while a racer was still
     * invisible on the center's server (or unwaivered) said something we could
     * not back.
     *
     * So the stamp becomes a queue row behind the `party-ready` barrier: every
     * member local AND holding a valid waiver. It therefore arrives LATER, and
     * that is the feature — owner: "state arriving later would be fine and would
     * show sync is done". A reservation that never flips is now a visible signal
     * (the board's on-site pill and the BMI sync panel) instead of a wrong state.
     *
     * The party we verify is the people this check-in actually bound, keyed on
     * the id Pandora can answer for (short id first, Office id as fallback).
     */
    if (attachEnabled && hasRacing && officeProjectId) {
      const partyIds = [
        ...new Set(
          allPeople.map((p) => p.pandoraPersonId || p.personId).filter((v): v is string => !!v),
        ),
      ];
      const isVip = isVipComboBooking(comboSpecialId);
      if (partyIds.length === 0) {
        console.warn(
          `[kiosk-checkin] ${billId}: no resolvable party ids — state stamp NOT queued (nothing to verify)`,
        );
      } else if (!isVip && !kioskStateId) {
        console.warn(`[kiosk-checkin] no kiosk state id for ${stateCenterCode} — stamp skipped`);
      } else {
        try {
          const { enqueueSync } = await import("@/lib/bmi-sync-queue");
          await enqueueSync({
            kind: "stamp-confirmation-state",
            // Per reservation per business day: a resumed check-in refreshes the
            // party list rather than queuing a second stamp.
            idempotencyKey: `state-stamp:${billId}:${businessDate}`,
            /**
             * party-SEATED, not party-ready (owner 2026-08-16): staff read this
             * state as "here and checked in", and a party whose racers are not
             * yet on the grid is not checked in. party-seated is party-ready
             * PLUS every seat in `seats` verified against Pandora's session
             * participants — the grid itself, never our own `schedule_status`,
             * which goes stale the moment staff hand-seat someone and would
             * otherwise turn this gate into a permanent block.
             *
             * DEPLOY ORDER MATTERS. Preview and production share the
             * `bmi_sync_queue` table, and a consumer that does not recognise a
             * barrier name burns the row's attempts (row #170, 2026-08-13). The
             * consumer half — the barrier, the `SyncBarrier` union, and the
             * `probeBarrier` dispatch — ships in the SAME commit as this writer,
             * so production is consistent the moment it deploys. The exposure is
             * PREVIEW-ONLY and lasts until merge: a check-in run against a
             * preview URL writes a row production's older consumer cannot read.
             * Do not exercise kiosk check-in on a preview deployment of this
             * branch before it is merged and live.
             */
            barrier: "party-seated",
            barrierRef: officeProjectId,
            // Racing lives on the FastTrax Pandora location — the same one
            // schedule-racers posts to, so the party barrier probes where the
            // grid actually is.
            locationId: "LAB52GY480CJF",
            reservationRef: billId,
            payload: {
              officeProjectId,
              centerCode: stateCenterCode,
              stateId: isVip ? null : kioskStateId,
              comboSpecialId: isVip ? comboSpecialId : null,
              label: "Confirmation Kiosk (check-in, sync-gated)",
              personIds: partyIds,
              // Deduped: one racer may hold several heats, and proving the same
              // seat twice buys nothing.
              seats: [
                ...new Map(seatRefs.map((s) => [`${s.personId}|${s.heatStart}`, s])).values(),
              ],
            },
          });
          stateQueued = true;
          console.log(
            `[kiosk-checkin] ${billId}: state stamp QUEUED behind party-ready (${partyIds.length} member(s))`,
          );
        } catch (err) {
          console.error("[kiosk-checkin] could not queue the state stamp (non-fatal):", err);
        }
      }
    }

    // ONE composed staff memo (only where a BMI project exists — racing;
    // bowling/attraction-only reservations have no billId+1 project to note on).
    if (attachEnabled && hasRacing && officeProjectId) {
      const names = people.map((p) => p.displayName).join(", ") || "party";
      const couldNotAdd = [...new Set(memoFailures)];
      const syncing = [...new Set(waitingNames)];
      const note =
        `Kiosk check-in${resuming ? " (later arrivals)" : ""} ${etTimeLabel()}: ${names} — waivers ✓` +
        (scheduledLinked > 0 ? `, ${scheduledLinked} added to session` : "") +
        // Syncing ≠ failed: the sweep auto-seats these within minutes. The
        // wording matters — "please check into session" is what used to send
        // staff to hand-seat in the local client and mint the duplicate
        // projectPerson row that jams WSync. Do NOT seat these by hand unless
        // the heat is genuinely about to start.
        (syncing.length > 0
          ? ` — adding to session (sync in progress, auto-retry running): ${syncing.join(", ")}. ` +
            `No action needed unless the heat is about to start.`
          : "") +
        (couldNotAdd.length > 0 ? ` — COULD NOT add to session: ${couldNotAdd.join(", ")}` : "") +
        (unplaced.length > 0
          ? ` — no open slot for: ${unplaced.join(", ")} (needs a new booking)`
          : "");
      try {
        await appendProjectPrivateNote({
          centerCode: stateCenterCode,
          projectId: officeProjectId,
          note,
          billId,
        });
      } catch (err) {
        console.error("[kiosk-checkin] check-in memo failed (non-fatal):", err);
      }
    }

    // Our own record stamp (always — benign, respects the cancelled guard).
    await stampBookingRecordCheckedIn(billId);

    if (event) {
      await completeCheckinEvent(
        event.id,
        // 'pending' is now the honest value for a racing check-in: the stamp is
        // OWED (queued behind party-ready), not set and not failed. The sync
        // queue flips BMI when the party is actually ready; the board's on-site
        // pill and the BMI sync panel are where that progress is visible.
        stateQueued ? "pending" : attachEnabled && hasRacing ? "failed" : "pending",
      );
    }

    // Tell the lobby TVs a party just checked in on a kiosk. Fire-and-forget,
    // and recordSignageEvent swallows anything it can throw — a wall animation
    // must never be able to fail a check-in the guest already completed.
    void recordSignageEvent({
      id: `kiosk-checkin-${billId}-${Date.now()}`,
      kind: "checkin-completed",
      center,
      activityKeys: hasRacing ? ["racing"] : undefined,
      atMs: Date.now(),
    });

    return {
      ok: true,
      ...(resuming ? { resumed: true } : {}),
      scheduled,
      // TERMINAL failures only — the done screen's amber "needs a hand" box.
      // Sync-lag racers are deliberately absent: the sweep seats them, and
      // sending the guest to the desk is what created the hand-seat duplicates.
      scheduleUnlinked: [...new Set([...memoFailures, ...unplaced])],
      schedulePending: waitingNames.length,
      // False by design at this point — see stateQueued. Kept so callers that
      // read it keep compiling; `stateQueued` is the fact that changed.
      stateStamped: false,
      stateQueued,
      laneOpenEnabled: attachEnabled,
    };
  } finally {
    await release();
  }
}

/** Stamp kioskCheckinAt on the Redis booking record (never un-cancel it). */
async function stampBookingRecordCheckedIn(billId: string): Promise<void> {
  try {
    const raw = await redis.get(`bookingrecord:${billId}`);
    if (!raw) return;
    const rec = JSON.parse(raw) as { status?: string };
    if (rec.status === "cancelled" || rec.status === "refunded") return;
    const updated = { ...rec, kioskCheckinAt: new Date().toISOString() };
    // 90-day TTL to match the booking-record route.
    await redis.set(`bookingrecord:${billId}`, JSON.stringify(updated), "EX", 60 * 60 * 24 * 90);
  } catch {
    /* non-fatal */
  }
}

// ── voucher-QR party prefill (flag: kioskVoucherPrefillEnabled) ──────────────

/**
 * The party of a proven reservation, bind-ready — what the voucher-QR prefill
 * loads into the kiosk's roster so nobody re-types names the booking already
 * knows. Names + ids come from the Redis booking record's racers (fallback:
 * the Neon race row's booking_metadata.heats); waiver status is re-verified
 * LIVE per person (never trusted from booking time — it may have lapsed).
 *
 * PII posture: only reachable through a proofToken-gated action, the same bar
 * as the itinerary — ids flow ONLY after possession is proven. (The itinerary
 * roster itself deliberately nulls ids; this is the bind-ready counterpart.)
 */
export async function listBindableParty(
  billId: string,
): Promise<{ members: CheckinPartyMember[]; degraded: boolean }> {
  // A bowling-only reservation (bowl key) has no BMI project, no waivers and no
  // party panel — there is nobody to bind. Answer empty before any BMI math
  // (officeProjectIdFromBillId would choke on a non-numeric key).
  if (isBowlKey(billId)) return { members: [], degraded: false };
  const summary = await loadSummary(billId);
  if (!summary || summary.cancelled) return { members: [], degraded: false };

  const rows: RosterRow[] = [];

  // ── SOURCE OF RECORD FIRST ────────────────────────────────────────────────
  // BMI projectPersons decides who is on the reservation (owner 2026-08-02:
  // "it should pull every person on it"; owner 2026-08-07: "we have a BMI
  // reservation and BMA/Pandora is source of waivers"). This source was
  // historically appended LAST, and because the old dedupe resolved collisions
  // by array position, a Redis booking label with no personId outranked the
  // real registered person — W57387, where 4 registered racers with live
  // waivers rendered "Account + waiver needed". Order no longer decides the
  // winner (mergeRosterRows is order-independent), but reading the record
  // first is what makes the intent obvious.
  //
  // The FM BMI server hosts two venues, so try each of the center's locations
  // until the project answers. `degraded` distinguishes "BMI said nobody" from
  // "BMI never answered" — previously indistinguishable, and silent.
  let degraded = false;
  // Who BMI currently lists, and whether it actually answered — both needed to
  // tell "removed from the reservation" from "BMI didn't respond".
  let bmiAnswered = false;
  const bmiPersonIds = new Set<string>();
  if (summary.center) {
    const projectId = officeProjectIdFromBillId(billId);
    const locations = CENTER_TO_BMI_LOCATION_IDS[summary.center] ?? [];
    let answered = false;
    for (const locationId of locations) {
      try {
        const detail = await getReservationDetail(locationId, projectId);
        answered = true;
        const people = detail.persons_list ?? [];
        for (const p of people) {
          const full = [p.firstName ?? "", p.name ?? ""].join(" ").trim();
          const pid = String(p.personId ?? p.id ?? "") || null;
          if (pid) bmiPersonIds.add(pid);
          rows.push({ full, personId: pid, source: "bmi-project" });
        }
        if (people.length > 0) break;
      } catch {
        /* project not at this venue / BMI hiccup — try the next location */
      }
    }
    bmiAnswered = answered;
    if (locations.length > 0 && !answered) {
      degraded = true;
      console.warn(
        `[checkin] BMI roster unavailable for bill=${billId} project=${projectId} — ` +
          `falling back to booking labels only (roster may be incomplete)`,
      );
    }
  }

  // Everyone who SIGNED through the booking's /waiver link (owner 2026-08-01:
  // "this is where you pull the info from rather than asking again") — the
  // link's pid keys kiosk_waiver_joins by projectId = billId + 1, and the
  // signers arrive with real names + person ids.
  try {
    const joins = await listJoinsForProject(officeProjectIdFromBillId(billId));
    for (const j of joins) {
      // Staff removed them from the booking in BMI after we attached them —
      // our Neon row outliving that deletion is why a deleted racer reappeared
      // at the kiosk. Judged on a positive fact (we attached, BMI answered, and
      // they are not on it), never on absence alone; fails closed.
      if (
        joinWasRemovedFromBmi({
          bmiAnswered,
          bmiPersonIds,
          attachStatus: j.bmiAttachStatus,
          personId: j.personId ?? null,
        })
      ) {
        console.warn(
          `[checkin] ${billId}: "${j.displayName}" (${j.personId}) was attached but is no longer ` +
            `on the BMI project — treating as removed from the reservation`,
        );
        continue;
      }
      const full = [j.firstName ?? "", j.lastName ?? ""].join(" ").trim() || j.displayName.trim();
      rows.push({ full, personId: j.personId ?? null, source: "waiver-join" });
    }
  } catch {
    /* joins unavailable — the recorded sources still stand */
  }

  // The CAPTURE BUFFER: names typed at booking. One row per HEAT (a combo racer
  // appears twice) and `personId` is null for anyone who was never registered —
  // 77% of race racer rows, probed 2026-08-07. These fill gaps; they never
  // outrank a registered person.
  const recRacers = summary.record?.racers ?? [];
  if (recRacers.length > 0) {
    for (const r of recRacers) {
      rows.push({
        full: (r.racerName ?? "").trim(),
        personId: r.personId ?? null,
        source: "booking-label",
      });
    }
  } else {
    for (const h of neonHeats(summary.moneyGroup)) {
      rows.push({
        full: (h.racer ?? "").trim(),
        personId: h.bmiPersonId ?? null,
        source: "booking-label",
      });
    }
  }

  // The booking CONTACT is a real person the booking always knows. Offer them
  // when the racer rows can't say who's coming — a count-based booking carries
  // only slot labels (all filtered by the merge), so without this the voucher
  // scan pulled NO names in at all.
  const contact = summary.record?.contact;
  const contactFull = contact
    ? `${(contact.firstName ?? "").trim()} ${(contact.lastName ?? "").trim()}`.trim()
    : "";
  if (contactFull) {
    rows.push({
      full: contactFull,
      personId: summary.record?.primaryPersonId ?? null,
      source: "contact",
    });
  }

  const uniq = mergeRosterRows(rows);
  if (uniq.length === 0) return { members: [], degraded };

  const waiverBy = await checkRacerWaivers(uniq.map((r) => r.personId));
  const members = uniq.map((r) => {
    const parts = r.full.split(/\s+/).filter(Boolean);
    return {
      firstName: parts[0] || "Guest",
      ...(parts.length > 1 ? { lastName: parts.slice(1).join(" ") } : {}),
      ...(r.personId ? { bmiPersonId: r.personId } : {}),
      waiverValid: r.personId ? (waiverBy.get(r.personId) ?? false) : false,
      source: r.source,
    };
  });
  return { members, degraded };
}

export { loadSummary };
export type { ResSummary, CheckinVerifiedVia };
