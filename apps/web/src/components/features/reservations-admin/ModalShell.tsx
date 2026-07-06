"use client";

/**
 * Reusable overlay + panel shell for the admin reservations board's modals.
 *
 * Reproduces the fixed-inset pattern the board's modals all shared inline:
 * outer backdrop (`--ba-overlay`, blur, click-outside/Escape dismiss via
 * modalBackdropProps) with a centered scrollable panel (`--ba-modal-bg`).
 *
 * MUST render inside the board's `[data-ba-theme]` root div — the `--ba-*`
 * CSS variables are scoped to that attribute and inherit through the DOM
 * (which is also why this never uses a React portal).
 *
 * `variant="full"` fills the viewport (i.e. the portal iframe) for the
 * manage-reservation modal; the default centers a capped-width panel.
 */
import type { CSSProperties, ReactNode } from "react";
import { modalBackdropProps } from "@/lib/a11y";

export default function ModalShell({
  onClose,
  children,
  maxWidth = 440,
  maxHeight = "calc(100dvh - 2rem)",
  borderColor = "var(--ba-modal-border)",
  borderLeft,
  zIndex = 50,
  variant = "centered",
  panelStyle,
}: {
  onClose: () => void;
  children: ReactNode;
  /** Panel max width in px (centered variant only). */
  maxWidth?: number;
  maxHeight?: CSSProperties["maxHeight"];
  borderColor?: string;
  /** Optional accent left border, e.g. `4px solid ${accent}` (combo itinerary). */
  borderLeft?: string;
  zIndex?: number;
  /** "full" = fill the viewport/iframe (manage-reservation modal). */
  variant?: "centered" | "full";
  /** Escape hatch for panel style overrides (padding etc.). */
  panelStyle?: CSSProperties;
}) {
  const full = variant === "full";
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: full ? "10px" : "1rem",
        backgroundColor: "var(--ba-overlay)",
        backdropFilter: "blur(4px)",
      }}
      {...modalBackdropProps(onClose)}
    >
      <div
        style={{
          width: "100%",
          height: full ? "100%" : undefined,
          maxWidth: full ? undefined : maxWidth,
          backgroundColor: "var(--ba-modal-bg)",
          border: `1px solid ${borderColor}`,
          ...(borderLeft ? { borderLeft } : {}),
          borderRadius: full ? 12 : 16,
          padding: full ? 0 : "1.5rem",
          maxHeight: full ? "100%" : maxHeight,
          overflowY: full ? "hidden" : "auto",
          ...(full ? { display: "flex", flexDirection: "column" } : {}),
          ...panelStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
}
