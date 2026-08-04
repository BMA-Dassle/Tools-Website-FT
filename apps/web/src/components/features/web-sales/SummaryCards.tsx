"use client";

import { PORTAL_DARK } from "~/components/features/admin-skin/theme";
import type { SaleSummary } from "~/features/web-sales";
import { TONE_COLOR, money } from "./format";

interface BySource {
  source: string;
  label: string;
  summary: SaleSummary;
}

const CARD: React.CSSProperties = {
  background: PORTAL_DARK.card,
  border: `1px solid ${PORTAL_DARK.border}`,
  borderRadius: 12,
  padding: "14px 16px",
};

function Card({
  label,
  value,
  sublabel,
  color,
  onClick,
}: {
  label: string;
  value: string;
  sublabel?: string | null;
  color?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: PORTAL_DARK.muted }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4, color: color ?? PORTAL_DARK.fg }}>
        {value}
      </div>
      {sublabel && <div style={{ fontSize: 12, color: PORTAL_DARK.muted, marginTop: 2 }}>{sublabel}</div>}
    </>
  );

  // A card that filters is a button, not a div with a click handler — it has to
  // be reachable and operable from a keyboard, and the a11y gate enforces it.
  return onClick ? (
    <button type="button" onClick={onClick} style={{ ...CARD, textAlign: "left", cursor: "pointer", width: "100%" }}>
      {body}
    </button>
  ) : (
    <div style={CARD}>{body}</div>
  );
}

/**
 * The header rollup.
 *
 * The shared four are money and counts — the only things every source agrees on.
 * Bespoke per-product cards ride in `summary.extra`, which the service only
 * populates when a single source is selected; that is how the deals board's
 * "packs sold · gross · awaiting codes" rollup survives being generalised.
 */
export default function SummaryCards({
  summary,
  bySource,
  problemsOnly,
  onToggleProblems,
}: {
  summary: SaleSummary;
  bySource: BySource[];
  problemsOnly: boolean;
  onToggleProblems: () => void;
}) {
  const refundPct =
    summary.grossCents > 0 ? Math.round((summary.refundedCents / summary.grossCents) * 1000) / 10 : 0;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        <Card
          label="Gross"
          value={money(summary.grossCents)}
          sublabel={`${summary.saleCount} sale${summary.saleCount === 1 ? "" : "s"} · ${summary.unitCount} unit${summary.unitCount === 1 ? "" : "s"}`}
        />
        <Card
          label="Refunded"
          value={money(summary.refundedCents)}
          sublabel={summary.refundedCents > 0 ? `${refundPct}% of gross` : "nothing refunded"}
        />
        <Card
          label="Needs attention"
          value={String(summary.problemCount)}
          sublabel={problemsOnly ? "filtering to these" : summary.problemCount > 0 ? "click to filter" : "all clear"}
          color={summary.problemCount > 0 ? TONE_COLOR.warn : undefined}
          onClick={summary.problemCount > 0 || problemsOnly ? onToggleProblems : undefined}
        />
        {summary.extra.map((x) => (
          <Card key={x.label} label={x.label} value={x.value} sublabel={x.sublabel} color={TONE_COLOR[x.tone]} />
        ))}
      </div>

      {/* Only meaningful once more than one source is on screen. */}
      {bySource.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {bySource.map((s) => (
            <span
              key={s.source}
              style={{
                fontSize: 12,
                color: PORTAL_DARK.muted,
                background: PORTAL_DARK.muted2,
                border: `1px solid ${PORTAL_DARK.border}`,
                borderRadius: 999,
                padding: "3px 10px",
              }}
            >
              {s.label} <strong style={{ color: PORTAL_DARK.fg }}>{s.summary.saleCount}</strong> ·{" "}
              {money(s.summary.grossCents)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
