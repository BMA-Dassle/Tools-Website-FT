import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getGfQuoteByShortId, appendAuditLog } from "@/lib/group-function-db";
import ContractClient from "./ContractClient";

export default async function ContractPage(props: {
  params: Promise<{ shortId: string }>;
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const { shortId } = await props.params;
  const { src } = await props.searchParams;
  const quote = await getGfQuoteByShortId(shortId);

  if (!quote) return notFound();

  // Track page view (non-blocking)
  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || hdrs.get("x-real-ip") || null;
  const ua = hdrs.get("user-agent") || null;
  appendAuditLog({
    quoteId: quote.id,
    event: "page_view",
    actorIp: ip || undefined,
    actorUa: ua || undefined,
    metadata: { source: src || "direct", step: quote.deposit_paid_at ? "event" : "review" },
  }).catch(() => {});

  const brand =
    (quote.brand as "headpinz" | "fasttrax") ||
    (quote.center_code === "naples" || quote.center_code === "fort-myers"
      ? "headpinz"
      : "fasttrax");

  return (
    <ContractClient
      quote={{
        id: quote.id,
        contractShortId: quote.contract_short_id!,
        brand,
        centerName: quote.center_name,
        squareLocationId: quote.square_location_id,
        eventName: quote.event_name || "",
        eventDateDisplay: quote.event_date_display || "",
        eventDate: quote.event_date,
        guestCount: quote.guest_count,
        notes: quote.notes,
        guestFirstName: quote.guest_first_name,
        guestLastName: quote.guest_last_name,
        guestEmail: quote.guest_email,
        guestPhone: quote.guest_phone,
        plannerFirst: quote.planner_first,
        plannerLast: quote.planner_last,
        plannerEmail: quote.planner_email,
        plannerPhone: quote.planner_phone,
        totalCents: quote.total_cents,
        taxCents: quote.tax_cents,
        depositDueCents: quote.deposit_due_cents,
        balanceCents: quote.balance_cents,
        lineItems: quote.line_items as Array<{
          name: string;
          price: number;
          qty: number;
          total: number;
        }>,
        depositPaidAt: quote.deposit_paid_at,
        giftCardGan: quote.square_gift_card_gan,
        status: quote.status,
      }}
    />
  );
}
