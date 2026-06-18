/**
 * "Your event is almost here" email for the Healthcare Network Team Day
 * (group event slug `healthnet-2026`, Friday 2026-06-19, HeadPinz Fort Myers).
 *
 * Why this exists: we collected RSVPs (name, email, scheduled activities) but
 * NOT phone numbers, so we can't text day-of e-tickets. This one-time email
 * shows each guest their personal schedule and drives them to a confirm page
 * that captures a mobile number for the Friday-morning e-ticket text.
 *
 * Pure builder — no DB/Redis/network. Render it in a script, unit-test it,
 * or call it from the send route. Matches the house group-email style
 * (navy #000418 header, cyan #00e2e5 accent, blue #004aad pill CTA).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { GroupEventRsvp } from "@/app/api/group-event/rsvp/route";

export const HEALTHNET_SLUG = "healthnet-2026";

/** Public site base for the confirm link. HeadPinz is the host venue.
 *  NOTE: bare apex domain — headpinz.com has NO www host (www.headpinz.com fails). */
export const SITE_BASE = (process.env.NEXT_PUBLIC_SITE_URL || "https://headpinz.com").replace(
  /\/$/,
  "",
);

/** Logos already hosted for the house group emails. */
const HP_LOGO =
  "https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/hp_logo%201.png";
const FT_LOGO =
  "https://documents.sms-timing.com/Files/Automatic-emailings/headpinzftmyers/ft_logo%201.png";

/** Human labels for the timed (reservation) activity types. */
const TIMED_LABELS: Record<string, string> = {
  racing: "Go-Kart Racing",
  "gel-blaster": "Nexus Gel Blaster",
  "laser-tag": "Nexus Laser Tag",
};

/** Human labels for the free-flow activities. */
const FREEFLOW_LABELS: Record<string, string> = {
  bowling: "Bowling",
  "electric-shuffle": "Electric Shuffle",
  food: "Food & Drinks",
  "ping-pong": "Ping Pong",
  games: "Arcade Games",
};

/** Title-case a first name token ("andrea" → "Andrea", "ASHLEY" → "Ashley"). */
function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

/** First name from "Araceli A." / "andrea G." → "Araceli" / "Andrea". */
export function firstName(name: string): string {
  const tok = (name || "").trim().split(/\s+/)[0] || "there";
  return titleCase(tok);
}

/** "2026-06-19T10:24:00" (naive ET) → "10:24 AM". */
export function formatEtTime(iso?: string): string {
  if (!iso) return "";
  const tp = iso.replace(/Z$/, "").split("T")[1];
  if (!tp) return "";
  const [h, m] = tp.split(":").map(Number);
  if (Number.isNaN(h)) return "";
  const hr = ((h + 11) % 12) + 1;
  const mm = String(Number.isNaN(m) ? 0 : m).padStart(2, "0");
  return `${hr}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

// ── Confirm-link token (HMAC over the email) ────────────────────────────────
// Reuses an existing server secret so no new env var is required. The token is
// opaque + tamper-proof: a guest can't edit it to claim another person's slot.

function confirmSecret(): string {
  const s = process.env.HEALTHNET_CONFIRM_SECRET || process.env.ADMIN_CAMERA_TOKEN || "";
  if (!s) throw new Error("No HEALTHNET_CONFIRM_SECRET / ADMIN_CAMERA_TOKEN for confirm tokens");
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signConfirmToken(email: string): string {
  const e = email.toLowerCase();
  const payload = b64url(Buffer.from(e, "utf8"));
  const sig = b64url(createHmac("sha256", confirmSecret()).update(e).digest()).slice(0, 24);
  return `${payload}.${sig}`;
}

/** Returns the verified lowercase email, or null if the token is bad. */
export function verifyConfirmToken(token: string): string | null {
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return null;
  let email: string;
  try {
    email = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }
  const expected = b64url(createHmac("sha256", confirmSecret()).update(email).digest()).slice(
    0,
    24,
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return email;
}

export function confirmUrl(email: string, base: string = SITE_BASE): string {
  return `${base.replace(/\/$/, "")}/event/${HEALTHNET_SLUG}/confirm?t=${encodeURIComponent(
    signConfirmToken(email),
  )}`;
}

// ── Email body ──────────────────────────────────────────────────────────────

const EVENT_DATE_LONG = "Friday, June 19, 2026";
const EVENT_TIME = "9:00 AM – 2:00 PM";
const EVENT_VENUE = "HeadPinz Fort Myers";

/** Build one schedule row (timed activity). */
function scheduleRow(label: string, detail: string, time: string): string {
  return `<tr>
    <td style="padding:12px 16px;border-bottom:1px solid #eef0f3;font-family:Arial,sans-serif;vertical-align:top">
      <span style="font-size:15px;font-weight:bold;color:#1a1a1a">${label}</span>
      ${detail ? `<br/><span style="font-size:13px;color:#64748b">${detail}</span>` : ""}
    </td>
    <td style="padding:12px 16px;border-bottom:1px solid #eef0f3;font-family:Arial,sans-serif;text-align:right;white-space:nowrap;vertical-align:top">
      <span style="font-size:15px;font-weight:bold;color:#0d9aa0">${time}</span>
    </td>
  </tr>`;
}

/** Human, time-sorted summary of a guest's timed reservations (race/laser/gel). */
export function reservationSummary(rsvp: GroupEventRsvp): { label: string; time: string }[] {
  return (rsvp.reservations || [])
    .filter((r) => r.time && TIMED_LABELS[r.type])
    .slice()
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""))
    .map((r) => ({
      label: TIMED_LABELS[r.type] + (r.type === "racing" && r.track ? ` · ${r.track} Track` : ""),
      time: formatEtTime(r.time),
    }));
}

export interface AlmostHereEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildAlmostHereEmail(
  rsvp: GroupEventRsvp,
  opts?: { baseOverride?: string; reminder?: boolean },
): AlmostHereEmail {
  const base = (opts?.baseOverride || SITE_BASE).replace(/\/$/, "");
  const reminder = !!opts?.reminder;
  const fn = firstName(rsvp.name);
  const url = confirmUrl(rsvp.email, base);
  // Booking page — where a guest reserves more activities. Carries their email
  // for forward-compat (gate pre-fill); harmless if the gate ignores it today.
  const scheduleUrl = `${base}/event/${HEALTHNET_SLUG}?email=${encodeURIComponent(rsvp.email)}`;
  // Short, shareable check-in URL for coworkers who didn't get the email.
  const checkinShortUrl = `${base}/healthnet`;
  const checkinShortLabel = `${base.replace(/^https?:\/\//, "")}/healthnet`;

  // Timed reservations, sorted by start time.
  const timed = (rsvp.reservations || [])
    .filter((r) => r.time && TIMED_LABELS[r.type])
    .slice()
    .sort((a, b) => (a.time || "").localeCompare(b.time || ""));

  const scheduleRows = timed
    .map((r) => {
      const label = TIMED_LABELS[r.type] || r.type;
      const detail = r.type === "racing" && r.track ? `${r.track} Track` : "";
      return scheduleRow(label, detail, formatEtTime(r.time));
    })
    .join("");

  const freeflowLabels = (rsvp.freeflow || []).map((f) => FREEFLOW_LABELS[f] || f).filter(Boolean);
  const hasSchedule = timed.length > 0;

  const freeflowLine = `<p style="margin:18px 0 0;font-size:14px;color:#475569;font-family:Arial,sans-serif;line-height:1.6">
         Bowling and your other open activities don't require a reservation — just drop in.
       </p>`;

  // "It's not too late" — reserve more activities. Prominent for entry-only
  // guests (nothing timed yet); a soft nudge for guests who already have slots.
  const addMoreCta = `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fff8ec;border:1px solid #f3d49a;border-radius:10px;margin-top:18px">
      <tr><td align="center" style="padding:22px 24px">
        <p style="margin:0 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:2px;color:#b7791f;font-weight:bold;font-family:Arial,sans-serif">It's not too late</p>
        <p style="margin:0 0 16px;font-size:16px;color:#1a1a1a;font-weight:bold;font-family:Arial,sans-serif">Add go-kart racing, laser tag, or gel blaster</p>
        <a href="${scheduleUrl}" style="display:inline-block;padding:14px 30px;background-color:#b7791f;color:#ffffff !important;text-decoration:none;border-radius:555px;font-weight:bold;font-size:14px;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif">Schedule my activities</a>
        <p style="margin:14px 0 0;font-size:12px;color:#8a6d3b;line-height:1.6;font-family:Arial,sans-serif">Spots are limited and going fast — reserve a time before the day fills up.</p>
      </td></tr>
    </table>`;

  const addMoreLink = `<p style="margin:14px 0 0;font-size:13px;color:#64748b;font-family:Arial,sans-serif;line-height:1.6">
      Want to do more? It's not too late to <a href="${scheduleUrl}" style="color:#004aad;font-weight:bold;text-decoration:none">add another activity</a>.
    </p>`;

  const scheduleBlock = hasSchedule
    ? `<p style="margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:2px;color:#004aad;font-weight:bold;font-family:Arial,sans-serif">Your reserved times</p>
       <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;border-collapse:separate">
         ${scheduleRows}
       </table>
       ${freeflowLine}
       ${addMoreLink}`
    : `<p style="margin:0;font-size:15px;color:#475569;font-family:Arial,sans-serif;line-height:1.6">
         You're on the guest list for a full day of fun${
           freeflowLabels.length ? ` — ${freeflowLabels.join(", ")}` : ""
         } — but you haven't reserved any timed activities yet.
       </p>
       ${addMoreCta}`;

  const heroSub = reminder
    ? `${fn}, we haven't heard from you yet — please check in for the <strong>Healthcare Network Team Day</strong> tomorrow.`
    : hasSchedule
      ? `${fn}, the <strong>Healthcare Network Team Day</strong> is this Friday. Here's everything you've got lined up.`
      : `${fn}, the <strong>Healthcare Network Team Day</strong> is this Friday — and it's not too late to add an activity.`;

  const headline = reminder ? "Please check in for tomorrow" : "Your event is almost here";

  const subject = reminder
    ? `${fn}, we haven't heard from you — please check in for tomorrow's event`
    : `${fn}, your Healthcare Network Team Day is this Friday — confirm & get your ticket`;

  const text = [
    reminder
      ? `${fn}, we haven't heard from you — please check in for tomorrow's Healthcare Network Team Day.`
      : `${fn}, your Healthcare Network Team Day is almost here!`,
    ``,
    `${EVENT_DATE_LONG} · ${EVENT_TIME} · ${EVENT_VENUE}`,
    ``,
    timed.length
      ? `Your reserved times:\n` +
        timed
          .map((r) => {
            const label = TIMED_LABELS[r.type] || r.type;
            const detail = r.type === "racing" && r.track ? ` (${r.track} Track)` : "";
            return `  • ${label}${detail} — ${formatEtTime(r.time)}`;
          })
          .join("\n")
      : `You're on the guest list for a full day of fun.`,
    ``,
    `IT'S TIME TO CONFIRM YOU'RE JOINING US`,
    `Confirm and add your mobile number here: ${url}`,
    ``,
    `We'll text your event ticket the morning of Friday, June 19 — it's your fast pass to check-in.`,
    ``,
    `Have a coworker who's off today? Send them to ${checkinShortUrl} to check in.`,
    ``,
    `BEFORE YOU ARRIVE`,
    `If you're racing, the following are required for your safety: closed-toe shoes, hair secured back, and no loose clothing.`,
    `Forgot your closed-toe shoes? Bowling shoes are available — FastTrax provides them at the track, so please don't wear them across the parking lot.`,
    `Please plan to arrive about 5 minutes before each scheduled time at your designated attraction. We'll text your check-ins.`,
    ``,
    `See you Friday!`,
    `HeadPinz Fort Myers & FastTrax`,
  ].join("\n");

  const html = `<html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="color-scheme" content="light" /><meta name="supported-color-schemes" content="light" /><style type="text/css">:root{color-scheme:light;supported-color-schemes:light}#outlook a{padding:0}a img{border:none}table td{border-collapse:collapse}body{margin:0;padding:0;background-color:#f2f3f5;-webkit-text-size-adjust:100%}a{color:#004aad}</style></head>
<body style="margin:0;padding:0;background-color:#f2f3f5">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f2f3f5">
<tr><td align="center" style="padding:20px 10px">
<table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0">

  <!-- HEADER LOGOS -->
  <tr><td style="padding:24px 40px;background-color:#000418">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" width="50%"><img src="${HP_LOGO}" width="130" alt="HeadPinz" style="height:auto" /></td>
      <td align="right" width="50%"><img src="${FT_LOGO}" width="130" alt="FastTrax" style="height:auto" /></td>
    </tr></table>
  </td></tr>

  <!-- HEADLINE -->
  <tr><td align="center" style="padding:28px 40px 12px 40px;font-family:Arial,sans-serif">
    <h1 style="margin:0 0 8px 0;font-size:24px;color:#1a1a1a;letter-spacing:1px;text-transform:uppercase">${headline}</h1>
    <p style="margin:0;font-size:15px;color:#666666;line-height:1.6">${heroSub}</p>
  </td></tr>

  <!-- EVENT SUMMARY -->
  <tr><td style="padding:8px 40px 4px 40px;font-family:Arial,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e0e0e0;border-radius:6px;overflow:hidden">
      <tr><td style="background-color:#000418;padding:10px 16px;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:#00e2e5;text-transform:uppercase;letter-spacing:1px">Healthcare Network Team Day</td></tr>
      <tr><td style="padding:14px 16px;font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.8">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr><td style="color:#888;font-size:13px;width:90px">Date:</td><td style="color:#1a1a1a;font-size:14px;font-weight:bold">${EVENT_DATE_LONG}</td></tr>
          <tr><td style="color:#888;font-size:13px;padding-top:6px">Time:</td><td style="color:#1a1a1a;font-size:14px;font-weight:bold;padding-top:6px">${EVENT_TIME}</td></tr>
          <tr><td style="color:#888;font-size:13px;padding-top:6px">Where:</td><td style="color:#1a1a1a;font-size:14px;padding-top:6px">${EVENT_VENUE}</td></tr>
        </table>
      </td></tr>
    </table>
  </td></tr>

  <!-- SCHEDULE -->
  <tr><td style="padding:18px 40px 4px 40px;font-family:Arial,sans-serif">
    ${scheduleBlock}
  </td></tr>

  <!-- CHECK-IN CTA -->
  <tr><td style="padding:24px 40px 8px 40px;font-family:Arial,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5fdfd;border:1px solid #b8eef0;border-radius:10px">
      <tr><td align="center" style="padding:26px 24px">
        <p style="margin:0 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:2px;color:#0d9aa0;font-weight:bold;font-family:Arial,sans-serif">It's time to confirm</p>
        <p style="margin:0 0 18px;font-size:17px;color:#1a1a1a;font-weight:bold;font-family:Arial,sans-serif">Are you joining us on Friday?</p>
        <a href="${url}" style="display:inline-block;padding:18px 40px;background-color:#004aad;color:#ffffff !important;text-decoration:none;border-radius:555px;font-weight:bold;font-size:16px;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif">Yes — confirm &amp; get my ticket</a>
        <p style="margin:18px 0 0;font-size:13px;color:#475569;line-height:1.6;font-family:Arial,sans-serif">Tap above and add your mobile number. We'll text your event ticket the <strong>morning of Friday, June 19</strong> — it's your fast pass to check-in.</p>
        <p style="margin:12px 0 0;font-size:12px;color:#64748b;line-height:1.6;font-family:Arial,sans-serif">Have a coworker who's off today? Send them to <a href="${checkinShortUrl}" style="color:#004aad;font-weight:bold;text-decoration:none">${checkinShortLabel}</a> to check in.</p>
      </td></tr>
    </table>
  </td></tr>

  <!-- RACE-DAY / SAFETY -->
  <tr><td style="padding:16px 40px 4px 40px;font-family:Arial,sans-serif">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fffbeb;border:1px solid #fde68a;border-radius:10px">
      <tr><td style="padding:16px 18px;font-family:Arial,sans-serif">
        <p style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;color:#b45309;font-weight:bold">Before you arrive</p>
        <p style="margin:0 0 8px;font-size:14px;color:#475569;line-height:1.6">If you're <strong style="color:#1a1a1a">racing</strong>, the following are <strong>required for your safety</strong>: <strong>closed-toe shoes</strong>, <strong>hair secured</strong> back, and <strong>no loose clothing</strong>.</p>
        <p style="margin:0 0 8px;font-size:14px;color:#475569;line-height:1.6">Forgot your closed-toe shoes? Bowling shoes are available — <strong style="color:#1a1a1a">FastTrax provides them at the track</strong>, so please don't wear them across the parking lot.</p>
        <p style="margin:0;font-size:14px;color:#475569;line-height:1.6">Please plan to arrive about <strong style="color:#1a1a1a">5 minutes before</strong> each scheduled time at your designated attraction. We'll <strong>text your check-ins</strong>.</p>
      </td></tr>
    </table>
  </td></tr>

  <!-- SIGN-OFF -->
  <tr><td style="padding:16px 40px 24px 40px;font-family:Arial,sans-serif">
    <p style="margin:0;font-size:15px;color:#475569;line-height:1.6">See you Friday!<br/><strong style="color:#1a1a1a">The HeadPinz &amp; FastTrax Team</strong></p>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="padding:16px 40px;border-top:1px solid #e0e0e0;font-family:Arial,sans-serif;text-align:center">
    <p style="margin:0;font-size:11px;color:#999">HeadPinz Fort Myers · <a href="https://headpinz.com" style="color:#999;text-decoration:none">headpinz.com</a></p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

  return { subject, html, text };
}
