"use client";

/**
 * Contract tab — the website-native replacement for the portal's PandaDoc
 * documents list, expanded from the old inline ContractSection: status chip,
 * signer/sent/signed facts, buttons for the latest contract page, the signed
 * PDF, and the balance payment flow, plus a lazy-loaded History timeline
 * (contract_audit_log + contract_versions + archived PDFs + quote
 * milestones). `detail.contract` always points at the LATEST contract short
 * id — re-signs update the quote row in place; prior signed PDFs surface in
 * the timeline.
 */
import { useEffect, useState } from "react";
import { fetchContractHistory } from "~/features/daily-events/api";
import { fmtEventDateTime } from "~/features/daily-events/format";
import { BADGE_PALETTES, type BadgePalette } from "~/features/daily-events/logic";
import type { ContractHistoryEntry, EventContract } from "~/features/daily-events/types";
import DetailSection from "../DetailSection";
import { BLUE_LINK_BTN, GREEN_LINK_BTN, InfoItem } from "../ui";

const GREEN_STATUSES = ["signed", "completed", "deposit_paid", "balance_charged"];
const AMBER_STATUSES = ["contract_sent", "sent", "pending"];
const RED_STATUSES = ["cancelled", "denied", "resign_required", "expired"];

function statusPalette(status: string): BadgePalette {
  const s = status.toLowerCase();
  if (GREEN_STATUSES.includes(s)) return BADGE_PALETTES.green;
  if (AMBER_STATUSES.includes(s)) return BADGE_PALETTES.amber;
  if (RED_STATUSES.includes(s)) return BADGE_PALETTES.red;
  return BADGE_PALETTES.muted;
}

/** Timeline dot color by event family. */
function dotColor(kind: string): string {
  if (kind === "signed" || kind === "resigned" || kind.startsWith("milestone:signed")) {
    return "#4ade80";
  }
  if (
    kind.includes("paid") ||
    kind === "reprice_charged" ||
    kind === "milestone:deposit_paid" ||
    kind === "milestone:balance_paid" ||
    kind === "milestone:dayof_paid"
  ) {
    return "#34d399";
  }
  if (kind.includes("failed") || kind.includes("declined") || kind.includes("denied")) {
    return "#ef4444";
  }
  if (kind.includes("cancel")) return "#ef4444";
  if (kind === "page_view" || kind === "balance_pay_view") return "var(--ba-muted)";
  return "#60a5fa";
}

export default function ContractTab({
  contract,
  token,
  projectId,
}: {
  contract: EventContract | null;
  token: string;
  projectId: string;
}) {
  const [history, setHistory] = useState<ContractHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!contract) return;
    let cancelled = false;
    fetchContractHistory(token, projectId)
      .then((h) => {
        if (!cancelled) setHistory(h);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setHistoryError(err instanceof Error ? err.message : "Failed to load history");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [contract, token, projectId]);

  if (!contract) {
    return (
      <div style={{ fontSize: "0.85rem", color: "var(--ba-muted)" }}>
        No website contract for this event — it was booked outside the group-function flow (or
        predates it).
      </div>
    );
  }

  const status = contract.status || contract.quoteStatus || "";
  const palette = statusPalette(status);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <DetailSection id="contract" title="Contract">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            {status && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "2px 8px",
                  borderRadius: 9999,
                  fontSize: "0.72rem",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.03em",
                  backgroundColor: palette.bg,
                  color: palette.fg,
                }}
              >
                {status.replace(/_/g, " ")}
              </span>
            )}
            {contract.shortId && (
              <span
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: "0.875rem",
                  fontWeight: 600,
                  color: "var(--ba-fg)",
                }}
              >
                #{contract.shortId}
              </span>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              columnGap: 16,
              rowGap: 8,
            }}
          >
            {contract.guestName && <InfoItem label="Guest" value={contract.guestName} />}
            {contract.guestEmail && <InfoItem label="Email" value={contract.guestEmail} />}
            {contract.sentAt && <InfoItem label="Sent" value={fmtEventDateTime(contract.sentAt)} />}
            {contract.signedAt && (
              <InfoItem label="Signed" value={fmtEventDateTime(contract.signedAt)} />
            )}
            {contract.quoteStatus && (
              <InfoItem label="Quote status" value={contract.quoteStatus.replace(/_/g, " ")} />
            )}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {contract.contractUrl && (
              <a
                href={contract.contractUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={BLUE_LINK_BTN}
                title="The live contract page the guest sees — always the latest version"
              >
                Latest Contract ↗
              </a>
            )}
            {contract.signedPdfUrl && (
              <a
                href={contract.signedPdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={BLUE_LINK_BTN}
              >
                Signed PDF ↗
              </a>
            )}
            {contract.payUrl && (
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
            {contract.balancePaymentLinkUrl && (
              <a
                href={contract.balancePaymentLinkUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={GREEN_LINK_BTN}
                title="Square-hosted balance payment link sent to the guest"
              >
                Square Balance Link ↗
              </a>
            )}
          </div>
        </div>
      </DetailSection>

      {/* ── History timeline (newest first) ── */}
      <DetailSection id="contract-history" title="History">
        {historyError && <div style={{ fontSize: "0.8rem", color: "#ef4444" }}>{historyError}</div>}
        {!history && !historyError && (
          <div style={{ fontSize: "0.85rem", color: "var(--ba-muted)" }}>Loading history…</div>
        )}
        {history && history.length === 0 && (
          <div style={{ fontSize: "0.85rem", color: "var(--ba-muted)" }}>Nothing recorded yet.</div>
        )}
        {history && history.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {[...history].reverse().map((e, i) => (
              <div
                key={`${e.at}-${e.kind}-${i}`}
                style={{
                  display: "flex",
                  gap: 12,
                  padding: "8px 0",
                  borderTop: i > 0 ? "1px solid var(--ba-border)" : undefined,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor: dotColor(e.kind),
                    marginTop: 6,
                    flexShrink: 0,
                  }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "baseline",
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--ba-fg)" }}>
                      {e.label}
                      {e.count && e.count > 1 ? ` ×${e.count}` : ""}
                    </span>
                    {e.pdfUrl && (
                      <a
                        href={e.pdfUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: "0.75rem", color: "#60a5fa", textDecoration: "none" }}
                      >
                        View PDF ↗
                      </a>
                    )}
                  </div>
                  {e.detail && (
                    <div
                      style={{
                        fontSize: "0.78rem",
                        color: "var(--ba-muted)",
                        marginTop: 2,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {e.detail}
                    </div>
                  )}
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      marginTop: 2,
                      fontSize: "0.72rem",
                      color: "var(--ba-muted)",
                    }}
                  >
                    <span>{fmtEventDateTime(e.at)}</span>
                    {e.actor && <span>{e.actor}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </DetailSection>
    </div>
  );
}
