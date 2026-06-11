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

  const payable =
    (quote.status === "deposit_paid" || quote.status === "balance_link_sent") &&
    !quote.balance_paid_at &&
    quote.balance_cents > 0;

  // One of: pay (balance due), paid (settled), contract (deposit not collected
  // yet — sign first), closed (cancelled/denied/expired or anything else odd —
  // don't show a payment form OR a false "all set").
  const state: "pay" | "paid" | "contract" | "closed" = !quote.deposit_paid_at
    ? "contract"
    : payable
      ? "pay"
      : (quote.balance_paid_at || quote.balance_cents <= 0) &&
          !["cancelled", "denied", "expired"].includes(quote.status)
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
        balancePaidAt: quote.balance_paid_at,
        plannerFirst: quote.planner_first,
        plannerEmail: quote.planner_email,
        state,
      }}
    />
  );
}
