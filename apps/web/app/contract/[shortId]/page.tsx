import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { head } from "@vercel/blob";
import {
  getGfQuoteByShortId,
  appendAuditLog,
  getContractVersions,
  diffSnapshots,
  type ContractVersion,
} from "@/lib/group-function-db";
import ContractClient from "./ContractClient";

/**
 * Docs uploaded before tax_file_url was persisted at capture only exist in
 * Blob storage at the deterministic per-quote path — probe for them.
 * Returns a brand-domain path (served via the next.config /tax-exempt/*
 * rewrite), never the raw blob-store URL.
 */
async function findLegacyTaxDoc(shortId: string): Promise<string | null> {
  const probes = ["pdf", "jpg", "jpeg", "png"].map((ext) => {
    const pathname = `tax-exempt/${shortId}-dr14.${ext}`;
    return head(pathname).then(
      (b) => ({ pathname, uploadedAt: b.uploadedAt.getTime() }),
      () => null,
    );
  });
  const found = (await Promise.all(probes)).filter(Boolean) as Array<{
    pathname: string;
    uploadedAt: number;
  }>;
  // A guest may have uploaded under several extensions — show only the latest.
  found.sort((a, b) => b.uploadedAt - a.uploadedAt);
  return found[0]?.pathname ?? null;
}

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

  // Existing DR-14 doc: DB first, else probe Blob for uploads that predate
  // capture-time persistence. Always surfaced as a brand-domain URL.
  let existingTaxDocUrl: string | null = null;
  if (quote.is_tax_exempt) {
    if (quote.tax_file_url) {
      // Rows written before the brand-domain switch hold raw blob-store URLs.
      existingTaxDocUrl = quote.tax_file_url.replace(
        /^https:\/\/[^/]+\.blob\.vercel-storage\.com\//,
        `${quote.base_url || "https://headpinz.com"}/`,
      );
    } else {
      const legacyPath = await findLegacyTaxDoc(quote.contract_short_id!).catch(() => null);
      if (legacyPath) {
        existingTaxDocUrl = `${quote.base_url || "https://headpinz.com"}/${legacyPath}`;
      }
    }
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
        collectedCents: quote.collected_cents,
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
        existingTaxDocUrl,
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
