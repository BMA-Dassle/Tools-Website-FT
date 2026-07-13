"use client";

/**
 * Event detail body — faithful port of the portal's ReservationDetailPage.tsx
 * (the modal content), restyled to the board idiom (inline styles on `--ba-*`
 * vars, no shadcn).
 *
 * Dropped from the portal per owner decision: Staff/party-assignment UI, the
 * PandaDoc section (replaced by the website-native ContractSection fed from
 * `detail.contract`), the "Full Page" button and router plumbing, and the
 * settings fetch for waiver thresholds (constants now). The DUAL LOCATION
 * badge is also not shown here: the portal read `isMultiLocation` from router
 * state passed by its list page — the detail payload itself doesn't carry it.
 */
import { useEffect, useState } from "react";
import { fetchReservationDetail, getPayment } from "~/features/daily-events/api";
import {
  DEFAULT_WAIVER_THRESHOLDS,
  WAIVER_RESOURCE_KEYWORDS,
} from "~/features/daily-events/constants";
import {
  eventDateOf,
  fmtCurrency,
  fmtEventDateTime,
  fmtEventTime,
  personDisplayName,
} from "~/features/daily-events/format";
import {
  BADGE_PALETTES,
  type BadgePalette,
  isInternalPayMethod,
  isServiceChargeProduct,
} from "~/features/daily-events/logic";
import { openHtmlReport } from "~/features/daily-events/print";
import {
  generateAttendeesHtml,
  generateEventDetailHtml,
  isDepositPaidViaWebsite,
  isFullyPaidViaWebsite,
  safe,
} from "~/features/daily-events/print-html";
import type {
  Payment,
  Person,
  Product,
  ProjectLog,
  ReservationDetail,
  Schedule,
  WebsitePaymentInfo,
} from "~/features/daily-events/types";
import { DepositPill, PaidPill, Spinner } from "../badges";
import ContractSection from "./ContractSection";
import DetailErrorBoundary from "./DetailErrorBoundary";
import DetailSection from "./DetailSection";
import EventMetadataPanel from "./EventMetadataPanel";

/** Portal detail-header badge — deliberately fewer rules than the list badge. */
function getStateBadge(state: string): BadgePalette {
  const s = (state || "").toLowerCase();
  if (s.includes("confirm")) return BADGE_PALETTES.green;
  if (s.includes("cancel")) return BADGE_PALETTES.red;
  if (s.includes("full")) return BADGE_PALETTES.yellow;
  if (s.includes("book")) return BADGE_PALETTES.blue;
  return BADGE_PALETTES.muted;
}

const PRINT_BTN: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  backgroundColor: "var(--ba-input-bg)",
  border: "1px solid var(--ba-input-border)",
  borderRadius: 8,
  color: "var(--ba-fg)",
  padding: "0.4rem 0.75rem",
  fontSize: "0.8rem",
  fontWeight: 600,
  cursor: "pointer",
};

const TH: React.CSSProperties = {
  textAlign: "left",
  fontSize: "0.72rem",
  fontWeight: 500,
  color: "var(--ba-muted)",
  padding: "6px 12px",
  borderBottom: "1px solid var(--ba-border)",
  whiteSpace: "nowrap",
};

const TH_R: React.CSSProperties = { ...TH, textAlign: "right" };

function td(i: number, extra?: React.CSSProperties): React.CSSProperties {
  return {
    padding: "8px 12px",
    fontSize: "0.875rem",
    color: "var(--ba-fg)",
    verticalAlign: "top",
    borderTop: i > 0 ? "1px solid var(--ba-border)" : undefined,
    ...extra,
  };
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ fontSize: "0.875rem" }}>
      <span style={{ color: "var(--ba-muted)" }}>{label}:</span>{" "}
      <span style={{ color: "var(--ba-fg)", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

/** Product rows shared by the Products and Service Charges tables. */
function ProductRows({ products }: { products: Product[] }) {
  return (
    <tbody>
      {products.map((p, i) => (
        <tr key={safe(p.id) || i}>
          <td style={td(i)}>
            <div>{safe(p.productName) || `Product ${safe(p.productId)}`}</div>
            {safe(p.nameOverride) && (
              <div style={{ fontSize: "0.75rem", color: "var(--ba-muted)", marginTop: 2 }}>
                Override: {safe(p.nameOverride)}
              </div>
            )}
          </td>
          <td style={td(i, { textAlign: "right" })}>{safe(p.quantity)}</td>
          <td style={td(i, { textAlign: "right", fontWeight: 500 })}>
            {fmtCurrency(p.totalPrice || 0)}
          </td>
        </tr>
      ))}
    </tbody>
  );
}

export default function DailyEventDetail({
  token,
  projectId,
  locationId,
}: {
  token: string;
  projectId: string;
  locationId: number;
}) {
  const [detail, setDetail] = useState<ReservationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Website payment status (headpinz.com — replaces unreliable BMI balance)
  const [websitePayment, setWebsitePayment] = useState<WebsitePaymentInfo | null>(null);

  // Event metadata (food out time from AI/manual) — lifted for print
  const [foodOutTime, setFoodOutTime] = useState<string | null>(null);

  // Waiver thresholds — constants (the portal's settings fetch is gone)
  const waiverThresholds = DEFAULT_WAIVER_THRESHOLDS;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);

    fetchReservationDetail(token, projectId, locationId)
      .then((data) => {
        if (cancelled) return;
        setDetail({
          ...data,
          schedules: Array.isArray(data.schedules) ? data.schedules : [],
          products: Array.isArray(data.products) ? data.products : [],
          payments: Array.isArray(data.payments) ? data.payments : [],
          persons_list: Array.isArray(data.persons_list) ? data.persons_list : [],
          logs: Array.isArray(data.logs) ? data.logs : [],
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load details");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, projectId, locationId]);

  // Fetch website payment status when detail loads
  useEffect(() => {
    if (!detail) {
      setWebsitePayment(null);
      return;
    }
    let cancelled = false;
    getPayment(token, projectId)
      .then((wp) => {
        if (!cancelled) setWebsitePayment(wp);
      })
      .catch(() => {
        if (!cancelled) setWebsitePayment(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detail, token, projectId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Header */}
      {detail && (
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "1.125rem",
                fontWeight: 700,
                color: "var(--ba-fg)",
              }}
            >
              #{safe(detail.number) || safe(detail.id)}
            </span>
            {isFullyPaidViaWebsite(websitePayment) && <PaidPill />}
            {isDepositPaidViaWebsite(websitePayment) && <DepositPill />}
            {detail.state &&
              (() => {
                const badge = getStateBadge(safe(detail.state));
                return (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      padding: "2px 8px",
                      borderRadius: 9999,
                      fontSize: "0.72rem",
                      fontWeight: 600,
                      backgroundColor: badge.bg,
                      color: badge.fg,
                    }}
                  >
                    {safe(detail.state)}
                  </span>
                );
              })()}
          </div>
          {detail.name && (
            <h1
              style={{
                fontSize: "1.25rem",
                fontWeight: 600,
                color: "var(--ba-fg)",
                margin: "4px 0 0",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {safe(detail.name)}
            </h1>
          )}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ display: "flex", justifyContent: "center", padding: "4rem 0" }}>
          <Spinner size={32} />
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          style={{
            backgroundColor: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 8,
            padding: 16,
            color: "#f87171",
            fontSize: "0.875rem",
          }}
        >
          {error}
        </div>
      )}

      {/* Content */}
      {detail && (
        <DetailErrorBoundary>
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {/* Print Buttons */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                style={PRINT_BTN}
                onClick={() =>
                  openHtmlReport(generateEventDetailHtml(detail, { foodOutTime, websitePayment }))
                }
              >
                <svg
                  style={{ width: 16, height: 16 }}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
                  />
                </svg>
                Print Full Details
              </button>
              {Array.isArray(detail.persons_list) && detail.persons_list.length > 0 && (
                <button
                  type="button"
                  style={PRINT_BTN}
                  onClick={() => openHtmlReport(generateAttendeesHtml(detail))}
                >
                  <svg
                    style={{ width: 16, height: 16 }}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                    />
                  </svg>
                  Print Attendees
                </button>
              )}
            </div>

            {/* Contact Person */}
            {detail.contactPerson && (
              <DetailSection id="contact" title="Contact Person">
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontWeight: 500, color: "var(--ba-fg)", fontSize: "0.9rem" }}>
                    {personDisplayName(detail.contactPerson) || "Unknown"}
                  </div>
                  {Array.isArray(detail.contactPerson.addresses) &&
                    detail.contactPerson.addresses.map((addr, i) => {
                      const email = safe(addr.email);
                      const mobile = safe(addr.mobile);
                      const phone = safe(addr.phone);
                      const city = safe(addr.city);
                      if (!email && !mobile && !phone && !city) return null;
                      return (
                        <div
                          key={i}
                          style={{
                            fontSize: "0.875rem",
                            color: "var(--ba-muted)",
                            display: "flex",
                            flexDirection: "column",
                            gap: 2,
                          }}
                        >
                          {email && (
                            <div>
                              Email: <span style={{ color: "var(--ba-fg)" }}>{email}</span>
                            </div>
                          )}
                          {mobile && (
                            <div>
                              Mobile: <span style={{ color: "var(--ba-fg)" }}>{mobile}</span>
                            </div>
                          )}
                          {phone && (
                            <div>
                              Phone: <span style={{ color: "var(--ba-fg)" }}>{phone}</span>
                            </div>
                          )}
                          {city && (
                            <div>
                              City: <span style={{ color: "var(--ba-fg)" }}>{city}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </DetailSection>
            )}

            {/* Waiver Registration Warning */}
            {(() => {
              const stateLC = (detail.state || "").toLowerCase();
              const resourceNames = (detail.schedules || []).map((s) =>
                (s.resourceName || "").toLowerCase(),
              );
              const isWaiver =
                stateLC.includes("waiver") ||
                resourceNames.some((rn) => WAIVER_RESOURCE_KEYWORDS.some((kw) => rn.includes(kw)));
              if (!isWaiver) return null;
              const total = detail.persons || 0;
              const registered = Array.isArray(detail.persons_list)
                ? detail.persons_list.length
                : 0;
              if (!total) return null;
              const pct = (registered / total) * 100;
              const color =
                pct < waiverThresholds.red
                  ? "red"
                  : pct <= waiverThresholds.yellow
                    ? "yellow"
                    : "green";
              const panel =
                color === "red"
                  ? {
                      backgroundColor: "rgba(239,68,68,0.15)",
                      border: "1px solid rgba(239,68,68,0.4)",
                      color: "#f87171",
                    }
                  : color === "yellow"
                    ? {
                        backgroundColor: "rgba(234,179,8,0.15)",
                        border: "1px solid rgba(234,179,8,0.4)",
                        color: "#facc15",
                      }
                    : {
                        backgroundColor: "rgba(34,197,94,0.15)",
                        border: "1px solid rgba(34,197,94,0.4)",
                        color: "#4ade80",
                      };
              const label =
                color === "red"
                  ? "Low Registration"
                  : color === "yellow"
                    ? "Moderate Registration"
                    : "Good Registration";
              return (
                <div style={{ ...panel, borderRadius: 12, padding: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: "1.125rem" }}>
                      {color === "red" ? "⚠️" : color === "yellow" ? "⚠" : "✅"}
                    </span>
                    <div>
                      <div style={{ fontWeight: 600 }}>
                        {label} — {registered} of {total} people registered ({Math.round(pct)}%)
                      </div>
                      <div style={{ fontSize: "0.75rem", opacity: 0.75, marginTop: 2 }}>
                        {color === "red"
                          ? `Less than ${waiverThresholds.red}% of expected attendees have registered waivers`
                          : color === "yellow"
                            ? `Between ${waiverThresholds.red}-${waiverThresholds.yellow}% of expected attendees have registered waivers`
                            : `Over ${waiverThresholds.yellow}% of expected attendees have registered waivers`}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Fully Paid Banner */}
            {isFullyPaidViaWebsite(websitePayment) && (
              <div
                style={{
                  border: "2px solid rgba(34,197,94,0.4)",
                  backgroundColor: "rgba(34,197,94,0.15)",
                  borderRadius: 12,
                  padding: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    backgroundColor: "rgba(34,197,94,0.2)",
                    flexShrink: 0,
                  }}
                >
                  <svg
                    style={{ width: 24, height: 24, color: "#4ade80" }}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 14l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
                <div>
                  <div style={{ color: "#4ade80", fontWeight: 700, fontSize: "1.125rem" }}>
                    FULLY PAID
                  </div>
                  <div style={{ color: "rgba(74,222,128,0.7)", fontSize: "0.75rem" }}>
                    All charges on this event have been paid
                  </div>
                </div>
              </div>
            )}

            {/* Deposit Paid Banner */}
            {isDepositPaidViaWebsite(websitePayment) && (
              <div
                style={{
                  border: "2px solid rgba(16,185,129,0.4)",
                  backgroundColor: "rgba(16,185,129,0.15)",
                  borderRadius: 12,
                  padding: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    backgroundColor: "rgba(16,185,129,0.2)",
                    flexShrink: 0,
                  }}
                >
                  <svg
                    style={{ width: 24, height: 24, color: "#34d399" }}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </div>
                <div>
                  <div style={{ color: "#34d399", fontWeight: 700, fontSize: "1.125rem" }}>
                    DEPOSIT PAID
                  </div>
                  <div style={{ color: "rgba(52,211,153,0.7)", fontSize: "0.75rem" }}>
                    {websitePayment && fmtCurrency(websitePayment.depositPaidCents / 100)} collected
                    {websitePayment && websitePayment.balanceRemainingCents > 0 && (
                      <>
                        {" "}
                        — {fmtCurrency(websitePayment.balanceRemainingCents / 100)} balance
                        remaining
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Overview */}
            <DetailSection id="overview" title="Overview">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                  columnGap: 16,
                  rowGap: 8,
                }}
              >
                {detail.when && (
                  <InfoItem label="When" value={fmtEventDateTime(String(detail.when))} />
                )}
                {detail.persons != null && (
                  <InfoItem
                    label="Persons"
                    value={
                      Array.isArray(detail.persons_list) && detail.persons_list.length > 0
                        ? `${detail.persons_list.length} / ${detail.persons} registered`
                        : String(detail.persons)
                    }
                  />
                )}
                {safe(detail.responsible) && (
                  <InfoItem label="Responsible" value={safe(detail.responsible)} />
                )}
                {detail.kind && <InfoItem label="Type" value={safe(detail.kind)} />}
                {detail.validUntil && (
                  <InfoItem
                    label="Valid Until"
                    value={fmtEventDateTime(String(detail.validUntil))}
                  />
                )}
                {detail.creationDate && (
                  <InfoItem label="Created" value={fmtEventDateTime(String(detail.creationDate))} />
                )}
                {detail.balance != null &&
                  (isFullyPaidViaWebsite(websitePayment) ? (
                    <div style={{ fontSize: "0.875rem" }}>
                      <span style={{ color: "var(--ba-muted)" }}>Balance:</span> <PaidPill />
                    </div>
                  ) : (
                    <InfoItem label="Balance" value={fmtCurrency(detail.balance)} />
                  ))}
              </div>
            </DetailSection>

            {/* Event Metadata (AI-extracted food out time, etc.) */}
            {detail.when && (
              <EventMetadataPanel
                token={token}
                projectId={projectId}
                locationId={locationId}
                eventDate={eventDateOf(detail.when)}
                startTime={String(detail.when)}
                eventName={safe(detail.name) || ""}
                persons={detail.persons || 0}
                logs={Array.isArray(detail.logs) ? detail.logs : []}
                onFoodOutTimeChange={setFoodOutTime}
              />
            )}

            {/* Schedules */}
            {Array.isArray(detail.schedules) && detail.schedules.length > 0 && (
              <DetailSection id="schedules" title="Schedules">
                <div style={{ overflowX: "auto", margin: "0 -16px" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={TH}>Start</th>
                        <th style={TH}>Stop</th>
                        <th style={TH}>Resource</th>
                        <th style={TH}>Products</th>
                        <th style={TH_R}>Persons</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.schedules.map((s: Schedule, i: number) => (
                        <tr key={safe(s.id) || i}>
                          <td style={td(i, { whiteSpace: "nowrap" })}>
                            {fmtEventTime(safe(s.start))}
                          </td>
                          <td style={td(i, { whiteSpace: "nowrap" })}>
                            {fmtEventTime(safe(s.stop))}
                          </td>
                          <td style={td(i)}>{safe(s.resourceName)}</td>
                          <td style={td(i, { color: "var(--ba-muted)" })}>
                            {safe(s.productLines)}
                          </td>
                          <td style={td(i, { textAlign: "right" })}>{safe(s.persons)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </DetailSection>
            )}

            {/* Products (split out service charges / gratuity) */}
            {Array.isArray(detail.products) &&
              detail.products.length > 0 &&
              (() => {
                const regularProducts = detail.products.filter(
                  (p) => !isServiceChargeProduct(safe(p.productName)),
                );
                const serviceProducts = detail.products.filter((p) =>
                  isServiceChargeProduct(safe(p.productName)),
                );

                return (
                  <>
                    {regularProducts.length > 0 && (
                      <DetailSection id="products" title="Products">
                        <div style={{ overflowX: "auto", margin: "0 -16px" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse" }}>
                            <thead>
                              <tr>
                                <th style={TH}>Product</th>
                                <th style={TH_R}>Qty</th>
                                <th style={TH_R}>Total</th>
                              </tr>
                            </thead>
                            <ProductRows products={regularProducts} />
                          </table>
                        </div>
                      </DetailSection>
                    )}

                    {serviceProducts.length > 0 && (
                      <DetailSection id="service-charges" title="Service Charges & Gratuity">
                        <div style={{ overflowX: "auto", margin: "0 -16px" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse" }}>
                            <thead>
                              <tr>
                                <th style={TH}>Item</th>
                                <th style={TH_R}>Qty</th>
                                <th style={TH_R}>Total</th>
                              </tr>
                            </thead>
                            <ProductRows products={serviceProducts} />
                          </table>
                        </div>
                      </DetailSection>
                    )}
                  </>
                );
              })()}

            {/* Payments (filtered — hide BMI internal methods) */}
            {(() => {
              const visiblePayments = (detail.payments || []).filter(
                (pay) => !isInternalPayMethod(safe(pay.payMethodName)),
              );
              if (visiblePayments.length === 0) return null;
              return (
                <DetailSection id="payments" title="Payments">
                  <div style={{ overflowX: "auto", margin: "0 -16px" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th style={TH}>Method</th>
                          <th style={TH_R}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visiblePayments.map((pay: Payment, i: number) => (
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
              );
            })()}

            {/* Persons */}
            {Array.isArray(detail.persons_list) && detail.persons_list.length > 0 && (
              <DetailSection
                id="persons"
                title={`Persons (${detail.persons_list.length}${detail.persons ? ` / ${detail.persons}` : ""})`}
              >
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {detail.persons_list.map((p: Person, i: number) => (
                    <div
                      key={safe(p.id) || safe(p.personId) || i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "6px 0",
                        borderTop: i > 0 ? "1px solid var(--ba-border)" : undefined,
                      }}
                    >
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: "50%",
                          backgroundColor: "var(--ba-muted2)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: "0.75rem",
                          fontWeight: 500,
                          color: "var(--ba-muted)",
                          flexShrink: 0,
                        }}
                      >
                        {(safe(p.firstName) || "?")[0]}
                      </div>
                      <div>
                        <div
                          style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--ba-fg)" }}
                        >
                          {personDisplayName(p) || "Unknown"}
                        </div>
                        {safe(p.addresses?.[0]?.email) && (
                          <div style={{ fontSize: "0.75rem", color: "var(--ba-muted)" }}>
                            {safe(p.addresses?.[0]?.email)}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </DetailSection>
            )}

            {/* Logs (all memos, public and private — portal parity: no filter) */}
            {Array.isArray(detail.logs) && detail.logs.length > 0 && (
              <DetailSection id="logs" title="Memo">
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {detail.logs.map((log: ProjectLog, i: number) => (
                    <div
                      key={safe(log.id) || i}
                      style={{
                        backgroundColor: "var(--ba-muted2)",
                        border: "1px solid var(--ba-border)",
                        borderRadius: 8,
                        padding: 12,
                      }}
                    >
                      {safe(log.memo) && (
                        <div
                          style={{
                            fontSize: "0.875rem",
                            color: "var(--ba-fg)",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {safe(log.memo)}
                        </div>
                      )}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          marginTop: 6,
                          fontSize: "0.75rem",
                          color: "var(--ba-muted)",
                        }}
                      >
                        {safe(log.updated) && <span>{fmtEventDateTime(safe(log.updated))}</span>}
                        {safe(log.updatedBy) && <span>by {safe(log.updatedBy)}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </DetailSection>
            )}

            {/* Contract (website-native — replaces the portal's PandaDoc section) */}
            {detail.contract && <ContractSection contract={detail.contract} />}
          </div>
        </DetailErrorBoundary>
      )}
    </div>
  );
}
