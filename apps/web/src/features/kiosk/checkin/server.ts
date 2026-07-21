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
import { displayNameFromFull } from "@/lib/display-name";
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
import {
  assembleItinerary,
  fmtTime12,
  timeKey,
  toEtWallClock,
  type AttractionMeta,
} from "./itinerary";
import { classifyScan } from "./scan";
import type {
  CheckinBrowseRow,
  CheckinItinerary,
  CheckinLookupMatch,
  CheckinRosterPerson,
  CheckinVerifiedVia,
} from "./types";

// ── constants ──────────────────────────────────────────────────────────────
const REF_TTL = 900; // 15 min — a browse/scan handle
const PROOF_TTL = 1800; // 30 min — a verified flow token (survives a big party)
const OTP_COOLDOWN = 45; // per-reservation send throttle (anti-griefing)
const BROWSE_WINDOW_MIN = 180; // ±3h around now
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
interface BookingRecord {
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
export async function mintProof(billId: string, center: CenterSlug): Promise<string> {
  const token = newToken();
  await redis.set(`checkin:proof:${token}`, JSON.stringify({ billId, center }), "EX", PROOF_TTL);
  return token;
}
export async function readProof(
  token: string,
): Promise<{ billId: string; center: CenterSlug } | null> {
  try {
    const raw = await redis.get(`checkin:proof:${token}`);
    return raw ? (JSON.parse(raw) as { billId: string; center: CenterSlug }) : null;
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
      // Ambiguous token that wasn't a signed short link → try the code index,
      // unproven (OTP-gated).
      const byCode = await redis.get(`bookingrecord:code:${c.value}`).catch(() => null);
      if (byCode) return { billId: byCode, proven: false };
      return { reason: "not-found" };
    }
    case "code": {
      const byCode = await redis.get(`bookingrecord:code:${c.value}`).catch(() => null);
      if (byCode) return { billId: byCode, proven: false };
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
    const proofToken = await mintProof(row.bmiBillId, center);
    matches.push({
      proofToken,
      label: summary.label,
      timeLabel: summary.timeLabel,
      activitiesLabel: summary.activitiesLabel,
    });
  }
  return matches;
}

// ── browse (today at this center, ±3h) ───────────────────────────────────────
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
  const lo = etMinuteOffset(-BROWSE_WINDOW_MIN);
  const hi = etMinuteOffset(BROWSE_WINDOW_MIN);

  // Group Neon rows by billId (a mixed cart / combo shares one bill → one row),
  // aggregating product kinds so the label reads "Racing + Bowling".
  interface Grp {
    billId: string;
    kinds: Set<string>;
    guestName: string;
    earliest: string;
  }
  const groups = new Map<string, Grp>();
  for (const row of rows) {
    if (row.status === "cancelled" || row.status === "no_show") continue;
    const evt = row.eventAt || row.bookedAt || "";
    const key = timeKey(evt);
    if (!key || key < lo || key > hi) continue;
    const billId = row.bmiBillId;
    if (!billId) continue; // no bill → cannot open/verify it; skip from browse
    const g = groups.get(billId);
    if (g) {
      g.kinds.add(row.productKind);
      if (!g.guestName && row.guestName) g.guestName = row.guestName;
      if (timeKey(evt) < timeKey(g.earliest)) g.earliest = evt;
    } else {
      groups.set(billId, {
        billId,
        kinds: new Set([row.productKind]),
        guestName: row.guestName ?? "",
        earliest: evt,
      });
    }
  }

  const ordered = [...groups.values()].sort((a, b) =>
    timeKey(a.earliest).localeCompare(timeKey(b.earliest)),
  );
  const out: CheckinBrowseRow[] = [];
  for (const g of ordered) {
    const { label: activitiesLabel, kind } = kindsToActivitiesLabel(g.kinds);
    const ref = await mintRef({ billId: g.billId, center });
    out.push({
      ref,
      label: g.guestName ? displayNameFromFull(g.guestName) : "Guest",
      timeLabel: fmtTime12(g.earliest),
      activitiesLabel,
      kind,
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
): Promise<{ ok: boolean; mask?: string; reason?: "no-contact" | "rate-limited" }> {
  const phone = await resolveContactPhone(billId);
  if (!phone) return { ok: false, reason: "no-contact" };
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
      const proofToken = await mintProof(billId, center);
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

  // Racing — one activity at the earliest heat; readiness = personId present.
  // Prefer the Redis booking record (carries racer names + personIds); fall
  // back to the Neon race row's booking_metadata.heats when that record is
  // gone (eviction / failed checkout POST) so the race never silently drops.
  type RacerRow = { name: string; identified: boolean };
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
        })),
      };
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

  // Read-only party panel (PR2 makes it interactive + waiver-accurate). Sourced
  // from whatever the racing activity was built from, so it survives an evicted
  // Redis record.
  const roster: CheckinRosterPerson[] = (racing?.racers ?? []).map((r) => ({
    personId: null,
    pandoraPersonId: null,
    displayName: r.name,
    waiverValid: false, // PR2 resolves waiver truth via Pandora
    boundTo: ["Racing"],
  }));

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
    dueAtCenterCents,
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
    dueAtCenterCents: 0,
    reason,
  };
}

export { loadSummary };
export type { ResSummary, CheckinVerifiedVia };
