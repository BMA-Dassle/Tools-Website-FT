"use client";

import { IconAlertTriangle, IconCheck } from "@tabler/icons-react";
import { TEST_IDS } from "~/features/crm/core/contracts";
import { ICON } from "../primitives/icon-props";
import type { ToastKind } from "../lib/crm-context";

/**
 * The prototype's `.toast` (crm-shared.js:99, 105): one line, bottom-centre,
 * auto-dismissed by `CrmApp`. Rendered at the root, position:fixed.
 */
export interface ToastProps {
  text: string;
  kind?: ToastKind;
}

export function Toast({ text, kind = "ok" }: ToastProps) {
  return (
    <div
      className="toast"
      role="status"
      aria-live="polite"
      data-testid={TEST_IDS.toast}
      data-kind={kind}
    >
      {kind === "ok" ? <IconCheck {...ICON} /> : <IconAlertTriangle {...ICON} />}
      {text}
    </div>
  );
}
