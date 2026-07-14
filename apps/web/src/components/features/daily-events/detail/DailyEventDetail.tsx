"use client";

/**
 * Event detail body — originally a faithful single-scroll port of the
 * portal's ReservationDetailPage.tsx, now restructured into the
 * ManageReservationModal idiom: header (number · pills · state · name),
 * an action bar (Latest Contract / Signed PDF / Payment Flow / prints),
 * and tabs: Overview · Payments · Guest · Notes · Contract. Section
 * content is unchanged — it moved into detail/tabs/*.
 *
 * Dropped from the portal per owner decision: Staff/party-assignment UI, the
 * PandaDoc section (replaced by the website-native ContractTab fed from
 * `detail.contract`), the "Full Page" button and router plumbing, and the
 * settings fetch for waiver thresholds (constants now). The DUAL LOCATION
 * badge is also not shown here: the portal read `isMultiLocation` from router
 * state passed by its list page — the detail payload itself doesn't carry it.
 */
import { useEffect, useState } from "react";
import { fetchReservationDetail, getPayment } from "~/features/daily-events/api";
import { fmtCurrency } from "~/features/daily-events/format";
import { BADGE_PALETTES, type BadgePalette } from "~/features/daily-events/logic";
import { openHtmlReport } from "~/features/daily-events/print";
import {
  generateAttendeesHtml,
  generateEventDetailHtml,
  isDepositPaidViaWebsite,
  isFullyPaidViaWebsite,
  safe,
} from "~/features/daily-events/print-html";
import type { ReservationDetail, WebsitePaymentInfo } from "~/features/daily-events/types";
import { DepositPill, PaidPill, Spinner } from "../badges";
import DetailErrorBoundary from "./DetailErrorBoundary";
import ContractTab from "./tabs/ContractTab";
import GuestTab from "./tabs/GuestTab";
import NotesTab from "./tabs/NotesTab";
import OverviewTab from "./tabs/OverviewTab";
import PaymentsTab from "./tabs/PaymentsTab";
import ScheduleTab from "./tabs/ScheduleTab";
import { BLUE_LINK_BTN, GREEN_LINK_BTN } from "./ui";

/** Portal detail-header badge — deliberately fewer rules than the list badge. */
function getStateBadge(state: string): BadgePalette {
  const s = (state || "").toLowerCase();
  if (s.includes("confirm")) return BADGE_PALETTES.green;
  if (s.includes("cancel")) return BADGE_PALETTES.red;
  if (s.includes("full")) return BADGE_PALETTES.yellow;
  if (s.includes("book")) return BADGE_PALETTES.blue;
  return BADGE_PALETTES.muted;
}

const TABS = ["Overview", "Schedule", "Payments", "Guest", "Notes", "Contract"] as const;
type Tab = (typeof TABS)[number];

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

export default function DailyEventDetail({
  token,
  projectId,
  locationId,
  initialTab,
}: {
  token: string;
  projectId: string;
  locationId: number;
  /** Land on a specific tab (validated against TABS; defaults to Overview). */
  initialTab?: string;
}) {
  const [detail, setDetail] = useState<ReservationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(
    initialTab && (TABS as readonly string[]).includes(initialTab)
      ? (initialTab as Tab)
      : "Overview",
  );

  // Website payment status (headpinz.com — replaces unreliable BMI balance)
  const [websitePayment, setWebsitePayment] = useState<WebsitePaymentInfo | null>(null);

  // Event metadata (food out time from AI/manual) — lifted for print
  const [foodOutTime, setFoodOutTime] = useState<string | null>(null);

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

  const contract = detail?.contract || null;
  const balanceRemaining = websitePayment ? websitePayment.balanceRemainingCents : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* ── Header ── */}
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
            {isDepositPaidViaWebsite(websitePayment) && balanceRemaining > 0 && (
              <span style={{ fontSize: "0.78rem", color: "var(--ba-muted)" }}>
                {fmtCurrency(balanceRemaining / 100)} balance remaining
              </span>
            )}
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

          {/* ── Action bar ── */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 8,
              marginTop: 12,
            }}
          >
            {contract?.contractUrl && (
              <a
                href={contract.contractUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={BLUE_LINK_BTN}
                title="The live contract page — after signing, this is what the guest uses as their confirmation. Always the latest version."
              >
                Guest Confirmation ↗
              </a>
            )}
            {contract?.signedPdfUrl && (
              <a
                href={contract.signedPdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={BLUE_LINK_BTN}
                title="PDF of the most recently signed contract"
              >
                Latest Signed Contract ↗
              </a>
            )}
            {contract?.payUrl && websitePayment && websitePayment.balanceRemainingCents > 0 && (
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
            <span style={{ flex: 1 }} />
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

          {/* ── Tabs ── */}
          <div
            style={{
              display: "flex",
              gap: 2,
              overflowX: "auto",
              marginTop: 10,
              borderBottom: "1px solid var(--ba-border)",
            }}
          >
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                style={{
                  background: "none",
                  border: "none",
                  borderBottom: tab === t ? "2px solid #3b82f6" : "2px solid transparent",
                  color: tab === t ? "var(--ba-fg)" : "var(--ba-muted)",
                  padding: "8px 13px",
                  fontSize: "0.82rem",
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {t}
              </button>
            ))}
          </div>
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

      {/* ── Tab body ── */}
      {detail && (
        <DetailErrorBoundary>
          {tab === "Overview" && (
            <OverviewTab
              detail={detail}
              websitePayment={websitePayment}
              token={token}
              projectId={projectId}
              locationId={locationId}
              onFoodOutTimeChange={setFoodOutTime}
            />
          )}
          {tab === "Schedule" && <ScheduleTab detail={detail} />}
          {tab === "Payments" && (
            <PaymentsTab
              detail={detail}
              websitePayment={websitePayment}
              contract={contract}
              token={token}
              projectId={projectId}
            />
          )}
          {tab === "Guest" && <GuestTab detail={detail} />}
          {tab === "Notes" && <NotesTab detail={detail} />}
          {tab === "Contract" && (
            <ContractTab contract={contract} token={token} projectId={projectId} />
          )}
        </DetailErrorBoundary>
      )}
    </div>
  );
}
