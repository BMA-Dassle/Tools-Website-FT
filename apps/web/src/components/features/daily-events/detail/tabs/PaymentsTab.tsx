"use client";

/**
 * Payments tab — the website payment flow (deposit → balance → paid) from
 * group_function_quotes, followed by BMI's own payment rows. Website money
 * is the source of truth for group functions (the BMI balance is unreliable
 * — same reason the board overlays website payments on the list).
 */
import { fmtCurrency, fmtEventDateTime } from "~/features/daily-events/format";
import { isInternalPayMethod } from "~/features/daily-events/logic";
import { safe } from "~/features/daily-events/print-html";
import type {
  EventContract,
  Payment,
  ReservationDetail,
  WebsitePaymentInfo,
} from "~/features/daily-events/types";
import DetailSection from "../DetailSection";
import { BLUE_LINK_BTN, GREEN_LINK_BTN, InfoItem, TH, TH_R, td } from "../ui";

const ENTRY_LABEL: Record<string, string> = {
  deposit: "Deposit",
  balance: "Balance",
  legacy: "Legacy",
};

export default function PaymentsTab({
  detail,
  websitePayment,
  contract,
}: {
  detail: ReservationDetail;
  websitePayment: WebsitePaymentInfo | null;
  contract: EventContract | null;
}) {
  const wp = websitePayment;
  const entries = wp?.payments || [];
  const prior = wp?.priorPayments || [];
  const bmiPayments = (detail.payments || []).filter(
    (pay) => !isInternalPayMethod(safe(pay.payMethodName)),
  );
  const balanceLink = wp?.balancePaymentLinkUrl || contract?.balancePaymentLinkUrl || null;
  const showFlowLinks = !!(contract?.payUrl || balanceLink);
  const balanceError =
    wp && !wp.isFullyPaid && wp.balanceLastError
      ? { message: wp.balanceLastError, attempts: wp.balanceChargeAttempts || 0 }
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Website payment flow summary */}
      {wp ? (
        <DetailSection id="website-payments" title="Website Payment Flow">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
              columnGap: 16,
              rowGap: 8,
              marginBottom: entries.length > 0 || showFlowLinks ? 14 : 0,
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
            {(wp.giftCardGans || []).length > 0 && (
              <InfoItem label="Gift card" value={(wp.giftCardGans || []).join(", ")} />
            )}
          </div>

          {balanceError && (
            <div
              style={{
                backgroundColor: "rgba(234,179,8,0.12)",
                border: "1px solid rgba(234,179,8,0.35)",
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: "0.8rem",
                color: "#facc15",
                marginBottom: 14,
              }}
            >
              Balance charge failing ({balanceError.attempts} attempt
              {balanceError.attempts === 1 ? "" : "s"}): {balanceError.message}
            </div>
          )}

          {entries.length > 0 && (
            <div style={{ overflowX: "auto", margin: "0 -16px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={TH}>Payment</th>
                    <th style={TH}>Method</th>
                    <th style={TH}>Paid</th>
                    <th style={TH}>Square payment</th>
                    <th style={TH_R}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((p, i) => (
                    <tr key={p.squarePaymentId || i}>
                      <td style={td(i, { fontWeight: 600 })}>{ENTRY_LABEL[p.type] || p.type}</td>
                      <td style={td(i)}>{p.method}</td>
                      <td style={td(i, { whiteSpace: "nowrap" })}>
                        {p.paidAt ? fmtEventDateTime(p.paidAt) : "—"}
                      </td>
                      <td
                        style={td(i, {
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          fontSize: "0.75rem",
                          color: "var(--ba-muted)",
                          wordBreak: "break-all",
                        })}
                      >
                        {p.squarePaymentId || "—"}
                      </td>
                      <td style={td(i, { textAlign: "right", fontWeight: 500 })}>
                        {fmtCurrency(p.amountCents / 100)}
                      </td>
                    </tr>
                  ))}
                  {prior.map((p, i) => (
                    <tr key={`prior-${i}`}>
                      <td style={td(entries.length + i, { fontWeight: 600 })}>Prior (BMI)</td>
                      <td style={td(entries.length + i)}>{p.source}</td>
                      <td style={td(entries.length + i, { whiteSpace: "nowrap" })}>
                        {p.paidAt ? fmtEventDateTime(p.paidAt) : "—"}
                      </td>
                      <td style={td(entries.length + i, { color: "var(--ba-muted)" })}>—</td>
                      <td style={td(entries.length + i, { textAlign: "right", fontWeight: 500 })}>
                        {fmtCurrency(p.amountCents / 100)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {showFlowLinks && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
              {contract?.payUrl && (
                <a
                  href={contract.payUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={GREEN_LINK_BTN}
                  title="Guest-facing balance payment page"
                >
                  Payment Flow ↗
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
      ) : (
        <DetailSection id="website-payments" title="Website Payment Flow">
          <div style={{ fontSize: "0.85rem", color: "var(--ba-muted)" }}>
            No website quote for this event — it was booked and paid outside the group-function flow
            (BMI payments below are the record).
          </div>
        </DetailSection>
      )}

      {/* BMI payments (filtered — hide BMI internal methods) */}
      {bmiPayments.length > 0 && (
        <DetailSection id="payments" title="BMI Payments">
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
        </DetailSection>
      )}
    </div>
  );
}
