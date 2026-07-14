"use client";

/**
 * Overview tab — payment banners, the event info grid, food-out metadata,
 * schedules, and products (service charges split out). Content lifted
 * unchanged from the pre-tab DailyEventDetail body.
 */
import { eventDateOf, fmtCurrency, fmtEventDateTime } from "~/features/daily-events/format";
import { isServiceChargeProduct } from "~/features/daily-events/logic";
import {
  isDepositPaidViaWebsite,
  isFullyPaidViaWebsite,
  safe,
} from "~/features/daily-events/print-html";
import type { ReservationDetail, WebsitePaymentInfo } from "~/features/daily-events/types";
import { PaidPill } from "../../badges";
import DetailSection from "../DetailSection";
import EventMetadataPanel from "../EventMetadataPanel";
import { InfoItem, ProductRows, TH, TH_R } from "../ui";

export default function OverviewTab({
  detail,
  websitePayment,
  token,
  projectId,
  locationId,
  onFoodOutTimeChange,
}: {
  detail: ReservationDetail;
  websitePayment: WebsitePaymentInfo | null;
  token: string;
  projectId: string;
  locationId: number;
  onFoodOutTimeChange: (time: string | null) => void;
}) {
  const regularProducts = (detail.products || []).filter(
    (p) => !isServiceChargeProduct(safe(p.productName)),
  );
  const serviceProducts = (detail.products || []).filter((p) =>
    isServiceChargeProduct(safe(p.productName)),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
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
                <> — {fmtCurrency(websitePayment.balanceRemainingCents / 100)} balance remaining</>
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
          {detail.when && <InfoItem label="When" value={fmtEventDateTime(String(detail.when))} />}
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
          onFoodOutTimeChange={onFoodOutTimeChange}
        />
      )}

      {/* Schedules live on their own tab (ScheduleTab) — big events carry
          dozens of lane/track lines and drowned the Overview. */}

      {/* Products (split out service charges / gratuity) */}
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
    </div>
  );
}
