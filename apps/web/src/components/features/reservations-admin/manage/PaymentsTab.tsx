"use client";

/**
 * Manage Reservation — Payments tab: live Square timeline for the whole
 * money group (deposit → funding gift card → day-of order(s) → store-credit
 * outcome). Fetched lazily when the tab first activates; every amount is
 * read live from Square, ids are copyable, and a node-level error never
 * blanks the rest of the timeline.
 */
import { useEffect, useState } from "react";
import { dollars, ganDisplay } from "~/features/reservations-admin/format";
import type { PaymentTimeline, TimelineNode } from "~/features/reservations-admin/service";
import { Card, CopyId } from "./ui";

const NODE_COLORS: Record<TimelineNode["kind"], string> = {
  deposit: "#22c55e",
  funding_gift_card: "#d4af37",
  dayof_order: "#f59e0b",
  store_credit: "#ef4444",
};

// Square Dashboard transaction deep link (seller must be signed in; a stale
// format just lands on the transactions list, never errors).
const sqTransactionUrl = (paymentId: string, locationId?: string) =>
  `https://app.squareup.com/dashboard/sales/transactions/${paymentId}` +
  (locationId ? `/by-unit/${locationId}` : "");

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

function orderStateColor(state: string): string {
  if (state === "COMPLETED") return "#22c55e";
  if (state === "OPEN") return "#3b82f6";
  return "#ef4444";
}

/** "Card on file" status line from the card-vault provenance row. */
function savedCardLine(card: NonNullable<PaymentTimeline["savedCard"]>): {
  text: string;
  color: string;
} {
  const label = `Card on file: ${(card.brand || "CARD").toUpperCase()} •${card.last4 || "????"}`;
  if (card.disabledAt) {
    const removed = new Date(card.disabledAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return { text: `${label} — removed ${removed}`, color: "var(--ba-muted)" };
  }
  if (card.permanentConsent) {
    return { text: `${label} — saved permanently (guest opted in)`, color: "#22c55e" };
  }
  if (!card.weAdded) {
    return { text: `${label} — on guest's account (pre-existing)`, color: "#22c55e" };
  }
  return {
    text: `${label} — temporary, auto-removes ~72h after visit`,
    color: "#f59e0b",
  };
}

export default function PaymentsTab({
  payments,
  paymentsError,
  paymentsLoading,
  loadPayments,
  onCopied,
  neonId,
  token,
}: {
  payments: PaymentTimeline | null;
  paymentsError: string | null;
  paymentsLoading: boolean;
  loadPayments: () => Promise<void>;
  onCopied: (msg: string) => void;
  /** Enable the "keep card permanently" action (admin consent grant). */
  neonId?: number;
  token?: string;
}) {
  const [consentBusy, setConsentBusy] = useState(false);

  // Lazy fetch on first activation.
  useEffect(() => {
    if (!payments && !paymentsLoading && !paymentsError) void loadPayments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grantConsent = async (): Promise<void> => {
    if (!neonId || !token || consentBusy) return;
    setConsentBusy(true);
    try {
      const res = await fetch(
        `/api/admin/reservations/card-consent?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ neonId }),
        },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        onCopied(`Could not mark permanent (${data.error ?? res.status})`);
        return;
      }
      onCopied("Card marked permanent — it will never auto-remove");
      await loadPayments();
    } catch {
      onCopied("Could not mark permanent (network error)");
    } finally {
      setConsentBusy(false);
    }
  };

  return (
    <Card title="Payment timeline — live from Square">
      {paymentsLoading && (
        <div style={{ color: "var(--ba-muted)", fontSize: "0.82rem", padding: "0.5rem 0" }}>
          Reading Square…
        </div>
      )}
      {paymentsError && (
        <div
          style={{
            padding: "0.5rem 0.75rem",
            borderRadius: 8,
            backgroundColor: "rgba(239,68,68,0.12)",
            border: "1px solid rgba(239,68,68,0.3)",
            fontSize: "0.78rem",
            color: "#ef4444",
          }}
        >
          {paymentsError}
        </div>
      )}
      {payments && payments.nodes.length === 0 && (
        <div style={{ color: "var(--ba-muted)", fontSize: "0.82rem" }}>
          No Square activity on this booking (free / walk-in).
        </div>
      )}
      {payments && payments.nodes.length > 0 && (
        <div>
          {payments.nodes.map((n, i) => {
            const dot = NODE_COLORS[n.kind];
            const last = i === payments.nodes.length - 1;
            return (
              <div key={i} style={{ display: "flex", gap: 12 }}>
                {/* Rail */}
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
                {/* Node body */}
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
                          {dollars(n.order.totalCents)}
                        </span>
                        {n.order.netDueCents > 0 && (
                          <span style={{ color: "#f59e0b", fontSize: "0.75rem" }}>
                            {dollars(n.order.netDueCents)} due
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
                          {dollars(n.giftCard.balanceCents)} balance
                        </span>
                      </>
                    )}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                      marginTop: 4,
                      alignItems: "center",
                    }}
                  >
                    {n.order && (
                      <CopyId
                        value={n.order.id}
                        label={`${n.order.id.slice(0, 10)}…`}
                        onCopied={onCopied}
                      />
                    )}
                    {n.giftCard?.gan && (
                      <CopyId
                        value={n.giftCard.gan}
                        label={ganDisplay(n.giftCard.gan)}
                        onCopied={onCopied}
                      />
                    )}
                    {n.order?.tenders.map((t) => (
                      <span
                        key={t.paymentId}
                        style={{ fontSize: "0.72rem", color: "var(--ba-muted)" }}
                      >
                        {dollars(t.amountCents)} tender
                        {t.status ? ` · ${t.status}` : ""}
                        {t.refundedCents ? (
                          <span style={{ color: "#ef4444" }}>
                            {" "}
                            · {dollars(t.refundedCents)} refunded
                          </span>
                        ) : null}{" "}
                        <CopyId
                          value={t.paymentId}
                          label={`${t.paymentId.slice(0, 8)}…`}
                          onCopied={onCopied}
                        />
                        {/* A tender on an order = a captured charge; explicit
                            non-COMPLETED statuses (failed/canceled) get no link. */}
                        {(!t.status || t.status === "COMPLETED") && (
                          <>
                            {" "}
                            <SquareLink
                              href={sqTransactionUrl(t.paymentId, n.order?.locationId)}
                              title="Open this transaction in the Square Dashboard"
                            />
                          </>
                        )}
                      </span>
                    ))}
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
      {payments?.savedCard && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: "1px solid var(--ba-border)",
            fontSize: "0.8rem",
            display: "flex",
            gap: 8,
            alignItems: "baseline",
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              backgroundColor: savedCardLine(payments.savedCard).color,
              flexShrink: 0,
              alignSelf: "center",
            }}
          />
          <span style={{ color: savedCardLine(payments.savedCard).color, fontWeight: 600 }}>
            {savedCardLine(payments.savedCard).text}
          </span>
          {neonId != null &&
            token &&
            payments.savedCard.weAdded &&
            !payments.savedCard.permanentConsent &&
            !payments.savedCard.disabledAt && (
              <button
                type="button"
                disabled={consentBusy}
                onClick={() => void grantConsent()}
                title="Guest agreed (phone/desk) to keep their card on file — skips the 72h auto-removal"
                style={{
                  background: "var(--ba-input-bg)",
                  border: "1px solid var(--ba-input-border)",
                  borderRadius: 6,
                  color: "var(--ba-muted)",
                  padding: "2px 8px",
                  fontSize: "0.72rem",
                  cursor: consentBusy ? "wait" : "pointer",
                }}
              >
                {consentBusy ? "Saving…" : "Keep permanently"}
              </button>
            )}
        </div>
      )}
      {payments && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            onClick={() => void loadPayments()}
            style={{
              background: "var(--ba-input-bg)",
              border: "1px solid var(--ba-input-border)",
              borderRadius: 6,
              color: "var(--ba-muted)",
              padding: "3px 10px",
              fontSize: "0.72rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Refresh from Square
          </button>
        </div>
      )}
    </Card>
  );
}
