"use client";

import { IconX } from "@tabler/icons-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ICON } from "../primitives/icon-props";
import { useOverlayRoot } from "../lib/use-crm-user";

/**
 * Direction B's right-hand drawer (`direction-b.html:10-13, 80`): the deal
 * opens over the pipeline on desktop. Header with a close button, the title,
 * and a right-hand slot (prev / next); `.content` scrolls. Portalled to the
 * overlay root like `Sheet`; position:fixed, full width under 769px.
 */
export interface DrawerProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  /** Buttons for the header's right side. */
  actions?: ReactNode;
  testId?: string;
  children: ReactNode;
}

export function Drawer({ open, title, onClose, actions, testId, children }: DrawerProps) {
  const root = useOverlayRoot();
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const node = (
    <div
      className="drawer"
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      ref={ref}
      data-testid={testId}
    >
      <div className="drawer-h">
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Close"
          onClick={onClose}
        >
          <IconX {...ICON} />
        </button>
        <h2 id={titleId} style={{ fontSize: 15 }}>
          {title}
        </h2>
        {actions ? (
          <div className="right" style={{ marginLeft: "auto" }}>
            {actions}
          </div>
        ) : null}
      </div>
      <div className="content">{children}</div>
    </div>
  );

  return root ? createPortal(node, root) : node;
}
