"use client";

import type { CSSProperties } from "react";
import type { SaleTone } from "~/features/web-sales";
import { TONE_BG, TONE_COLOR } from "./format";

const BASE: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.02em",
  whiteSpace: "nowrap",
};

/** One chip, one legend, every source. */
export default function StatusPill({
  label,
  tone,
  title,
  strikeThrough,
}: {
  label: string;
  tone: SaleTone;
  title?: string;
  strikeThrough?: boolean;
}) {
  return (
    <span
      title={title}
      style={{
        ...BASE,
        color: TONE_COLOR[tone],
        background: TONE_BG[tone],
        textDecoration: strikeThrough ? "line-through" : undefined,
      }}
    >
      {label}
    </span>
  );
}
