"use client";

import { IconX } from "@tabler/icons-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ICON } from "../primitives/icon-props";
import { useOverlayRoot } from "../lib/use-crm-user";

/**
 * The prototype's bottom sheet / centred modal (`sheetHtml`, crm-shared.js:108):
 * backdrop, `.sheet` with a sticky header, `.body`, optional sticky `.foot`.
 *
 * Renders through a portal into the overlay root — a SIBLING of the shell at
 * the CRM root, inside the `[data-ba-theme]` element so tokens inherit and
 * outside any ancestor with a transform (lesson 175-222). Closes on Escape,
 * the X button, or the invisible full-size backdrop button; focus moves to the
 * dialog on open (programmatically — never `autoFocus`, R13).
 */
export interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  icon?: ReactNode;
  wide?: boolean;
  foot?: ReactNode;
  testId?: string;
  children: ReactNode;
}

export function Sheet({
  open,
  title,
  onClose,
  icon,
  wide = false,
  foot,
  testId,
  children,
}: SheetProps) {
  const root = useOverlayRoot();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const node = (
    <div className="backdrop">
      <button
        type="button"
        className="backdrop-btn"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        className={wide ? "sheet wide" : "sheet"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialogRef}
        data-testid={testId}
      >
        <div className="sheet-h">
          {icon ?? null}
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="btn btn-ghost btn-icon x"
            aria-label="Close"
            onClick={onClose}
          >
            <IconX {...ICON} />
          </button>
        </div>
        <div className="body">{children}</div>
        {foot ? <div className="foot">{foot}</div> : null}
      </div>
    </div>
  );

  return root ? createPortal(node, root) : node;
}
