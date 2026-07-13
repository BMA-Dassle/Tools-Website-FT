"use client";

/**
 * Contract section — the website-native replacement for the portal's
 * PandaDoc documents list. The detail API embeds the group-function quote's
 * contract info (`detail.contract`), so there's no extra fetch: status chip,
 * short-id link to the contract page, and buttons for the signed PDF and the
 * balance payment link when present.
 */
import { BADGE_PALETTES, type BadgePalette } from "~/features/daily-events/logic";
import type { EventContract } from "~/features/daily-events/types";
import DetailSection from "./DetailSection";

const GREEN_STATUSES = ["signed", "completed", "deposit_paid", "balance_charged"];
const AMBER_STATUSES = ["contract_sent", "pending"];
const RED_STATUSES = ["cancelled", "denied", "resign_required", "expired"];

function statusPalette(status: string): BadgePalette {
  const s = status.toLowerCase();
  if (GREEN_STATUSES.includes(s)) return BADGE_PALETTES.green;
  if (AMBER_STATUSES.includes(s)) return BADGE_PALETTES.amber;
  if (RED_STATUSES.includes(s)) return BADGE_PALETTES.red;
  return BADGE_PALETTES.muted;
}

const LINK_BTN: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid rgba(96,165,250,0.4)",
  color: "#60a5fa",
  borderRadius: 6,
  fontSize: "0.72rem",
  fontWeight: 700,
  padding: "5px 12px",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  textDecoration: "none",
  whiteSpace: "nowrap",
};

export default function ContractSection({ contract }: { contract: EventContract }) {
  const status = contract.status || contract.quoteStatus || "";
  const palette = statusPalette(status);

  return (
    <DetailSection id="contract" title="Contract">
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
        {contract.shortId &&
          (contract.contractUrl ? (
            <a
              href={contract.contractUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "0.875rem",
                fontWeight: 600,
                color: "#60a5fa",
                textDecoration: "none",
              }}
            >
              #{contract.shortId} ↗
            </a>
          ) : (
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
          ))}
        <span style={{ flex: 1 }} />
        {contract.signedPdfUrl && (
          <a
            href={contract.signedPdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={LINK_BTN}
          >
            Signed PDF
          </a>
        )}
        {contract.balancePaymentLinkUrl && (
          <a
            href={contract.balancePaymentLinkUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...LINK_BTN, border: "1px solid rgba(52,211,153,0.4)", color: "#34d399" }}
          >
            Balance payment link
          </a>
        )}
      </div>
    </DetailSection>
  );
}
