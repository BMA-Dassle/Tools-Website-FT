"use client";

/**
 * Payments tab.
 *
 * Events WITH a website quote (booked on our site, or PandaDoc-started and
 * converted here): website money is the record — summary grid, a live
 * Square timeline (deposit charge → funding gift card w/ live balance →
 * balance charge → day-of order, reservations-admin idiom), and any prior
 * PandaDoc/BMI payments carried on the quote. BMI's own payment rows are
 * HIDDEN — they're mirror noise for these events.
 *
 * Events WITHOUT a quote (pure PandaDoc/BMI, never touched our site): the
 * BMI payments table is the only record, so it shows.
 */
import { useEffect, useState } from "react";
import {
  fetchSettledCheck,
  fetchSquareTimeline,
  type PosSettlement,
} from "~/features/daily-events/api";
import { fmtCurrency, fmtEventDateTime } from "~/features/daily-events/format";
import { isInternalPayMethod } from "~/features/daily-events/logic";
import { safe } from "~/features/daily-events/print-html";
import type {
  EventContract,
  Payment,
  ReservationDetail,
  SquareTimelineNode,
  WebsitePaymentInfo,
} from "~/features/daily-events/types";
import SquareOrderModal, {
  type OrderTarget,
} from "../../../reservations-admin/modals/SquareOrderModal";
import { isLegacyPaidQuote } from "../../badges";
import DetailSection from "../DetailSection";
import { BLUE_LINK_BTN, GREEN_LINK_BTN, InfoItem, TH, TH_R, td } from "../ui";

const NODE_COLORS: Record<SquareTimelineNode["kind"], string> = {
  deposit: "#22c55e",
  funding_gift_card: "#d4af37",
  balance: "#10b981",
  dayof_order: "#f59e0b",
  settled_order: "#3b82f6",
};

function orderStateColor(state: string): string {
  if (state === "COMPLETED") return "#22c55e";
  if (state === "OPEN") return "#3b82f6";
  return "#ef4444";
}

function ganDisplay(gan: string): string {
  return gan.length > 4 ? `…${gan.slice(-4)}` : gan;
}

// Square Dashboard deep links (seller must be signed in; a stale format just
// lands on the dashboard list, never errors).
const sqOrderUrl = (id: string) => `https://app.squareup.com/dashboard/orders/overview/${id}`;
const sqPaymentUrl = (id: string) => `https://app.squareup.com/dashboard/sales/transactions/${id}`;
const SQ_GIFT_CARDS_URL = "https://app.squareup.com/dashboard/gift-cards";

function SquareLink({ href, title }: { href: string; title: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      style={{
        fontSize: "0.7rem",
        fontWeight: 700,
        color: "#60a5fa",
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      Square ↗
    </a>
  );
}

/** Mono id with click-to-copy (flashes a check — no toast plumbing here). */
function CopyableId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`${value} — click to copy`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      style={{
        background: "var(--ba-input-bg)",
        border: "1px solid var(--ba-input-border)",
        borderRadius: 5,
        color: copied ? "#22c55e" : "var(--ba-muted)",
        padding: "1px 6px",
        fontSize: "0.68rem",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        cursor: "pointer",
      }}
    >
      {copied ? "✓ copied" : `${value.slice(0, 10)}…`}
    </button>
  );
}

export default function PaymentsTab({
  detail,
  websitePayment,
  contract,
  token,
  projectId,
  locationId,
}: {
  detail: ReservationDetail;
  websitePayment: WebsitePaymentInfo | null;
  contract: EventContract | null;
  token: string;
  projectId: string;
  locationId: number;
}) {
  const wp = websitePayment;
  const prior = wp?.priorPayments || [];
  const bmiPayments = (detail.payments || []).filter(
    (pay) => !isInternalPayMethod(safe(pay.payMethodName)),
  );
  const balanceLink = wp?.balancePaymentLinkUrl || contract?.balancePaymentLinkUrl || null;
  const balanceError =
    wp && !wp.isFullyPaid && wp.balanceLastError
      ? { message: wp.balanceLastError, attempts: wp.balanceChargeAttempts || 0 }
      : null;

  // Live Square timeline — lazy on tab mount, only for quote-backed events.
  const [timeline, setTimeline] = useState<SquareTimelineNode[] | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  // Nested order-detail modal (same SquareOrderModal the reservations board
  // uses) — the timeline stays a summary; line items live in the modal.
  const [orderTarget, setOrderTarget] = useState<OrderTarget | null>(null);
  useEffect(() => {
    if (!wp) return;
    let cancelled = false;
    fetchSquareTimeline(token, projectId)
      .then((t) => {
        if (!cancelled) setTimeline(t);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setTimelineError(err instanceof Error ? err.message : "Failed to read Square");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [wp, token, projectId]);

  // Quote-less events are invisible to the settled-close cron, so ask Square
  // directly for a COMPLETED "BMI <event#>" POS check (found live on event
  // 3253, 2026-07-13 — staff closed it out correctly and nothing noticed).
  const [posCheck, setPosCheck] = useState<PosSettlement | null | "loading">("loading");
  useEffect(() => {
    if (wp || !detail.number || !detail.when) {
      setPosCheck(null);
      return;
    }
    let cancelled = false;
    fetchSettledCheck(token, {
      eventNumber: safe(detail.number),
      when: String(detail.when),
      locationId,
    })
      .then((c) => {
        if (!cancelled) setPosCheck(c);
      })
      .catch(() => {
        if (!cancelled) setPosCheck(null);
      });
    return () => {
      cancelled = true;
    };
  }, [wp, token, detail.number, detail.when, locationId]);

  // ── No website quote: BMI is the only record ──
  if (!wp) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {/* POS close-out pickup — the venue rang this event on a Square check */}
        {posCheck === "loading" && (
          <div style={{ fontSize: "0.8rem", color: "var(--ba-muted)" }}>
            Checking Square for a POS close-out…
          </div>
        )}
        {posCheck && posCheck !== "loading" && (
          <div
            style={{
              border: "2px solid rgba(34,197,94,0.4)",
              backgroundColor: "rgba(34,197,94,0.15)",
              borderRadius: 8,
              padding: 16,
              display: "flex",
              alignItems: "baseline",
              gap: "4px 12px",
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: "#4ade80", fontWeight: 700, fontSize: "1rem" }}>
              SETTLED AT THE POS
            </span>
            <span style={{ fontSize: "0.82rem", color: "var(--ba-fg)" }}>
              Check &ldquo;{posCheck.ticketName}&rdquo;
              {posCheck.totalCents != null && <> — {fmtCurrency(posCheck.totalCents / 100)}</>}
              {posCheck.createdAt && <> · {fmtEventDateTime(posCheck.createdAt)}</>}
            </span>
            <SquareLink
              href={sqOrderUrl(posCheck.orderId)}
              title="Open this close-out check in the Square Dashboard"
            />
            <span style={{ fontSize: "0.72rem", color: "var(--ba-muted)", width: "100%" }}>
              This event has no website quote, so any BMI balance below won&rsquo;t clear
              automatically — the Square check is the payment record.
            </span>
          </div>
        )}
        <DetailSection id="payments" title="BMI Payments">
          {bmiPayments.length === 0 ? (
            <div style={{ fontSize: "0.85rem", color: "var(--ba-muted)" }}>
              No payments recorded. This event has no website quote — it lives entirely in
              BMI/PandaDoc.
            </div>
          ) : (
            <div style={{ overflowX: "auto", margin: "0 -16px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={TH}>Method</th>
                    <th style={TH_R}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {bmiPayments.map((pay: Payment, i: number) => (
                    <tr key={safe(pay.id) || i}>
                      <td style={td(i)}>
                        {safe(pay.payMethodName) || `Method ${safe(pay.payMethodId)}`}
                      </td>
                      <td style={td(i, { textAlign: "right", fontWeight: 500 })}>
                        {fmtCurrency(pay.amount || 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DetailSection>
      </div>
    );
  }

  // ── Website quote: our money is the record (BMI rows hidden) ──
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <DetailSection id="website-payments" title="Payment Status">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            columnGap: 16,
            rowGap: 8,
          }}
        >
          <InfoItem label="Status" value={wp.status.replace(/_/g, " ")} />
          <InfoItem label="Total" value={fmtCurrency(wp.totalCents / 100)} />
          {wp.depositDueCents != null && (
            <InfoItem label="Deposit due" value={fmtCurrency(wp.depositDueCents / 100)} />
          )}
          <InfoItem label="Deposit paid" value={fmtCurrency(wp.depositPaidCents / 100)} />
          <InfoItem
            label="Balance remaining"
            value={
              wp.isFullyPaid && wp.balanceRemainingCents <= 0
                ? "Paid in full"
                : fmtCurrency(wp.balanceRemainingCents / 100)
            }
          />
          {wp.savedCardOnFile && <InfoItem label="Card on file" value="Yes" />}
        </div>

        {isLegacyPaidQuote(wp) && (
          <div
            style={{
              backgroundColor: "rgba(168,85,247,0.1)",
              border: "1px solid rgba(168,85,247,0.35)",
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: "0.8rem",
              color: "#c084fc",
              marginTop: 12,
            }}
          >
            <strong>Legacy event</strong> — money was collected in the old PandaDoc/BMI flow, so
            there&rsquo;s no website payment rail to auto-close it. Close it out directly in Square
            at the POS (ticket name &ldquo;BMI {"{event #}"}&rdquo;); the auto-close sweep then
            marks it completed and cancels the unused website day-of order.
          </div>
        )}

        {balanceError && (
          <div
            style={{
              backgroundColor: "rgba(234,179,8,0.12)",
              border: "1px solid rgba(234,179,8,0.35)",
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: "0.8rem",
              color: "#facc15",
              marginTop: 12,
            }}
          >
            Balance charge failing ({balanceError.attempts} attempt
            {balanceError.attempts === 1 ? "" : "s"}): {balanceError.message}
          </div>
        )}

        {(contract?.payUrl || balanceLink) && wp.balanceRemainingCents > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
            {contract?.payUrl && (
              <a
                href={contract.payUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={GREEN_LINK_BTN}
                title="Guest-facing page to pay the remaining balance"
              >
                Pay Balance ↗
              </a>
            )}
            {balanceLink && (
              <a
                href={balanceLink}
                target="_blank"
                rel="noopener noreferrer"
                style={BLUE_LINK_BTN}
                title="Square-hosted balance payment link sent to the guest"
              >
                Square Balance Link ↗
              </a>
            )}
          </div>
        )}
      </DetailSection>

      {/* Live Square timeline (reservations-admin idiom) */}
      <DetailSection id="square-timeline" title="Payment timeline — live from Square">
        {!timeline && !timelineError && (
          <div style={{ fontSize: "0.82rem", color: "var(--ba-muted)" }}>Reading Square…</div>
        )}
        {timelineError && (
          <div style={{ fontSize: "0.8rem", color: "#ef4444" }}>{timelineError}</div>
        )}
        {timeline && timeline.length === 0 && (
          <div style={{ fontSize: "0.82rem", color: "var(--ba-muted)" }}>
            No Square activity yet — nothing has been charged on this quote.
          </div>
        )}
        {timeline && timeline.length > 0 && (
          <div>
            {timeline.map((n, i) => {
              const dot = NODE_COLORS[n.kind];
              const last = i === timeline.length - 1;
              return (
                <div key={i} style={{ display: "flex", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        backgroundColor: n.error ? "#ef4444" : dot,
                        marginTop: 5,
                        flexShrink: 0,
                      }}
                    />
                    {!last && (
                      <span style={{ width: 1, flex: 1, backgroundColor: "var(--ba-border)" }} />
                    )}
                  </div>
                  <div style={{ paddingBottom: last ? 0 : 16, minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "baseline",
                        flexWrap: "wrap",
                        fontSize: "0.85rem",
                        fontWeight: 600,
                      }}
                    >
                      {n.label}
                      {n.order && (
                        <>
                          <span
                            style={{
                              fontSize: "0.62rem",
                              fontWeight: 700,
                              padding: "1px 6px",
                              borderRadius: 4,
                              color: orderStateColor(n.order.state),
                              backgroundColor: `${orderStateColor(n.order.state)}20`,
                              border: `1px solid ${orderStateColor(n.order.state)}40`,
                            }}
                          >
                            {n.order.state}
                          </span>
                          <span style={{ fontVariantNumeric: "tabular-nums" }}>
                            {fmtCurrency(n.order.totalCents / 100)}
                          </span>
                          {n.order.netDueCents > 0 && (
                            <span style={{ color: "#f59e0b", fontSize: "0.75rem" }}>
                              {fmtCurrency(n.order.netDueCents / 100)} due
                            </span>
                          )}
                        </>
                      )}
                      {n.giftCard && (
                        <>
                          <span
                            style={{
                              fontSize: "0.62rem",
                              fontWeight: 700,
                              padding: "1px 6px",
                              borderRadius: 4,
                              color: n.giftCard.state === "ACTIVE" ? "#22c55e" : "var(--ba-muted)",
                              border: "1px solid var(--ba-border)",
                            }}
                          >
                            {n.giftCard.state}
                          </span>
                          <span style={{ fontVariantNumeric: "tabular-nums" }}>
                            {fmtCurrency(n.giftCard.balanceCents / 100)} balance
                          </span>
                        </>
                      )}
                    </div>
                    {/* One compact meta line — line items live in the nested
                        order modal, not dumped inline. */}
                    <div
                      style={{
                        display: "flex",
                        gap: "4px 12px",
                        flexWrap: "wrap",
                        marginTop: 4,
                        alignItems: "center",
                        fontSize: "0.75rem",
                        color: "var(--ba-muted)",
                      }}
                    >
                      {n.order && (
                        <>
                          {n.order.lineItems.length > 0 && (
                            <span>
                              {n.order.lineItems.length} item
                              {n.order.lineItems.length === 1 ? "" : "s"}
                            </span>
                          )}
                          {n.order.tenders.map((t) => (
                            <span key={t.paymentId}>
                              {fmtCurrency(t.amountCents / 100)} paid
                              {t.refundedCents ? (
                                <span style={{ color: "#ef4444" }}>
                                  {" "}
                                  · {fmtCurrency(t.refundedCents / 100)} refunded
                                </span>
                              ) : null}{" "}
                              <SquareLink
                                href={sqPaymentUrl(t.paymentId)}
                                title="Open this payment in the Square Dashboard"
                              />
                            </span>
                          ))}
                          <button
                            type="button"
                            onClick={() =>
                              setOrderTarget({
                                guestName: `${safe(detail.name) || n.label}`,
                                squareDayofOrderId: n.order?.id ?? null,
                                rewardDiscountCents: 0,
                              })
                            }
                            style={{ ...BLUE_LINK_BTN, fontSize: "0.72rem" }}
                          >
                            Order details
                          </button>
                          <SquareLink
                            href={sqOrderUrl(n.order.id)}
                            title="Open this order in the Square Dashboard"
                          />
                        </>
                      )}
                      {n.giftCard?.gan && (
                        <span>
                          GC {ganDisplay(n.giftCard.gan)} <CopyableId value={n.giftCard.gan} />{" "}
                          <SquareLink
                            href={SQ_GIFT_CARDS_URL}
                            title="Open Square gift cards — paste the copied GAN to find this card"
                          />
                        </span>
                      )}
                    </div>
                    {n.error && (
                      <div style={{ marginTop: 4, fontSize: "0.72rem", color: "#ef4444" }}>
                        Couldn&rsquo;t read this from Square: {n.error}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DetailSection>

      {/* Prior PandaDoc/BMI money carried onto the quote (conversions) */}
      {prior.length > 0 && (
        <DetailSection id="prior-payments" title="Prior Payments (before website conversion)">
          <div style={{ overflowX: "auto", margin: "0 -16px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={TH}>Source</th>
                  <th style={TH}>Paid</th>
                  <th style={TH_R}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {prior.map((p, i) => (
                  <tr key={i}>
                    <td style={td(i)}>PandaDoc / BMI</td>
                    <td style={td(i, { whiteSpace: "nowrap" })}>
                      {p.paidAt ? fmtEventDateTime(p.paidAt) : "—"}
                    </td>
                    <td style={td(i, { textAlign: "right", fontWeight: 500 })}>
                      {fmtCurrency(p.amountCents / 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DetailSection>
      )}

      {/* Nested Square order modal — paints over the event modal. */}
      {orderTarget && (
        <SquareOrderModal target={orderTarget} token={token} onClose={() => setOrderTarget(null)} />
      )}
    </div>
  );
}
