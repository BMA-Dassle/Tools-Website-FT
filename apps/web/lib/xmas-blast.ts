/**
 * Christmas in July — business-partner email + SMS blast.
 *
 * ONE-TIME send to 2025 group-event contacts, segmented by the center they
 * booked. Naples contacts get the July 23 HeadPinz Naples invite; Fort Myers
 * contacts get the July 30 HeadPinz & FastTrax invite.
 *
 * This module holds everything channel-agnostic:
 *   - per-segment metadata + copy (subject, from, SMS body)
 *   - email render (loads emails/xmas-in-july-<segment>.html, fills placeholders)
 *   - the Redis audience store (seed from CSV via scripts/seed-xmas-recipients.mts,
 *     read by the one-shot cron route) + per-recipient sent flags
 *
 * The actual send + safety rails (window guard, dedup, consent gate, dryRun/test)
 * live in app/api/cron/xmas-blast/route.ts, mirroring the HealthNet one-shot.
 *
 * Recipient data is PII and never committed — it lives in Redis (30-day TTL)
 * and the gitignored scripts/.data/ CSV.
 */

import { readFileSync } from "fs";
import { join } from "path";
import redis from "@/lib/redis";

export const XMAS_CAMPAIGN = "xmas_in_july_2026";
export const XMAS_AUDIT_BCC = "vendorcases@dassle.us";

export type XmasSegment = "naples" | "fortmyers";

const BLOB_BASE = "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/events/xmas-in-july";

export interface XmasSegmentMeta {
  segment: XmasSegment;
  /** Value in the xlsx "Location" column that maps to this segment. */
  location: string;
  label: string;
  venue: string;
  address: string;
  dateLine: string;
  /** Public flyer image (uploaded via scripts/upload-xmas-flyers.mjs). */
  flyerUrl: string;
  subject: string;
  fromName: string;
  /** GSM-7, single-segment SMS body (validated ≤160 units). */
  smsBody: string;
  /** Plain-text email fallback. */
  emailText: string;
}

const RSVP_BASE = "https://headpinz.com/event/xmas-in-july";

/** RSVP link with per-segment/channel UTM tags (landing page ignores extra params). */
export function rsvpUrl(segment: XmasSegment, channel: "email" | "sms"): string {
  return `${RSVP_BASE}?utm_source=${channel}&utm_medium=blast&utm_campaign=${XMAS_CAMPAIGN}&utm_content=${segment}`;
}

export const XMAS_SEGMENTS: Record<XmasSegment, XmasSegmentMeta> = {
  naples: {
    segment: "naples",
    location: "HeadPinz Naples",
    label: "Naples",
    venue: "HeadPinz Naples",
    address: "8525 Radio Ln, Naples, FL 34104",
    dateLine: "Thursday, July 23, 2026",
    flyerUrl: `${BLOB_BASE}/flyer-naples.jpg`,
    subject: "You're Invited: Christmas in July at HeadPinz Naples (Thu, July 23)",
    fromName: "HeadPinz Naples",
    smsBody:
      "HeadPinz: Local business leaders, you're invited to Christmas in July - Thu 7/23, 4-7PM at HeadPinz Naples. Free RSVP: headpinz.com/j - see you! Reply STOP",
    emailText:
      "You're invited to Christmas in July at HeadPinz Naples — a festive evening for our local business leaders. " +
      "Thursday, July 23, 2026, 4:00–7:00 PM. Enjoy two drink tickets, a holiday buffet, and complimentary bowling, on us. " +
      "Space is limited — RSVP free at " +
      RSVP_BASE +
      ". This is a private business-partner event.",
  },
  fortmyers: {
    segment: "fortmyers",
    location: "HeadPinz Fort Myers",
    label: "Fort Myers",
    venue: "HeadPinz Fort Myers & FastTrax",
    address: "14513 Global Pkwy, Fort Myers, FL 33913",
    dateLine: "Thursday, July 30, 2026",
    flyerUrl: `${BLOB_BASE}/flyer-fortmyers.jpg`,
    subject: "You're Invited: Christmas in July at HeadPinz & FastTrax Fort Myers (Thu, July 30)",
    fromName: "HeadPinz & FastTrax Fort Myers",
    smsBody:
      "HeadPinz & FastTrax: Local business leaders, join us for Christmas in July - Thu 7/30, 4-7PM in Fort Myers. Free RSVP: headpinz.com/j - see you! Txt STOP",
    emailText:
      "You're invited to Christmas in July at HeadPinz & FastTrax Fort Myers — a festive evening for our local business leaders. " +
      "Thursday, July 30, 2026, 4:00–7:00 PM. Enjoy two drink tickets, a holiday buffet, complimentary bowling, and one go-kart race " +
      "(4:30–5:30 PM, must be 18+ to race). Space is limited — RSVP free at " +
      RSVP_BASE +
      ". This is a private business-partner event.",
  },
};

/** Map an xlsx Location value to a segment (null if neither center). */
export function segmentForLocation(location: string): XmasSegment | null {
  const l = location.trim();
  if (l === "HeadPinz Naples") return "naples";
  if (l === "HeadPinz Fort Myers") return "fortmyers";
  return null;
}

// ── Email render ─────────────────────────────────────────────────────────────

const templateCache: Partial<Record<XmasSegment, string>> = {};
function loadTemplate(segment: XmasSegment): string {
  if (!templateCache[segment]) {
    templateCache[segment] = readFileSync(
      join(process.cwd(), "emails", `xmas-in-july-${segment}.html`),
      "utf-8",
    );
  }
  return templateCache[segment]!;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  fromName: string;
}

/**
 * Render a segment's email. `unsubUrl` is the unsubscribe link — pass
 * SendGrid's `<%asm_group_unsubscribe_raw_url%>` tag when sending with an ASM
 * group, or a mailto/HTTPS fallback otherwise.
 */
export function renderXmasEmail(segment: XmasSegment, opts: { unsubUrl: string }): RenderedEmail {
  const meta = XMAS_SEGMENTS[segment];
  const html = loadTemplate(segment)
    .replace(/\^\[FlyerUrl\]\$/g, meta.flyerUrl)
    .replace(/\^\[RsvpUrl\]\$/g, rsvpUrl(segment, "email"))
    .replace(/\^\[UnsubUrl\]\$/g, opts.unsubUrl);
  return { subject: meta.subject, html, text: meta.emailText, fromName: meta.fromName };
}

// ── Redis audience store ───────────────────────────────────────────────────────

const AUDIENCE_TTL = 60 * 60 * 24 * 30; // 30 days — one-shot campaign, keep Redis lean (OOM lesson)
const idxKey = (segment: XmasSegment) => `xmasblast:idx:${segment}`;
const recKey = (email: string) => `xmasblast:rec:${email.toLowerCase()}`;
const emailSentKey = (email: string) => `xmasblast:email-sent:${email.toLowerCase()}`;
const smsSentKey = (phoneE164: string) => `xmasblast:sms-sent:${phoneE164}`;

export interface XmasRecipient {
  email: string;
  name: string;
  phone: string;
  segment: XmasSegment;
}

/** Seed one recipient into Redis (idempotent — dedups by email in the segment set). */
export async function seedRecipient(r: XmasRecipient): Promise<void> {
  const email = r.email.toLowerCase();
  await redis.sadd(idxKey(r.segment), email);
  await redis.expire(idxKey(r.segment), AUDIENCE_TTL);
  await redis.set(recKey(email), JSON.stringify(r), "EX", AUDIENCE_TTL);
}

export async function getSegmentEmails(segment: XmasSegment): Promise<string[]> {
  return redis.smembers(idxKey(segment));
}

export async function getRecipient(email: string): Promise<XmasRecipient | null> {
  const raw = await redis.get(recKey(email));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as XmasRecipient;
  } catch {
    return null;
  }
}

export async function wasEmailSent(email: string): Promise<boolean> {
  return (await redis.get(emailSentKey(email))) !== null;
}
export async function markEmailSent(email: string): Promise<void> {
  await redis.set(emailSentKey(email), "1", "EX", AUDIENCE_TTL);
}
export async function wasSmsSent(phoneE164: string): Promise<boolean> {
  return (await redis.get(smsSentKey(phoneE164))) !== null;
}
export async function markSmsSent(phoneE164: string): Promise<void> {
  await redis.set(smsSentKey(phoneE164), "1", "EX", AUDIENCE_TTL);
}
