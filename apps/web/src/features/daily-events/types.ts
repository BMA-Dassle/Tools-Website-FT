/**
 * Daily Events — types ported from the employee portal
 * (src/services/smsTimingService.ts + websitePaymentService.ts), plus the
 * website-native additions (contract info, food-out metadata).
 *
 * All BMI identifiers are STRINGS end-to-end — they are 17-digit ids that
 * exceed Number.MAX_SAFE_INTEGER (see @ft/db raw-ids).
 */

// ── Reservation list (portal Reservation, verbatim shape) ────────────

export interface Reservation {
  id: string;
  number: string;
  kindId?: string;
  kind: string;
  name: string;
  personName: string;
  personId?: string;
  persons: number;
  when: string;
  stop?: string;
  state: string;
  stateId?: string;
  responsible: string;
  balance: number;
  validUntil?: string;
  resourceId?: string;
  resourceName?: string;
  allResourceNames?: string[];
  capacity?: number;
  registeredPersons?: number;
  products?: string | null;
  _isDayPlannerBlock: boolean;
  isMultiLocation?: boolean;
  otherLocationName?: string;
  /** Seeded from our DB (local-first board); replaced by BMI truth when the
   *  date's background fetch lands. */
  _provisional?: boolean;
}

export interface ReservationsResponse {
  reservations: Reservation[];
  source: string;
  clientKey: string;
  note?: string;
}

// ── Reservation detail (portal ReservationDetail, verbatim shape) ────

export interface Schedule {
  id: string;
  projectId: string;
  resourceId: string;
  resourceName: string;
  resourceKind?: string;
  productLines?: string;
  persons: number;
  start: string;
  stop: string;
  isExclusive?: boolean;
  productIds?: string[];
}

export interface Product {
  id: string;
  productId: string;
  projectId: string;
  totalPrice: number;
  quantity: number;
  isVisible?: boolean;
  productName?: string;
  nameOverride?: string;
}

export interface Payment {
  id?: string;
  amount: number;
  payMethodId: string;
  projectId: string;
  payMethodName?: string;
}

export interface Person {
  id?: string;
  personId?: string;
  firstName?: string;
  name?: string;
  birthDate?: string;
  email?: string;
  mobile?: string;
  phone?: string;
  addresses?: Array<{ email?: string; mobile?: string; phone?: string; city?: string }>;
}

export interface ProjectLog {
  id?: string;
  memo?: string;
  action?: string;
  updated?: string;
  updatedBy?: string;
  isPublic?: boolean;
}

export interface ReservationDetail {
  id: string;
  number?: string;
  name?: string;
  when?: string;
  state?: string;
  kind?: string;
  persons?: number;
  responsible?: string;
  validUntil?: string;
  creationDate?: string;
  balance?: number;
  schedules: Schedule[];
  products: Product[];
  payments: Payment[];
  persons_list?: Person[];
  contactPerson?: Person | null;
  logs?: ProjectLog[];
  /** Website-native contract info (replaces the portal's PandaDoc section). */
  contract?: EventContract | null;
}

// ── Website payment overlay (portal WebsitePaymentInfo, verbatim) ────

/** One collected payment on the quote (Square deposit/balance charge). */
export interface WebsitePaymentEntry {
  type: "deposit" | "balance" | "legacy";
  amountCents: number;
  method: string;
  squarePaymentId: string | null;
  squareOrderId?: string | null;
  paidAt: string | null;
}

/** Payment recorded before the website flow existed (BMI legacy import). */
export interface WebsitePriorPayment {
  amountCents: number;
  source: string;
  paidAt: string | null;
}

export interface WebsitePaymentInfo {
  bmiCode: string;
  venue: string;
  status: string;
  isFullyPaid: boolean;
  totalCents: number;
  depositPaidCents: number;
  balanceRemainingCents: number;
  // Present on every response (formatPaymentSummary emits them); optional so
  // stale cache entries and the narrow bulk path stay assignable.
  payments?: WebsitePaymentEntry[];
  priorPayments?: WebsitePriorPayment[];
  giftCardGans?: string[];
  savedCardOnFile?: boolean;
  /** Contract sent or signed — collection is the website's job, not the POS. */
  contractDispatched?: boolean;
  // Single-code detail lookups only (formatPaymentDetail).
  depositDueCents?: number;
  balancePaymentLinkUrl?: string | null;
  depositAttempts?: number;
  depositLastError?: string | null;
  balanceChargeAttempts?: number;
  balanceLastError?: string | null;
}

// ── Website-native contract info (replaces PandaDoc) ─────────────────

export interface EventContract {
  shortId: string | null;
  status: string | null;
  quoteStatus: string;
  signedPdfUrl: string | null;
  contractUrl: string | null;
  /** Guest-facing self-hosted balance payment flow (/contract/{id}/pay). */
  payUrl: string | null;
  balancePaymentLinkUrl: string | null;
  sentAt: string | null;
  signedAt: string | null;
  guestName: string | null;
  guestEmail: string | null;
}

// ── Live Square timeline (Payments tab — reservations-admin idiom) ───

export interface SquareTimelineNode {
  kind: "deposit" | "funding_gift_card" | "balance" | "dayof_order" | "settled_order";
  label: string;
  order?: {
    id: string;
    state: string;
    totalCents: number;
    netDueCents: number;
    /**
     * Money breakdown, stated rather than inferred. A consumer must never derive tax or the
     * service charge by subtracting line items from the total — that is how $22,616.55 of
     * tax sat in the service-charge slot unnoticed (see lib/gf-square-tax.ts).
     * subtotalCents + serviceChargeCents + taxCents = totalCents.
     */
    subtotalCents: number;
    serviceChargeCents: number;
    taxCents: number;
    /** Order contents — line items then service charges (qty empty). */
    lineItems: Array<{ name: string; qty: string; totalCents: number }>;
    tenders: Array<{
      paymentId: string;
      amountCents: number;
      status?: string;
      refundedCents?: number;
    }>;
  };
  giftCard?: { id: string; gan: string; state: string; balanceCents: number };
  /** Node-level failure — the rest of the timeline still renders. */
  error?: string;
}

// ── Contract history timeline (audit log + versions + milestones) ────

export interface ContractHistoryEntry {
  /** ISO timestamp (zoned) the entry occurred. */
  at: string;
  /** Raw event key — audit event name, "version", "milestone:*", "pdf_archived". */
  kind: string;
  /** Humanized one-line label. */
  label: string;
  /** Optional extra line — change list, error message, reason. */
  detail?: string | null;
  /** Who did it (email), when known. */
  actor?: string | null;
  /** Link to an archived signed PDF (pdf_archived entries). */
  pdfUrl?: string | null;
  /** Collapsed repeat count (consecutive guest views). */
  count?: number;
}

// ── Food-out event metadata (portal event-metadata contract) ─────────

export interface EventMetadata {
  foodOutTime: string | null;
  foodOutSource: "ai" | "manual" | null;
  foodOutConfidence: string | null;
  foodOutReasoning: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string | null;
}

// ── Server-side lookup blobs (portal MetadataLookups / LiveReservation) ──

export interface MetadataLookups {
  resourceNames: Record<string, string>;
  productNames: Record<string, string>;
  payMethodNames: Record<string, string>;
  stateNames: Record<string, string>;
  kindNames: Record<string, string>;
  userNames: Record<string, string>;
}

export interface LiveReservation {
  id: string;
  clientKey: string;
  personInfo: string;
  responsible: string;
  referenceNumber: string;
  state: string;
  date: string;
  persons: number;
  products: string | null;
  totalValue: number;
  payments: number;
  balance: number;
}

// ── UI state unions (portal DailyEventsPage) ─────────────────────────

export type ViewType = "group" | "online";

export type StateFilter =
  | "all"
  | "confirmed"
  | "send_contract"
  | "pending_signed"
  | "deposit_requested"
  | "cancelled";

export type WeekTabKey = "last" | "current" | "next";

export interface WaiverThresholds {
  red: number;
  yellow: number;
}
