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

/**
 * What the topbar says. `SCREEN_META` names the SCREEN ("Account"); a screen
 * showing one record names the RECORD ("Acme Corp" · "Business · HeadPinz Fort
 * Myers · lifetime $14,260"), as the prototype's account and deal screens do.
 * A screen sets it through `useScreenHead()` and the shell clears it when the
 * screen unmounts — so the page's one `<h1>` is the record, and no screen has
 * to draw a second heading under the first.
 */
export interface ScreenHead {
  title: string;
  sub?: string;
}

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
  /** Override the topbar's title/sub for the screen in view (null = the screen's own meta). */
  setScreenHead: (head: ScreenHead | null) => void;
}

export const CrmContext = createContext<CrmContextValue | null>(null);
