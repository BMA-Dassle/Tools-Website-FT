/**
 * Web sales — the adapter contract.
 *
 * ONE board over every non-reservation thing we sell on the website. Deal packs
 * were the first product to get an admin surface; game-card reloads
 * (`intercard_transactions`) and standalone race packs (`race_pack_purchases`)
 * are the same shape of problem — a guest paid us online, ops needs to see it,
 * resend it, and sometimes give the money back — and had no board at all.
 *
 * WHY NOT RESERVATIONS ADMIN. It is date- and event-scoped: the API requires a
 * `date=YYYY-MM-DD` and sorts on a derived `event_at`, and every action route is
 * keyed on `bowling_reservations.neonId`. A voucher pack has a PURCHASE date and
 * an expiry but no event time, and no neonId. It would either vanish from every
 * board day or squat on its purchase date forever.
 *
 * THE SHELL KNOWS NOTHING ABOUT ANY PRODUCT. Everything product-specific lives
 * behind `WebSaleAdapter`; the board renders `WebSaleRow` and nothing else. The
 * acceptance test for this file is that adding a source is ONE new adapter file
 * plus ONE line in `registry.ts`. If a new source needs a change to the board,
 * the contract here is wrong and should be fixed before shipping the adapter.
 *
 * A NOTE ON WHERE LOGIC GOES. `vitest.config.ts` sets `environment: "node"` and
 * this repo has zero `.test.tsx` files — there is no jsdom and no renderer, so a
 * React component CANNOT be tested here. Every decision worth asserting (row
 * projection, capability derivation, cursor codec, CSV, plan hashing) therefore
 * lives in a pure module the component imports, never inside the component.
 * That is the same split `editPlanHelpers.ts` uses, for the same reason.
 */

/**
 * Stable ids of every sale source. One member per shipped (or planned) adapter.
 *
 * A runtime array rather than a bare type union because the cursor codec and the
 * query schema both have to VALIDATE an id that arrived over the wire — a
 * type-only union gives no way to do that, and an unvalidated source id is a
 * string from a URL heading for a registry lookup.
 */
export const SALE_SOURCE_IDS = ["deals", "game-card-reload", "race-pack"] as const;

export type SaleSourceId = (typeof SALE_SOURCE_IDS)[number];

export function isSaleSourceId(v: unknown): v is SaleSourceId {
  return typeof v === "string" && (SALE_SOURCE_IDS as readonly string[]).includes(v);
}

/**
 * Colour semantics shared by EVERY source, so one legend reads the whole board.
 * Sources map their own native statuses onto these — a reader should never have
 * to learn what amber means per product.
 */
export type SaleTone = "ok" | "pending" | "warn" | "danger" | "muted";

export type SaleAction = "resend" | "refund" | "void";

/**
 * Declared PER ROW, not per source.
 *
 * Absent from the array  = this source can NEVER do this, and no UI appears.
 * Present + blockedReason = this source can, but not for THIS row, and here is
 *                           why — the button renders DISABLED with the reason as
 *                           its title.
 *
 * The distinction matters operationally. A button that silently disappears for a
 * temporary condition is a support ticket ("the refund button is gone"); a
 * disabled button labelled "already fully refunded" is an answer. Never express a
 * temporary condition by omitting the capability.
 */
export interface SaleCapability {
  action: SaleAction;
  label: string;
  blockedReason?: string;
}

export type RefundDestination = "card" | "gift_card";

/**
 * `voided` is deliberately NOT a refund. It means the value was killed and the
 * money was deliberately left alone — fraud, a wrong recipient, a chargeback we
 * are contesting. Collapsing the two is how `deal_purchases.refunded_at` came to
 * mean "vouchers voided" while reading like a refund; do not repeat that here.
 */
export type RefundState =
  | { kind: "none" }
  | {
      kind: "partial" | "full";
      refundedCents: number;
      at: string | null;
      destination: RefundDestination | null;
    }
  | { kind: "voided"; at: string; reason: string | null };

/** Who the sale is for. Buyer and recipient differ on a gift. */
export interface SaleParties {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** Non-null only when the value goes to somebody other than the payer. */
  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
}

export interface WebSaleRow {
  /**
   * `${source}:${ref}` — globally unique, stable, and safe as both a React key
   * and a URL parameter (the `?sale=deals:1234` deep link).
   */
  id: string;
  source: SaleSourceId;
  /**
   * Opaque, source-owned handle. THE SHELL NEVER PARSES IT — adapters round-trip
   * it verbatim. This is what lets `race-pack` use a composite key without the
   * board learning anything about BMI person ids (which are raw id strings that
   * must never go through `Number()`).
   */
  ref: string;

  /**
   * ISO instant the board sorts and pages by.
   *
   * MUST be the column the adapter's own `ORDER BY` and keyset comparison use.
   * It is tempting to make this "charge time, falling back to row creation" —
   * don't. A displayed timestamp that differs from the paging key lets the merge
   * reorder rows within a source, and a keyset page boundary computed from one
   * ordering against rows fetched in another skips or repeats sales. If a source
   * wants to show a different instant, it belongs in the timeline or the facts
   * panel, not here.
   */
  soldAt: string;

  buyer: SaleParties;

  product: {
    label: string;
    /** Venue, pack count, gift recipient — whatever disambiguates two same-label sales. */
    sublabel: string | null;
    qty: number;
  };

  money: {
    /** Tax included — what the card was actually charged. */
    paidCents: number;
    subtotalCents: number | null;
    taxCents: number | null;
  };

  status: {
    /** Source-native value, e.g. "scheduled". Used for filtering. */
    code: string;
    /** Presentable, e.g. "Gift scheduled". Used for display. */
    label: string;
    tone: SaleTone;
    /**
     * Non-null = staff should look at this row. Drives the "Needs attention"
     * card and its filter, which is the thing ops will actually use the board
     * for. Keep it a sentence, not a code.
     */
    problem: string | null;
  };

  refund: RefundState;

  attribution: { label: string; utm: Record<string, string> | null };

  venue: { key: string; label: string; brand: "headpinz" | "fasttrax" };

  /** Detail-drawer links, and the Square-id half of the search index. */
  square: { orderId: string | null; paymentIds: string[] };

  /** Folded into the `q` search alongside name/email/phone — voucher codes, txn ids. */
  searchTerms: string[];

  capabilities: SaleCapability[];
}

/**
 * One independently-redeemable thing a sale carries.
 *
 * `unitKey` is the GROUPING handle and the reason this type exists rather than a
 * flat leg list: a refund is offered as "2 of 3 packs", never "4 of 6 legs",
 * because Square can only return whole units of an order line. Legs sharing a
 * `unitKey` refund together or not at all.
 */
export interface SaleLeg {
  /** Stable within the sale, e.g. `${code}#${itemIndex}`. */
  key: string;
  label: string;
  /** A live claim exists — the guest already used this. Not refundable. */
  spent: boolean;
  spentAt: string | null;
  /** Retail value of THIS leg, for the "how much did they already consume" math. */
  valueCents: number;
  unitKey: string;
  unitLabel: string;
}

export interface SaleTimelineEntry {
  at: string;
  label: string;
  detail?: string | null;
  tone?: SaleTone;
}

/** A labelled value for the drawer's facts panel. `href` makes it a link out. */
export interface SaleFact {
  label: string;
  value: string;
  mono?: boolean;
  href?: string;
}

export interface SaleDetail {
  row: WebSaleRow;
  /** Empty for sources with nothing redeemable (a game-card reload is just money). */
  legs: SaleLeg[];
  /** Oldest first. */
  timeline: SaleTimelineEntry[];
  facts: SaleFact[];
}

/* ─────────────────────────────── refunds ─────────────────────────────── */

export interface RefundPlanUnit {
  key: string;
  label: string;
  /** 0 when fully spent or already refunded — the modal renders those disabled. */
  refundableCents: number;
  spentLegLabels: string[];
  alreadyRefunded: boolean;
}

export interface RefundPlanStep {
  kind: string;
  detail: string;
  amountCents?: number;
  fatal: boolean;
}

/**
 * The server's authoritative answer to "what would happen if I refunded this".
 *
 * The modal renders THIS and computes no money of its own. Per-unit cents cannot
 * be summed client-side — tax allocation makes that wrong, and this repo hard-
 * fails on displayed-vs-charged mismatches by rule — so `selectedTotalCents` is
 * always server-computed for the exact selection sent.
 */
export interface RefundPlan {
  /** Echoed on execute. A mismatch is a 409 `plan_stale`, never a silent proceed. */
  planHash: string;
  units: RefundPlanUnit[];
  /** Every unit with `refundableCents > 0` — the modal's default selection, i.e. the unspent value. */
  defaultUnitKeys: string[];
  selectedUnitKeys: string[];
  selectedTotalCents: number;
  paidCents: number;
  refundedCents: number;
  destinations: RefundDestination[];
  warnings: string[];
  steps: RefundPlanStep[];
  /** Typed refusal — the modal jumps straight to its `blocked` phase. */
  blocked: { code: string; message: string } | null;
}

export interface RefundResult {
  refundIds: string[];
  refundedCents: number;
  destination: RefundDestination;
  giftCard?: { giftCardId: string; gan: string; amountCents: number };
  voidedLegs: number;
  notified: { email: boolean; sms: boolean };
  warnings: string[];
}

/* ─────────────────────────────── querying ─────────────────────────────── */

/** Keyset position. Rows STRICTLY older than this, ordered `(soldAt, ref) DESC`. */
export interface SaleCursorPosition {
  soldAt: string;
  ref: string;
}

export interface SaleListQuery {
  /** ET calendar date, YYYY-MM-DD, inclusive. */
  from: string;
  /** ET calendar date, YYYY-MM-DD, inclusive. */
  to: string;
  q?: string;
  /** Source-native status values, already validated against `statusFilters`. */
  status?: string[];
  venue?: string[];
  before: SaleCursorPosition | null;
  limit: number;
}

export interface SaleSummaryExtra {
  label: string;
  value: string;
  sublabel: string | null;
  tone: SaleTone;
}

export interface SaleSummary {
  grossCents: number;
  refundedCents: number;
  saleCount: number;
  /** Packs, cards, races — whatever the source's unit is. */
  unitCount: number;
  problemCount: number;
  /**
   * Source-specific cards, rendered ONLY when this source is filtered alone.
   * This is how a per-product rollup (today's "packs sold · gross · awaiting
   * codes") survives being merged into a generic board instead of being lost.
   */
  extra: SaleSummaryExtra[];
}

/* ─────────────────────────────── the adapter ─────────────────────────── */

export interface ResendArgs {
  ref: string;
  channel: "sms" | "email" | "both";
  overrideEmail: string | null;
  overridePhone: string | null;
  actor: string;
}

export interface ResendOutcome {
  /** null = not attempted on this channel. */
  emailOk: boolean | null;
  smsOk: boolean | null;
  note: string;
}

export interface ExecuteRefundArgs {
  ref: string;
  unitKeys: string[];
  destination: RefundDestination;
  reason: string;
  planHash: string;
  /** Set only after the operator explicitly accepted Square's figure over ours. */
  acceptedCents?: number;
  notifyGuest: boolean;
  actor: string;
}

export interface WebSaleAdapter {
  readonly id: SaleSourceId;
  /** Tab label and CSV filename stem. */
  readonly label: string;
  readonly sublabel: string;
  readonly statusFilters: ReadonlyArray<{ value: string; label: string }>;
  readonly venues: ReadonlyArray<{ key: string; label: string; brand: "headpinz" | "fasttrax" }>;
  /**
   * Actions this source implements AT ALL. The shell hides UI for anything not
   * listed even if a row mistakenly declares the capability — belt and braces,
   * because a typo in a projection must never surface a Refund button on a
   * source that has no `executeRefund`.
   */
  readonly actions: ReadonlyArray<SaleAction>;
  readonly resendChannels: ReadonlyArray<"sms" | "email" | "both">;

  /** Newest-first. MUST return at most `limit`, sorted `(soldAt, ref)` DESC. */
  list(q: SaleListQuery): Promise<WebSaleRow[]>;
  /** Aggregate over the WHOLE matching set, not the current page. */
  summarize(q: Omit<SaleListQuery, "before" | "limit">): Promise<SaleSummary>;
  detail(ref: string): Promise<SaleDetail | null>;

  resend?(a: ResendArgs): Promise<ResendOutcome>;
  /**
   * Rendered in the resend modal's preview block. SERVER-side, off the real send
   * path — never reconstruct the copy client-side, or the preview drifts from
   * what actually goes out and staff start trusting a lie.
   */
  previewResend?(a: {
    ref: string;
    channel: "sms" | "email" | "both";
  }): Promise<{ subject: string | null; text: string }>;

  /** `unitKeys: null` means "plan the default selection". */
  planRefund?(a: { ref: string; unitKeys: string[] | null }): Promise<RefundPlan>;
  executeRefund?(a: ExecuteRefundArgs): Promise<RefundResult>;
  void?(a: {
    ref: string;
    unitKeys: string[] | null;
    reason: string;
    actor: string;
  }): Promise<{ voided: number; note: string }>;
}
