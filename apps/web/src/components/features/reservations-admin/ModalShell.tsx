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
import { useEffect } from "react";
import type { CSSProperties, ReactNode } from "react";
import { modalBackdropProps } from "@/lib/a11y";

export default function ModalShell({
  onClose,
  children,
  maxWidth = 440,
  maxHeight = "calc(100dvh - 2rem)",
  borderColor = "var(--ba-modal-border)",
  borderLeft,
  borderRadius = 16,
  padding = "1.5rem",
  blurBackdrop = true,
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
  /** Action modals use 16; the lighter popovers (contact/itinerary/order) use 12. */
  borderRadius?: number;
  padding?: CSSProperties["padding"];
  /** Action modals blur the backdrop; the popovers don't. */
  blurBackdrop?: boolean;
  zIndex?: number;
  /** "full" = fill the viewport/iframe (manage-reservation modal). */
  variant?: "centered" | "full";
  /** Escape hatch for panel style overrides. */
  panelStyle?: CSSProperties;
}) {
  const full = variant === "full";

  // Lock the page behind the modal — without this the board (and, in the
  // portal iframe, the page itself) kept its scrollbar under the overlay,
  // stacking two or three scroll layers (owner 2026-07-13). BOTH body and
  // html: the viewport scrollbar belongs to <html>, and body-only hiding
  // doesn't propagate when html establishes its own overflow context.
  // Nested modals compose: each mount saves the previous values and
  // restores them on close.
  useEffect(() => {
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, []);

  // Portal-embed insurance: the portal resizes the iframe while a modal is
  // open (content-height → viewport box). Chrome occasionally fails to
  // re-evaluate custom-scrollbar overflow after such a viewport change
  // (first-open no-scroll report, 2026-07-14) — force a recalc on resize.
  useEffect(() => {
    function onResize() {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(".ba-scroll"))) {
        const prev = el.style.overflowY;
        el.style.overflowY = "hidden";
        void el.offsetHeight; // reflow
        el.style.overflowY = prev || "";
      }
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
        ...(blurBackdrop ? { backdropFilter: "blur(4px)" } : {}),
      }}
      {...modalBackdropProps(onClose)}
    >
      <div
        className="ba-scroll"
        style={{
          width: "100%",
          height: full ? "100%" : undefined,
          maxWidth: full ? undefined : maxWidth,
          backgroundColor: "var(--ba-modal-bg)",
          border: `1px solid ${borderColor}`,
          ...(borderLeft ? { borderLeft } : {}),
          borderRadius: full ? 12 : borderRadius,
          padding: full ? 0 : padding,
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
