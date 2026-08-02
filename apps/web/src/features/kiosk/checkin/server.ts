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
import { displayNameFromFull, makeDisplayName } from "@/lib/display-name";
import { verifyBillSignature } from "@/lib/booking-confirmation-link";
import { todayET } from "~/features/daily-events/format";
import { resolveCenter } from "~/features/cancellation/centers";
import { resolveBmiProject } from "~/features/cancellation/bmi-cancel";
import {
  getBowlingReservationByBillId,
  listBowlingReservations,
  listCancelGroupReservations,
  getReservationsByContact,
  type BowlingReservation,
} from "@/lib/bowling-db";
import { ATTRACTIONS } from "@/lib/attractions-data";
import { registerProjectPersonServer } from "~/features/kiosk/waiver/bmi-attach";
import {
  setProjectState,
  appendProjectPrivateNote,
  KIOSK_CONFIRMATION_STATE_IDS,
} from "@/lib/bmi-office-actions";
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
import { scheduleCheckinRacers, heatStopFor, type ScheduleRacer } from "./schedule-racers";
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
import { isPlaceholderRacerName } from "./party-prefill";
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
  const record = await readBookingRecord(billId);
  const anchor = await getBowlingReservationByBillId(billId).catch(() => null);
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

export async function matchByPhone(
  center: CenterSlug,
  phone: string,
): Promise<CheckinLookupMatch[]> {
  const rows = await getReservationsByContact({ phone, limit: 200 }).catch(() => []);
  const today = todayET();
  const seen = new Set<string>();
  const matches: CheckinLookupMatch[] = [];
  // Row order is event_at DESC; group by billId and keep today + this center.
  // A verified own-phone match IS proof of possession (the phone is the
  // booking contact), so each match carries its own proof token.
  for (const row of rows) {
    if (!row.bmiBillId || seen.has(row.bmiBillId)) continue;
    if (row.status === "cancelled") continue;
    if (resolveCenter(row.centerCode, row.productKind).slug !== center) continue;
    const dateStr = (row.eventAt || row.bookedAt || "").slice(0, 10);
    if (dateStr !== today) continue;
    seen.add(row.bmiBillId);
    const summary = await loadSummary(row.bmiBillId);
    if (!summary || summary.cancelled) continue;
    const proofToken = await mintProof(row.bmiBillId, center, "otp");
    matches.push({
      proofToken,
      label: summary.label,
      timeLabel: summary.timeLabel,
      activitiesLabel: summary.activitiesLabel,
    });
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

export async function listBrowseRows(center: CenterSlug): Promise<CheckinBrowseRow[]> {
  const today = todayET();
  const rows = await listBowlingReservations({
    startDate: today,
    endDate: today,
    centerCodes: CENTER_CODES_FOR_SLUG[center],
  }).catch(() => []);
  // No forward cutoff — the query is already scoped to today's business date,
  // so "everything from 3h ago on" IS the rest of the day (incl. 11pm+ slots).
  const lo = etMinuteOffset(-BROWSE_LOOKBACK_MIN);

  // Group Neon rows by billId (a mixed cart / combo shares one bill → one row),
  // aggregating product kinds so the label reads "Racing + Bowling".
  interface Grp {
    billId: string;
    kinds: Set<string>;
    guestName: string;
    earliest: string;
    /** VIP combo id from whichever leg carries it (stamped on both combo
     *  legs) — free off the rows already fetched, no extra round trip. */
    comboSpecialId: string | null;
  }
  const groups = new Map<string, Grp>();
  for (const row of rows) {
    if (row.status === "cancelled" || row.status === "no_show") continue;
    // Skip kiosk-booked reservations — that guest is already in-center (they
    // just booked AT the kiosk), so they never need to find themselves here to
    // check in (owner 2026-07-25).
    if (row.bookingSource === "kiosk") continue;
    const evt = row.eventAt || row.bookedAt || "";
    const key = timeKey(evt);
    if (!key || key < lo) continue;
    const billId = row.bmiBillId;
    if (!billId) continue; // no bill → cannot open/verify it; skip from browse
    const g = groups.get(billId);
    if (g) {
      g.kinds.add(row.productKind);
      if (!g.guestName && row.guestName) g.guestName = row.guestName;
      if (timeKey(evt) < timeKey(g.earliest)) g.earliest = evt;
      if (!g.comboSpecialId && row.comboSpecialId) g.comboSpecialId = row.comboSpecialId;
    } else {
      groups.set(billId, {
        billId,
        kinds: new Set([row.productKind]),
        guestName: row.guestName ?? "",
        earliest: evt,
        comboSpecialId: row.comboSpecialId ?? null,
      });
    }
  }

  const ordered = [...groups.values()].sort((a, b) =>
    timeKey(a.earliest).localeCompare(timeKey(b.earliest)),
  );
  const out: CheckinBrowseRow[] = [];
  for (const g of ordered) {
    // Racing check-in only — a reservation with no race leg never appears in
    // this list (a race + bowling combo still shows; owner 2026-07-25).
    if (!g.kinds.has("race")) continue;
    const { label: activitiesLabel, kind } = kindsToActivitiesLabel(g.kinds);
    // Express Lane is per-RESERVATION truth, not "is this a race" — badging
    // every racing row (the pre-fix behaviour) told guests who DO need to check
    // in to skip it. The booking record carries the flag checkout wrote; read it
    // alongside the ref mint so this costs no extra round trip. Only a
    // racing-ONLY row can be express (a combo still needs its lane opened).
    const [record, ref] = await Promise.all([
      kind === "racing" ? readBookingRecord(g.billId) : Promise.resolve(null),
      mintRef({ billId: g.billId, center }),
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
  const attachEnabled = kioskCheckinAttachEnabled();
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
// Comfortably longer than the worst-case finalize (schedule withRetry ~15s×3 +
// the 10s/20s straggler re-POSTs) so a "busy, tap again" retry can't acquire a
// prematurely-expired lock and re-run the pipeline.
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

export interface CompleteResult {
  ok: boolean;
  alreadyComplete?: boolean;
  scheduled?: number;
  scheduleUnlinked?: string[];
  stateStamped?: boolean;
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
 * behind KIOSK_CHECKIN_ATTACH (default OFF) so the finalize is dark-safe; the
 * local event/record stamps always run. Idempotent: a completed event returns
 * alreadyComplete without re-writing.
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
    if (event) {
      const existing = await getCheckinEvent(billId, businessDate);
      if (existing?.completedAt) {
        // Replay (double-tap / resolved busy-retry): report the persisted state
        // so the done screen keeps the lane panel interactive + the right count.
        const priorPeople = await listCheckinPeople(event.id);
        return {
          ok: true,
          alreadyComplete: true,
          scheduled: priorPeople.filter((p) => p.scheduleStatus === "inserted").length,
          stateStamped: existing.bmiStateStatus === "set",
          laneOpenEnabled: kioskCheckinAttachEnabled(),
        };
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
    const people = event ? await listCheckinPeople(event.id) : [];

    let scheduled = 0;
    // Names we must flag to staff: schedule sync-lag failures, people with no
    // resolved short id, and people who arrived with no open slot to place them.
    const memoFailures: string[] = [];
    const unplaced: string[] = [];
    let stateStamped = false;

    if (attachEnabled && hasRacing) {
      // Assign the added people to open heat slots (no bmiPersonId). The guest's
      // explicit person→slot choices (class-validated at the kiosk) win; without
      // them we fall back to the legacy earliest-first positional auto-assign.
      const openHeats = heats.filter((h) => !h.bmiPersonId && h.heatId);
      // Seat-unique slotKey → heat (two racers in one heat are distinct slots).
      const openBySlotKey = new Map(
        buildRaceSlotEntries(group)
          .filter((e) => !e.heat.bmiPersonId)
          .map((e) => [e.slot.slotKey, e.heat]),
      );
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
        if (!p.pandoraPersonId) {
          // No short id resolved (e.g. a returning racer whose lookup didn't
          // upsert) — can't schedule; flag for the desk, don't poison the batch.
          memoFailures.push(name);
          await setCheckinPersonStatus(p.id, { scheduleStatus: "failed" });
          return;
        }
        const productId = heat.productId ?? null;
        const product = productId ? getRaceProductById(productId) : null;
        racers.push({
          racerName: name,
          personId: p.pandoraPersonId,
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
          bound.push({ personRowId: p.id, personId: p.pandoraPersonId });
        }
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

      const assignments = (args.assignments ?? []).filter((a) => a?.slotKey && a?.personId);
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
        const res = await scheduleCheckinRacers({ reservationNumber, racers });
        scheduled = res.linked;
        console.log(
          `[kiosk-checkin] ${reservationNumber}: scheduled ${res.linked}/${racers.length}` +
            (res.unlinked.length > 0 ? ` — unlinked: ${res.unlinked.join(", ")}` : ""),
        );
        // Per-person status matched by personId (never by name — duplicate first
        // names would collide, review L6).
        const failedIds = new Set(res.unlinkedPersonIds);
        for (const b of bound) {
          await setCheckinPersonStatus(b.personRowId, {
            scheduleStatus: failedIds.has(b.personId) ? "failed" : "inserted",
          });
        }
        memoFailures.push(...res.unlinked);
      }
    }

    // "Confirmation Kiosk" custom state — the staff-visible "party is here and
    // checked in" signal, the SAME state the kiosk post-reserve rail and
    // express-lane web bookings land in (owner 2026-07-24, superseding -5).
    // Unlike -5 "Arrived", this is NOT an arrival state, so it does not trigger
    // race-dayof-pay to settle the day-of order early. Custom ids (no leading
    // "-") go Office-API-first in setProjectState; Pandora 200-no-ops them.
    const kioskStateId = KIOSK_CONFIRMATION_STATE_IDS[stateCenterCode];
    if (attachEnabled && hasRacing && officeProjectId && kioskStateId) {
      try {
        await setProjectState({
          centerCode: stateCenterCode,
          projectId: officeProjectId,
          stateId: kioskStateId,
          label: "Confirmation Kiosk (check-in)",
        });
        stateStamped = true;
      } catch (err) {
        console.error("[kiosk-checkin] Confirmation Kiosk stamp failed (non-fatal):", err);
      }
    }

    // ONE composed staff memo (only where a BMI project exists — racing;
    // bowling/attraction-only reservations have no billId+1 project to note on).
    if (attachEnabled && hasRacing && officeProjectId) {
      const names = people.map((p) => p.displayName).join(", ") || "party";
      const couldNotAdd = [...new Set(memoFailures)];
      const note =
        `Kiosk check-in ${etTimeLabel()}: ${names} — waivers ✓` +
        (scheduled > 0 ? `, ${scheduled} added to session` : "") +
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
        stateStamped ? "set" : attachEnabled && hasRacing ? "failed" : "pending",
      );
    }

    return {
      ok: true,
      scheduled,
      scheduleUnlinked: [...new Set([...memoFailures, ...unplaced])],
      stateStamped,
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
export async function listBindableParty(billId: string): Promise<CheckinPartyMember[]> {
  const summary = await loadSummary(billId);
  if (!summary || summary.cancelled) return [];

  // One row per person: record racers list one row per HEAT (a combo racer
  // appears twice), so dedupe on personId, falling back to the name.
  const rows: Array<{ full: string; personId: string | null }> = [];
  const recRacers = summary.record?.racers ?? [];
  if (recRacers.length > 0) {
    for (const r of recRacers) {
      rows.push({ full: (r.racerName ?? "").trim(), personId: r.personId ?? null });
    }
  } else {
    for (const h of neonHeats(summary.moneyGroup)) {
      rows.push({ full: (h.racer ?? "").trim(), personId: h.bmiPersonId ?? null });
    }
  }
  // Everyone who SIGNED through the booking's /waiver link (owner 2026-08-01:
  // "this is where you pull the info from rather than asking again") — the
  // link's pid keys kiosk_waiver_joins by projectId = billId + 1, and the
  // signers arrive with real names + person ids. Count-based bookings carry
  // only slot labels above, so without this the party who pre-signed on their
  // phones was invisible to "Load your party" (the Gipson check-in).
  try {
    const joins = await listJoinsForProject(officeProjectIdFromBillId(billId));
    for (const j of joins) {
      const full = [j.firstName ?? "", j.lastName ?? ""].join(" ").trim() || j.displayName.trim();
      rows.push({ full, personId: j.personId ?? null });
    }
  } catch {
    /* joins unavailable — the booking-sourced rows above still stand */
  }
  const seen = new Set<string>();
  const uniq = rows.filter((r) => {
    if (!r.full && !r.personId) return false;
    // An UNIDENTIFIED row wearing a category placeholder label ("Adult 1") is
    // an unnamed new-racer slot, not a person — never offer it as a prefill
    // name. One tap would seed a literal "Adult 1" party member, and its
    // "Set up" (DOB-only, contact-less onboard) could then mint a BMI person
    // actually NAMED "Adult 1". The "Who's racing?" assignment step is how
    // those open slots get real people. (2026-07-31 whitley check-in.)
    if (!r.personId && isPlaceholderRacerName(r.full)) return false;
    const key = r.personId ?? `name:${r.full.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // The booking CONTACT is a real person the booking always knows. Offer them
  // when the racer rows can't say who's coming — a count-based booking carries
  // only slot labels (all filtered above; probed live 2026-08-01: every recent
  // VIP combo), so without this the voucher scan pulled NO names in at all.
  const contact = summary.record?.contact;
  const contactFull = contact
    ? `${(contact.firstName ?? "").trim()} ${(contact.lastName ?? "").trim()}`.trim()
    : "";
  const contactPersonId = summary.record?.primaryPersonId ?? null;
  if (
    contactFull &&
    !(contactPersonId && seen.has(contactPersonId)) &&
    !uniq.some((r) => r.full.toLowerCase() === contactFull.toLowerCase())
  ) {
    uniq.push({ full: contactFull, personId: contactPersonId });
  }
  if (uniq.length === 0) return [];

  const waiverBy = await checkRacerWaivers(uniq.map((r) => r.personId));
  return uniq.map((r) => {
    const parts = r.full.split(/\s+/).filter(Boolean);
    return {
      firstName: parts[0] || "Guest",
      ...(parts.length > 1 ? { lastName: parts.slice(1).join(" ") } : {}),
      ...(r.personId ? { bmiPersonId: r.personId } : {}),
      waiverValid: r.personId ? (waiverBy.get(r.personId) ?? false) : false,
    };
  });
}

export { loadSummary };
export type { ResSummary, CheckinVerifiedVia };
