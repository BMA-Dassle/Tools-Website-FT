/**
 * VIP welcome email + SMS builders for combo-special purchases.
 *
 * The booking-confirmation route swaps in `emails/vip-welcome.html` when the
 * payload carries a valid `comboSpecialId`; these builders fill the VIP-only
 * placeholders (`^VipItinerary()$`, `^VipPerks()$`, …), the subject line, and
 * the single-segment SMS body. Everything is pure over registry data
 * (combo-specials.ts) so copy stays authoritative in one place.
 *
 * NOT exported from the combos barrel (index.ts) — same rule as
 * combo-notify.ts: notification concerns stay out of client bundles.
 */

import type { ComboLeg, ComboSpecial } from "./combo-specials";

/**
 * GSM-7 discipline (see src/features/marketing/templates.ts): any non-ASCII
 * character pushes the message into UCS-2 and multiplies the billed segments.
 */
const NON_GSM7_RE = /[^\x00-\x7F]/;

/** One rendered itinerary step: a bold label line + an optional blurb. */
interface ItineraryStep {
  label: string;
  blurb: string;
}

function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * Customer-facing blurb per leg. Keyed on leg shape (not the Ultimate VIP by
 * name) so a future combo renders sensibly without touching this file.
 */
function legStep(leg: ComboLeg): ItineraryStep {
  if (leg.kind === "race") {
    if (leg.tier === "starter") {
      return {
        label: "Starter Race",
        blurb: "Qualify here to unlock your Intermediate race.",
      };
    }
    if (leg.tier === "intermediate") {
      return { label: "Intermediate Race", blurb: "Come back faster." };
    }
    return { label: `${tierLabel(leg.tier)} Race`, blurb: "" };
  }
  if (leg.kind === "bowling") {
    const hours = leg.durationMinutes / 60;
    const duration = hours === 1 ? "1 hour" : `${hours} hours`;
    return {
      label: leg.vip ? `VIP Bowling &mdash; ${duration}` : `Bowling &mdash; ${duration}`,
      blurb: leg.vip
        ? "Your semi-private VIP lane at the HeadPinz bowling center."
        : "Your lane at the HeadPinz bowling center.",
    };
  }
  return { label: leg.slug, blurb: "" };
}

/**
 * Blurb for a schedule line that came from the confirmation page's merged
 * `reservationSchedule` (e.g. "Starter Race · 2:00 PM"). Matched by keyword so
 * junior-mirror extra heats and product-name variants still get sane copy.
 */
function blurbForScheduleLine(line: string): string {
  if (/starter/i.test(line)) return "Qualify here to unlock your Intermediate race.";
  if (/intermediate/i.test(line)) return "Come back faster.";
  if (/vip bowling/i.test(line))
    return "Your semi-private VIP lane at the HeadPinz bowling center.";
  if (/bowl/i.test(line)) return "Your lane at the HeadPinz bowling center.";
  return "";
}

export interface VipEmailFields {
  comboName: string;
  /** Duration chip next to the eyebrow label ("≈" rendered as an entity). */
  durationLabel: string;
  /** Welcome paragraph under the headline. */
  tagline: string;
  /** <tr>-less inner HTML for the gold-framed itinerary card. */
  itineraryHtml: string;
  /** Inner HTML for the "Included with your VIP Experience" card. */
  perksHtml: string;
}

/**
 * Build the VIP-only template fields.
 *
 * Itinerary source of truth: the page's merged, time-sorted schedule lines
 * (real booked times, junior heats included) when provided; otherwise the
 * registry legs — `fallbackComponents` when the booking resolved via the
 * races-first reorder — without times.
 */
export function buildVipEmailFields(
  combo: ComboSpecial,
  opts?: { reordered?: boolean; scheduleLines?: string[] },
): VipEmailFields {
  const scheduleLines = (opts?.scheduleLines ?? []).map((l) => l.trim()).filter(Boolean);

  let steps: ItineraryStep[];
  if (scheduleLines.length > 0) {
    steps = scheduleLines.map((line) => ({ label: line, blurb: blurbForScheduleLine(line) }));
  } else {
    const legs =
      opts?.reordered && combo.fallbackComponents ? combo.fallbackComponents : combo.components;
    steps = legs.map(legStep);
  }

  const rows = steps
    .map(
      (s, i) => `
<tr>
  <td style="padding: 8px 0; ${i < steps.length - 1 ? "border-bottom: 1px solid #F3E8B8;" : ""}" >
    <strong style="color: #B8860B; font-size: 16px;">${i + 1}.</strong>
    <strong style="color: #1A1A1A; font-size: 13px;">${s.label}</strong>
    ${s.blurb ? `<p style="margin: 2px 0 0 22px; font-size: 12px; color: #666; line-height: 1.4;">${s.blurb}</p>` : ""}
  </td>
</tr>`,
    )
    .join("");

  const qualifyNote = combo.qualifyFallbackNote
    ? `<p style="font-size: 12px; color: #888; margin: 12px 0 0 0; line-height: 1.5;">${combo.qualifyFallbackNote.replace(/—/g, "&mdash;")}</p>`
    : "";

  const itineraryHtml = `<table width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>${qualifyNote}`;

  const perkItems = combo.perks?.length ? combo.perks : combo.includes;
  const perksHtml = perkItems
    .map(
      (p) =>
        `<tr><td style="padding: 4px 0; font-size: 13px; color: #333; line-height: 1.5;"><span style="color: #B8860B; font-weight: bold;">&#10003;</span>&nbsp;&nbsp;${p.replace(/&(?!amp;|mdash;|asymp;)/g, "&amp;")}</td></tr>`,
    )
    .join("");

  const inclusions: string[] = [];
  if (combo.includesLicense) inclusions.push("racing license");
  if (combo.includedPovPerRacer > 0) inclusions.push("POV race video");
  inclusions.push("VIP lane perks", "bowling shoes");
  const inclusionText =
    inclusions.length > 1
      ? `${inclusions.slice(0, -1).join(", ")} and ${inclusions[inclusions.length - 1]}`
      : inclusions[0];

  return {
    comboName: combo.name,
    durationLabel: (combo.durationLabel ?? "").replace(/≈/g, "&asymp;"),
    tagline:
      `Your premium racing + bowling night at FastTrax and HeadPinz is booked. ` +
      `${inclusionText.charAt(0).toUpperCase()}${inclusionText.slice(1)} are all included ` +
      `&mdash; your experience is paid in full.`,
    itineraryHtml,
    perksHtml: `<table width="100%" cellpadding="0" cellspacing="0" border="0">${perksHtml}</table>`,
  };
}

/** VIP email subject — keeps the reservation number searchable for support. */
export function vipEmailSubject(combo: ComboSpecial, reservationNumber: string): string {
  return `Welcome to the ${combo.name} — Booking #${reservationNumber}`;
}

/**
 * The "Your VIP Voucher" card — the V2 grant's code + QR + entitlement list.
 * Fills `^VipVoucherSection()$`; the route passes "" when the booking has no
 * voucher, so v1 combos collapse the section to nothing.
 *
 * Pure over its args (labels come from the caller via voucherItemLabel) so it
 * unit-tests without the voucher registry. `qrCid` is the inline attachment's
 * content id — cid, never a data: URI, because Gmail/Outlook strip those.
 */
export function buildVipVoucherSectionHtml(args: {
  /** Display form, e.g. "HPW-4K7M-9PQR". */
  codeDisplay: string;
  /** One guest-facing label per voucher item, mint order. */
  itemLabels: string[];
  /** Absolute expiry ISO (from vouchers.expires_at), or null. */
  expiresAt: string | null;
  /** /v/{code} redemption URL. */
  redeemUrl: string;
  /** Inline QR attachment content id. */
  qrCid: string;
}): string {
  const items = args.itemLabels
    .map(
      (l) =>
        `<tr><td style="padding: 3px 0; font-size: 13px; color: #333; line-height: 1.5;"><span style="color: #B8860B; font-weight: bold;">&#10003;</span>&nbsp;&nbsp;${l.replace(/&(?!amp;|mdash;)/g, "&amp;")}</td></tr>`,
    )
    .join("");
  const expiry = args.expiresAt
    ? new Date(args.expiresAt).toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        month: "long",
        day: "numeric",
        year: "numeric",
      })
    : null;
  return `
<tr>
<td style="padding: 0 40px 24px 40px; font-family: Arial, sans-serif;">
<table width="100%" cellpadding="16" cellspacing="0" border="0" style="background-color: #FFFBEB; border: 2px solid #B8860B; border-radius: 6px;">
<tr><td align="center" style="font-size: 15px; font-weight: bold; color: #B8860B; letter-spacing: 1px; text-transform: uppercase;">Your VIP Voucher</td></tr>
<tr><td align="center" style="padding: 6px 0 2px 0;">
  <span style="display: inline-block; font-family: monospace; font-size: 24px; letter-spacing: 2px; color: #1A1A1A; background: #F3E8B8; border-radius: 8px; padding: 10px 16px;">${args.codeDisplay}</span>
</td></tr>
<tr><td align="center" style="padding: 4px 0;">
  <img src="cid:${args.qrCid}" width="160" height="160" alt="Scan this voucher at any kiosk" style="display: block; margin: 0 auto; border: 1px solid #F3E8B8; border-radius: 8px;" />
  <p style="margin: 6px 0 0 0; font-size: 12px; color: #666;">Scan this QR at any kiosk, or open <a href="${args.redeemUrl}" style="color: #B8860B;">your voucher page</a>.</p>
</td></tr>
<tr><td style="padding: 4px 8px;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table>
</td></tr>
<tr><td align="center" style="font-size: 12px; color: #888; line-height: 1.6;">
  ${expiry ? `Valid through <strong style="color: #555;">${expiry}</strong> &mdash; 1 year from your race date. ` : ""}Not transferable. Attractions redeem when available &mdash; book them on a future visit or see Guest Services.
</td></tr>
</table>
</td>
</tr>`;
}

/**
 * VIP confirmation SMS. Returns null when the composed body would break the
 * strict single-segment GSM-7 policy (>160 chars or any non-ASCII char) so
 * the route falls back to the standard body — the VIP SMS is provably never
 * multi-segment (see booking-confirmation/route.ts single-segment comment).
 *
 * The link is followed by a short trailer ("See you soon!") — iOS strips a
 * message-final URL into its own preview bubble, which reads as two separate
 * texts (owner 2026-07-11). Text after the link keeps everything in one
 * bubble; same pattern as the pre-race e-ticket SMS.
 */
export function buildVipSmsBody(args: {
  brandName: string;
  comboName: string;
  dateTime: string;
  cta: string;
  shortConfirm: string;
}): string | null {
  const { brandName, comboName, dateTime, cta, shortConfirm } = args;
  const body = shortConfirm
    ? `${brandName}: Your ${comboName} is booked for ${dateTime}. ${cta}: ${shortConfirm} See you soon!`
    : `${brandName}: Your ${comboName} is booked for ${dateTime}.`;
  if (body.length > 160 || NON_GSM7_RE.test(body)) return null;
  return body;
}
