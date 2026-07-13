"use client";

/**
 * Section wrapper for the event-detail view — port of the portal's
 * DetailSection (shadcn Card + uppercase muted CardTitle), restyled to the
 * board idiom: inline styles on `--ba-*` vars, no component kit.
 */
import type { ReactNode } from "react";

export default function DetailSection({
  title,
  children,
  id,
}: {
  title: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section
      id={id}
      style={{
        backgroundColor: "var(--ba-bg2)",
        border: "1px solid var(--ba-border)",
        borderRadius: 12,
        padding: 16,
      }}
    >
      <div
        style={{
          fontSize: "0.72rem",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--ba-muted)",
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      {children}
    </section>
  );
}
