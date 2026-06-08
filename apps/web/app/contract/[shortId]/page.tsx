import { notFound } from "next/navigation";
import { headers } from "next/headers";
import {
  getGfQuoteByShortId,
  appendAuditLog,
  getContractVersions,
  diffSnapshots,
  type ContractVersion,
} from "@/lib/group-function-db";
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

  const priorPayments = (quote.prior_payments ?? []) as Array<{ amount: number }>;
  const priorDepositCents = Math.round(
    priorPayments.reduce((sum, p) => sum + (p.amount || 0), 0) * 100,
  );

  // Fetch contract versions for history display
  const versions = await getContractVersions(quote.id).catch(() => [] as ContractVersion[]);

  // Compute diffs between the two most recent versions for the "What Changed" card
  let latestDiffs: Array<{ field: string; label: string; before: string; after: string }> = [];
  let latestChanges: string[] = [];
  if (versions.length >= 2) {
    const prev = versions[versions.length - 2];
    const curr = versions[versions.length - 1];
    latestDiffs = diffSnapshots(prev.snapshot, curr.snapshot);
    latestChanges = curr.changes || [];
  }

  const signedPdfHistory = (quote.signed_pdf_history ?? []) as Array<{
    url: string;
    signedAt: string | null;
    archivedAt: string;
    reason: string;
  }>;

  return (
    <ContractClient
      quote={{
        id: quote.id,
        contractShortId: quote.contract_short_id!,
        brand,
        centerName: quote.center_name,
        squareLocationId: quote.square_location_id,
        eventName: quote.event_name || "",
        eventNumber: quote.event_number,
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
        isTaxExempt: quote.is_tax_exempt,
        isPostPaid: quote.approval_required || false,
        priorDepositCents:
          !quote.deposit_paid_at && quote.status === "contract_sent" ? priorDepositCents : 0,
        savedCardLast4: quote.saved_card_last4,
        savedCardBrand: quote.saved_card_brand,
        hasCardOnFile: Boolean(quote.saved_card_id),
        isWinback: quote.is_winback,
        incentiveCents: quote.incentive_cents,
        versions: versions.map((v) => ({
          versionNumber: v.version_number,
          snapshot: {
            ...v.snapshot,
            line_items: v.snapshot.line_items as Array<{
              name: string;
              price: number;
              qty: number;
              total: number;
            }>,
          },
          changes: v.changes,
          trigger: v.trigger,
          createdAt: v.created_at,
        })),
        latestDiffs,
        latestChanges,
        signedPdfHistory,
      }}
    />
  );
}
