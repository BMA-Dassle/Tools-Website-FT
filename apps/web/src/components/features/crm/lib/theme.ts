"use client";

import { useSyncExternalStore } from "react";

/**
 * The CRM's theme — dark by default, light on request, remembered per browser
 * in `localStorage("crm.theme")` (brief §3.7). A per-viewer convenience only:
 * every read and write is wrapped, and a blocked or missing store means dark.
 *
 * Modelled as an external store rather than state-plus-effect so the first
 * client render agrees with the server (`getServerSnapshot` → "dark") and the
 * stored choice applies right after hydration without a set-state-in-effect.
 */

export type CrmTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "crm.theme";

const listeners = new Set<() => void>();

export function readStoredTheme(): CrmTheme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function storeTheme(theme: CrmTheme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // private window / blocked storage: the toggle still works for this page view
    // because the listeners re-read `memoryTheme` below.
  }
  memoryTheme = theme;
  for (const l of listeners) l();
}

/** What the page shows when storage is unavailable (falls back to dark). */
let memoryTheme: CrmTheme | null = null;

function getSnapshot(): CrmTheme {
  if (memoryTheme) return memoryTheme;
  return readStoredTheme();
}

function getServerSnapshot(): CrmTheme {
  return "dark";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCrmTheme(): [CrmTheme, (theme: CrmTheme) => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [theme, storeTheme];
}
