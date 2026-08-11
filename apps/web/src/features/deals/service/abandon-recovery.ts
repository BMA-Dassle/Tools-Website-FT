/**
 * Abandoned-checkout recovery for prepaid deal packs.
 *
 * WHY THIS COSTS NOTHING TO BUILD. The purchase path persists first, by rule: a
 * `deal_purchases` row carrying name, email and phone exists BEFORE any Square
 * call. So every guest who filled in the buy panel and then closed the tab is
 * already in our database, and always has been — this sweep is the first thing
 * to do anything with them. No new capture, no new consent surface, no tracking.
 *
 * ONE EMAIL, EVER. Somebody who walked away from a card form has not asked to
 * hear from us on a schedule. There is no drip, no second touch, and no reuse of
 * the list for anything else. `abandon_email_sent_at` is claimed with a
 * conditional UPDATE before the send, so two overlapping cron passes cannot both
 * mail the same person, and `listAbandonedDealPurchases` additionally excludes
 * anyone who has since bought or already been mailed about this deal.
 *
 * THE OFFER IS RESOLVED AT SEND TIME, not read off the abandoned row. If a
 * limited offer expired between the abandonment and the sweep, the email simply
 * stops mentioning the bonus. Promising an extra that has already ended, to
 * someone we are asking to come back and pay, would be worse than never mailing
 * at all — the point of a recovery email is that everything in it is still true
 * when they click.
 */

import { sendEmail } from "@/lib/sendgrid";
import {
  claimAbandonEmail,
  listAbandonedDealPurchases,
  releaseAbandonEmail,
  type DealPurchaseRow,
} from "../data/deal-purchases-db";
import { DEAL_LOCATION_INFO, getDeal, type DealCatalogEntry } from "../catalog";
import { dealsAbandonEmailEnabled } from "../flags";
import { formatDealDeadline, money } from "../format";
import { currentDealOffer, type DealOffer } from "./offer";

const CAMPAIGN = "deal_abandon_recovery";
const UNSUB_MAILTO = "mailto:unsubscribe@headpinz.com?subject=Unsubscribe";

/** CAN-SPAM requires a real postal address in every commercial message. */
const POSTAL_ADDRESS = "HeadPinz Family Entertainment, 14513 Global Pkwy, Fort Myers, FL 33913";

const ASM_GROUP = process.env.DEALS_ASM_GROUP_ID ? Number(process.env.DEALS_ASM_GROUP_ID) : null;

function siteOrigin(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || "https://headpinz.com").replace(/\/$/, "");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** SendGrid's managed unsubscribe when a group is configured, mailto otherwise. */
function unsubUrl(): string {
  return ASM_GROUP ? "<%asm_group_unsubscribe_raw_url%>" : UNSUB_MAILTO;
}

/**
 * Back to the exact basket they left, at the venue they picked, with the ad
 * attribution preserved so recovered revenue is attributable to the campaign
 * that earned the click rather than showing up as direct traffic.
 */
export function abandonReturnUrl(row: DealPurchaseRow): string {
  const params = new URLSearchParams({
    location: row.locationKey,
    utm_source: "email",
    utm_medium: "lifecycle",
    utm_campaign: CAMPAIGN,
  });
  if (row.qty > 1) params.set("qty", String(row.qty));
  return `${siteOrigin()}/deals/${row.dealSlug}?${params.toString()}`;
}

/**
 * The urgency line, when there honestly is one.
 *
 * A running offer with a real deadline is the whole message: the pack they were
 * looking at is about to carry less. With no offer running there is nothing true
 * to say about timing, so it says nothing — an invented "hurry!" is what makes
 * recovery mail read as spam.
 *
 * Says out loud exactly what ends. A bonus offer ends with the price unchanged,
 * and the line says so rather than leaving a guest to assume the cheaper
 * reading. A genuine sale price really does go back up, so THAT line states the
 * real before-and-after numbers — never a vague "prices going up!".
 */
export function abandonUrgencyLine(offer: DealOffer): string | null {
  if (!offer.isOfferLive) return null;

  if (offer.unitPriceCents < offer.regularPriceCents) {
    const prices = `${money(offer.unitPriceCents)} instead of the regular ${money(offer.regularPriceCents)}`;
    if (offer.endsAt) {
      return `Right now it is ${prices}, through ${formatDealDeadline(offer.endsAt)}. After that it goes back to the regular price.`;
    }
    if (offer.remaining !== null && offer.remaining > 0) {
      return `Right now it is ${prices}, on the last ${offer.remaining} packs.`;
    }
    return null;
  }

  if (!offer.bonusLabel || offer.bonusItems.length === 0) return null;
  const same = "The price is the same afterwards — the bonus is what goes.";
  if (offer.endsAt) {
    return `Right now it also includes ${offer.bonusLabel}, through ${formatDealDeadline(
      offer.endsAt,
    )}. ${same}`;
  }
  if (offer.remaining !== null && offer.remaining > 0) {
    return `Right now it also includes ${offer.bonusLabel}, on the last ${offer.remaining} packs. ${same}`;
  }
  return null;
}

export interface AbandonEmailContent {
  subject: string;
  html: string;
  text: string;
}

export function renderAbandonEmail(args: {
  row: DealPurchaseRow;
  deal: DealCatalogEntry;
  offer: DealOffer;
}): AbandonEmailContent {
  const { row, deal, offer } = args;
  const firstName = (row.buyerName ?? "").trim().split(/\s+/)[0] || null;
  const venue = DEAL_LOCATION_INFO[row.locationKey].label;
  const url = abandonReturnUrl(row);
  const urgency = abandonUrgencyLine(offer);
  const unsub = unsubUrl();

  const subject = urgency
    ? offer.unitPriceCents < offer.regularPriceCents
      ? `Your ${deal.name} is still here — and still ${money(offer.unitPriceCents)} for now`
      : `Your ${deal.name} is still here — with a bonus that ends soon`
    : `You left your ${deal.name} behind`;

  // The basket, not just the product. "You had 3 in your basket" is the detail
  // that makes a recovery email read as a note about YOUR order rather than a
  // blast about a product — and the quantity is genuinely restored by the link,
  // so saying it is a promise the page keeps.
  const basket =
    row.qty > 1
      ? `You had ${row.qty} in your basket — ${money(offer.unitPriceCents)} each plus tax.`
      : `It is ${money(offer.unitPriceCents)} plus tax.`;

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111">
      <p style="margin:0 0 12px">${firstName ? `Hi ${esc(firstName)},` : "Hi,"}</p>
      <p style="margin:0 0 16px">You were one step away from the
        <strong>${esc(deal.name)}</strong> at ${esc(venue)} — ${esc(deal.tagline)}</p>
      <p style="margin:0 0 18px;color:#555">
        ${esc(basket)} The voucher lands in your inbox straight away with a QR you scan at any
        kiosk. Nothing is booked or scheduled when you buy, so there is no date to commit to.
      </p>
      ${
        urgency
          ? `<p style="margin:0 0 18px;padding:12px 14px;background:#fff4f4;border-left:3px solid #fd5b56;color:#111">
               ${esc(urgency)}
             </p>`
          : ""
      }
      <p style="margin:0 0 22px">
        <a href="${esc(url)}" style="background:#fd5b56;color:#fff;text-decoration:none;
           padding:13px 22px;border-radius:999px;display:inline-block;font-weight:600">
          Finish your order
        </a>
      </p>
      <p style="margin:0 0 6px;color:#888;font-size:12px">
        You are getting this once because you started a HeadPinz deal checkout and did not finish.
        We will not email you about it again.
      </p>
      <p style="margin:0 0 6px;color:#888;font-size:12px">
        <a href="${esc(unsub)}" style="color:#888">Unsubscribe</a>
      </p>
      <p style="margin:0;color:#aaa;font-size:12px">${esc(POSTAL_ADDRESS)}</p>
    </div>
  `.trim();

  const text = [
    firstName ? `Hi ${firstName},` : "Hi,",
    "",
    `You were one step away from the ${deal.name} at ${venue}.`,
    `${basket} The voucher is emailed straight away, and nothing is booked when`,
    "you buy, so there is no date to commit to.",
    ...(urgency ? ["", urgency] : []),
    "",
    `Finish your order: ${url}`,
    "",
    "You are getting this once because you started a HeadPinz deal checkout and did not finish.",
    "We will not email you about it again.",
    `Unsubscribe: ${unsub}`,
    POSTAL_ADDRESS,
  ].join("\n");

  return { subject, html, text };
}

export interface AbandonSweepSummary {
  enabled: boolean;
  dryRun: boolean;
  found: number;
  sent: number;
  skipped: number;
  failed: number;
  recipients: string[];
}

/**
 * One pass. Claim, resolve the live price, send, and release the claim if the
 * send failed so a later pass can retry it.
 */
export async function sweepAbandonedDealCheckouts(
  opts: { dryRun?: boolean; limit?: number; minAgeHours?: number; maxAgeHours?: number } = {},
): Promise<AbandonSweepSummary> {
  const dryRun = opts.dryRun ?? false;
  const summary: AbandonSweepSummary = {
    enabled: dealsAbandonEmailEnabled(),
    dryRun,
    found: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    recipients: [],
  };
  if (!summary.enabled) return summary;

  const rows = await listAbandonedDealPurchases({
    limit: opts.limit,
    minAgeHours: opts.minAgeHours,
    maxAgeHours: opts.maxAgeHours,
  });
  summary.found = rows.length;

  for (const row of rows) {
    const deal = getDeal(row.dealSlug);
    if (!deal) {
      // A deal retired out of the registry. Nothing honest to send about it.
      summary.skipped++;
      continue;
    }

    if (dryRun) {
      summary.recipients.push(row.buyerEmail);
      continue;
    }

    // Claim BEFORE sending: a duplicate email is worse than a missed one, and
    // the release path below covers the send that then fails.
    if (!(await claimAbandonEmail(row.id))) {
      summary.skipped++;
      continue;
    }

    try {
      const offer = await currentDealOffer(deal);
      const { subject, html, text } = renderAbandonEmail({ row, deal, offer });
      const res = await sendEmail({
        to: row.buyerEmail,
        toName: row.buyerName ?? undefined,
        subject,
        html,
        text,
        categories: [CAMPAIGN, `deal_${row.dealSlug}`],
        ...(ASM_GROUP
          ? { asm: { groupId: ASM_GROUP } }
          : { headers: { "List-Unsubscribe": `<${UNSUB_MAILTO}>` } }),
      });
      if (res.ok) {
        summary.sent++;
        summary.recipients.push(row.buyerEmail);
      } else {
        await releaseAbandonEmail(row.id);
        summary.failed++;
        console.warn(`[deal-abandon] send failed for purchase ${row.id}: ${res.error}`);
      }
    } catch (err) {
      await releaseAbandonEmail(row.id);
      summary.failed++;
      console.error(`[deal-abandon] threw for purchase ${row.id}:`, err);
    }
  }

  return summary;
}
