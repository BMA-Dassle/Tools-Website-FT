"use client";

import { createContext, type ReactNode } from "react";
import type { PublicCrmUser } from "~/features/crm/core/contracts";
import type { CrmFetch } from "./crm-fetch";

/**
 * What `CrmApp` provides to every screen: the signed-in person and the minted
 * API token (as a ready-made `crmFetch`), plus the shell services a screen may
 * call — toasts, the root-level sheet, the overlay mount node and the topbar's
 * actions slot. Screens reach these through the hooks in `use-crm-user.ts`.
 *
 * The token lives here and only here: never in a URL, never in localStorage.
 */

export interface SheetSpec {
  title: string;
  icon?: ReactNode;
  wide?: boolean;
  body: ReactNode;
  foot?: ReactNode;
  testId?: string;
}

export type ToastKind = "ok" | "warn" | "crit";

export interface CrmContextValue {
  token: string;
  user: PublicCrmUser;
  crmFetch: CrmFetch;
  toast: (text: string, kind?: ToastKind) => void;
  openSheet: (spec: SheetSpec) => void;
  closeSheet: () => void;
  /** Where sheets and drawers portal to: a sibling of the shell at the root. */
  overlayRoot: HTMLElement | null;
  /** The topbar's `.actions` element; a screen portals its buttons into it. */
  topbarSlot: HTMLElement | null;
}

export const CrmContext = createContext<CrmContextValue | null>(null);
