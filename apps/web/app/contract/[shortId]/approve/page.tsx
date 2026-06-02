import { notFound } from "next/navigation";
import { getGfQuoteByShortId } from "@/lib/group-function-db";
import ApproveClient from "./ApproveClient";

export default async function ApprovePage(props: {
  params: Promise<{ shortId: string }>;
  searchParams: Promise<{ [key: string]: string | undefined }>;
}) {
  const { shortId } = await props.params;
  const { for: approverEmail } = await props.searchParams;
  const quote = await getGfQuoteByShortId(shortId);
  if (!quote) return notFound();

  const lineItems = (quote.line_items || []) as Array<{
    name: string;
    price: number;
    qty: number;
    total: number;
  }>;

  return (
    <ApproveClient
      shortId={shortId}
      eventName={quote.event_name || ""}
      eventDate={quote.event_date_display || ""}
      centerName={quote.center_name}
      guestName={`${quote.guest_first_name} ${quote.guest_last_name}`}
      guestEmail={quote.guest_email}
      guestPhone={quote.guest_phone}
      guestCount={quote.guest_count}
      plannerName={
        quote.planner_first ? `${quote.planner_first} ${quote.planner_last || ""}`.trim() : null
      }
      plannerEmail={quote.planner_email}
      plannerPhone={quote.planner_phone}
      totalCents={quote.total_cents}
      taxCents={quote.tax_cents}
      lineItems={lineItems}
      notes={quote.notes}
      status={quote.status}
      approvedBy={quote.approved_by}
      approvedAt={quote.approved_at}
      deniedBy={quote.denied_by}
      denialReason={quote.denial_reason}
      approverEmail={approverEmail || null}
    />
  );
}
