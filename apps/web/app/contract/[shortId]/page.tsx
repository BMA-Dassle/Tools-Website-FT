import { notFound } from "next/navigation";
import { getGfQuoteByShortId } from "@/lib/group-function-db";
import ContractClient from "./ContractClient";

export default async function ContractPage(props: { params: Promise<{ shortId: string }> }) {
  const { shortId } = await props.params;
  const quote = await getGfQuoteByShortId(shortId);

  if (!quote) return notFound();

  const brand =
    quote.center_code === "naples" || quote.center_code === "fort-myers" ? "headpinz" : "fasttrax";

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
      }}
    />
  );
}
