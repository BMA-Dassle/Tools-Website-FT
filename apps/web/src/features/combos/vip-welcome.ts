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
 * VIP confirmation SMS. Returns null when the composed body would break the
 * strict single-segment GSM-7 policy (>160 chars or any non-ASCII char) so
 * the route falls back to the standard body — the VIP SMS is provably never
 * multi-segment (see booking-confirmation/route.ts single-segment comment).
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
    ? `${brandName}: Your ${comboName} is booked for ${dateTime}. ${cta}: ${shortConfirm}`
    : `${brandName}: Your ${comboName} is booked for ${dateTime}.`;
  if (body.length > 160 || NON_GSM7_RE.test(body)) return null;
  return body;
}
