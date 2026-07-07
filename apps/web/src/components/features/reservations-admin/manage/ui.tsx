"use client";

/**
 * Small shared presentational pieces for the Manage Reservation modal.
 * All theme-aware via the board's `--ba-*` CSS variables.
 */
import type { CSSProperties, ReactNode } from "react";
import { KIND_BADGE, STATUS_COLORS, STATUS_LABELS } from "~/features/reservations-admin/constants";

export function Card({
  title,
  children,
  style,
}: {
  title?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--ba-border)",
        borderRadius: 10,
        backgroundColor: "var(--ba-bg2)",
        padding: "12px 14px",
        marginBottom: 12,
        ...style,
      }}
    >
      {title && (
        <div
          style={{
            fontSize: "0.68rem",
            fontWeight: 700,
            letterSpacing: "0.07em",
            textTransform: "uppercase",
            color: "var(--ba-muted)",
            marginBottom: 8,
          }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

export function StatusChip({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "#6b7280";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.1rem 0.4rem",
        borderRadius: 5,
        fontSize: "0.65rem",
        fontWeight: 600,
        backgroundColor: `${color}20`,
        color,
        border: `1px solid ${color}40`,
        whiteSpace: "nowrap",
      }}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function KindChip({ kind }: { kind: string }) {
  const badge = KIND_BADGE[kind];
  if (!badge) return null;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.1rem 0.4rem",
        borderRadius: 5,
        fontSize: "0.65rem",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        backgroundColor: badge.bg,
        color: badge.color,
        border: `1px solid ${badge.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {badge.label}
    </span>
  );
}

/** Copyable monospace id chip (Square ids, GANs, short codes). */
export function CopyId({
  value,
  label,
  onCopied,
}: {
  value: string;
  label?: string;
  onCopied?: (msg: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => onCopied?.("Copied"));
      }}
      title={`Copy ${label ?? value}`}
      style={{
        fontFamily: "ui-monospace, monospace",
        fontSize: "0.68rem",
        color: "var(--ba-muted)",
        background: "var(--ba-input-bg)",
        border: "1px solid var(--ba-border)",
        borderRadius: 4,
        padding: "0 5px",
        cursor: "pointer",
      }}
    >
      {label ?? value}
    </button>
  );
}
