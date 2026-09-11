import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getGfQuoteByShortId, appendAuditLog } from "@/lib/group-function-db";
import BalancePayClient from "./BalancePayClient";

/**
 * Self-hosted balance payment page — replaces Square-hosted payment links.
 *
 * Linked from the 72-hour balance email/SMS when the saved-card auto-charge
 * fails (or there is no card on file). Payment posts to
 * /api/group-function/balance-pay, which updates the database synchronously,
 * so the event record can never sit paid-but-unreconciled.
 */
export default async function BalancePayPage(props: {
  params: Promise<{ shortId: string }>;
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const { shortId } = await props.params;
  const { src } = await props.searchParams;
  const quote = await getGfQuoteByShortId(shortId);

  if (!quote) return notFound();

  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || hdrs.get("x-real-ip") || null;
  const ua = hdrs.get("user-agent") || null;
  appendAuditLog({
    quoteId: quote.id,
    event: "balance_pay_view",
    actorIp: ip || undefined,
    actorUa: ua || undefined,
    metadata: { source: src || "direct", status: quote.status },
  }).catch(() => {});

  // Real money outstanding. Universal rule: amount due = total − collected (see the
  // collected_cents schema comment). NEVER derive "settled" from balance_paid_at: it is a
  // latch the balance charge sets and NOTHING clears when an event is later RE-PRICED, so a
  // paid-then-repriced event ("group added food after signing") rendered "You're all set —
  // balance paid in full, $0.00 due" while $199.63 was genuinely owed, on the very page the
  // admin's PAY BALANCE button links to (event 3370, 2026-09-11). The latch itself must stay
  // — resign-settle reads it as `wasPaidInFull` to decide whether to charge the delta.
  const outstandingCents = Math.max(0, quote.total_cents - quote.collected_cents);

  // This page's form posts to /api/group-function/balance-pay, which charges `balance_cents`
  // and rejects any status outside deposit_paid / balance_link_sent. Keep this gate identical
  // to that route's guards so the page can never offer a payment the API will refuse, nor
  // display an amount other than the one that actually gets charged.
  const payable =
    (quote.status === "deposit_paid" || quote.status === "balance_link_sent") &&
    !quote.balance_paid_at &&
    quote.balance_cents > 0;

  // One of: pay (balance due), resign (the price changed and a re-sign is pending — the
  // difference is settled on the contract page by resign-settle, never here), paid (settled),
  // contract (deposit not collected yet — sign first), closed (cancelled/denied/expired or
  // anything else odd — don't show a payment form OR a false "all set").
  const state: "pay" | "resign" | "paid" | "contract" | "closed" = !quote.deposit_paid_at
    ? "contract"
    : quote.status === "resign_required"
      ? "resign"
      : payable
        ? "pay"
        : outstandingCents <= 0 && !["cancelled", "denied", "expired"].includes(quote.status)
          ? "paid"
          : "closed";

  return (
    <BalancePayClient
      quote={{
        contractShortId: quote.contract_short_id!,
        centerName: quote.center_name,
        squareLocationId: quote.square_location_id,
        eventName: quote.event_name || "",
        eventNumber: quote.event_number,
        eventDateDisplay: quote.event_date_display || "",
        guestFirstName: quote.guest_first_name,
        totalCents: quote.total_cents,
        depositDueCents: quote.deposit_due_cents,
        balanceCents: quote.balance_cents,
        collectedCents: quote.collected_cents,
        outstandingCents,
        balancePaidAt: quote.balance_paid_at,
        plannerFirst: quote.planner_first,
        plannerEmail: quote.planner_email,
        savedCardLast4: quote.saved_card_last4,
        savedCardBrand: quote.saved_card_brand,
        hasSavedCard: Boolean(quote.saved_card_id),
        declineMessage: quote.balance_decline_message,
        declinedAt: quote.balance_declined_at,
        state,
      }}
    />
  );
}
