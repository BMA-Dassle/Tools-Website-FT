"use client";

import { useContext, useEffect } from "react";
import type { PublicCrmUser } from "~/features/crm/core/contracts";
import { CrmContext, type CrmContextValue } from "./crm-context";
import type { CrmFetch } from "./crm-fetch";

/**
 * Hooks over the CRM context (brief §3.4 "token injected from CrmApp context").
 * Every screen and shell piece reads the person and the transport from here;
 * nothing re-reads a cookie, a URL or storage for identity.
 */

export function useCrm(): CrmContextValue {
  const value = useContext(CrmContext);
  if (!value) throw new Error("CRM hooks must be used inside <CrmApp>");
  return value;
}

export interface CrmUserView {
  user: PublicCrmUser;
  isDirector: boolean;
  /** The rep's initials for avatars — from the rep row, else from the name. */
  initials: string;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

export function useCrmUser(): CrmUserView {
  const { user } = useCrm();
  return {
    user,
    isDirector: user.role === "director",
    initials: user.rep?.initials ?? initialsOf(user.name || user.email),
  };
}

export function useCrmFetch(): CrmFetch {
  return useCrm().crmFetch;
}

export function useCrmToast(): CrmContextValue["toast"] {
  return useCrm().toast;
}

export function useCrmSheet(): Pick<CrmContextValue, "openSheet" | "closeSheet"> {
  const { openSheet, closeSheet } = useCrm();
  return { openSheet, closeSheet };
}

export function useOverlayRoot(): HTMLElement | null {
  return useCrm().overlayRoot;
}

export function useTopbarSlot(): HTMLElement | null {
  return useCrm().topbarSlot;
}

/**
 * Name the topbar after the RECORD in view, not the screen — `title` null
 * while it is still loading, so the screen's own meta stands in the meantime.
 * Set in an effect (never during render) and cleared when the screen unmounts,
 * so navigating away restores the screen title.
 */
export function useScreenHead(title: string | null, sub?: string | null): void {
  const { setScreenHead } = useCrm();
  useEffect(() => {
    if (!title) return;
    setScreenHead({ title, sub: sub ?? undefined });
    return () => setScreenHead(null);
  }, [title, sub, setScreenHead]);
}
