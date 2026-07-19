"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import type { BookingSession } from "../state/types";
import type { Action } from "../state/machine";
import { reducer } from "../state/machine";

const STORAGE_KEY = "booking_session";

/**
 * Bump whenever the session SHAPE or the step-registry ORDER changes. A
 * persisted in-progress session from an older build is then discarded instead of
 * resuming with a stale per-item cursor (which would skip a newly-inserted step,
 * e.g. the up-front contact step) or pre-filled state from a prior flow.
 *
 * v2 (2026-06-07): inserted the required ContactStep, shifting step indices.
 * v3 (2026-07-19): RaceItem.packageId split into packageIdAdult/packageIdJunior
 *     (per-category package pricing) — old envelopes lack the new fields.
 */
const SCHEMA_VERSION = 3;

interface PersistedEnvelope {
  v: number;
  session: BookingSession;
}

function readSession(storageKey: string, schemaVersion: number): BookingSession | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedEnvelope>;
    if (parsed?.v !== schemaVersion || !parsed.session) {
      // Older build (or pre-versioning raw session) — discard so the customer
      // starts the current flow cleanly rather than mid-way with stale data.
      sessionStorage.removeItem(storageKey);
      return null;
    }
    return parsed.session;
  } catch {
    return null;
  }
}

function writeSession(session: BookingSession, storageKey: string, schemaVersion: number): void {
  try {
    const envelope: PersistedEnvelope = { v: schemaVersion, session };
    sessionStorage.setItem(storageKey, JSON.stringify(envelope));
  } catch {
    /* storage full or disabled — non-fatal */
  }
}

export function clearBookingSession(storageKey: string = STORAGE_KEY): void {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* non-fatal */
  }
}

/**
 * Peek at the persisted session WITHOUT the reducer — for components that only
 * read the cart (the landing's checkout bar, the floating MiniCart). Unwraps the
 * versioned envelope and drops older-schema sessions exactly like in-flow
 * hydration, so peek consumers never re-implement the storage shape. That
 * duplication is precisely what hid the checkout bar when the envelope landed:
 * callers read `parsed.items` off the new `{ v, session }` envelope, always got
 * `undefined`, and reported 0 items. Returns null when there's no current-schema
 * session (or on the server, where sessionStorage is absent).
 */
export function peekBookingSession(): BookingSession | null {
  if (typeof window === "undefined") return null;
  return readSession(STORAGE_KEY, SCHEMA_VERSION);
}

/**
 * Optional per-surface persistence config. The KIOSK passes its own
 * storageKey + schemaVersion so kiosk registry churn never invalidates web
 * sessions (and vice versa); web callers pass nothing and keep the exact
 * historical behavior.
 */
export interface PersistOptions {
  storageKey?: string;
  schemaVersion?: number;
}

export function usePersistedReducer(
  fallbackInitial: BookingSession,
  opts?: PersistOptions,
): [BookingSession, React.Dispatch<Action>, boolean] {
  const storageKey = opts?.storageKey ?? STORAGE_KEY;
  const schemaVersion = opts?.schemaVersion ?? SCHEMA_VERSION;
  const [session, dispatch] = useReducer(reducer, fallbackInitial);
  const [hydrated, setHydrated] = useState(false);
  const didRestore = useRef(false);

  // Hydrate from sessionStorage after mount (SSR-safe: no browser API during render)
  useEffect(() => {
    if (didRestore.current) return;
    didRestore.current = true;
    const stored = readSession(storageKey, schemaVersion);
    if (stored) {
      dispatch({ type: "restoreSession", session: stored });
    }
    setHydrated(true);
  }, [storageKey, schemaVersion]);

  // Persist on every state change, but only after hydration is complete
  useEffect(() => {
    if (hydrated) {
      writeSession(session, storageKey, schemaVersion);
    }
  }, [session, hydrated, storageKey, schemaVersion]);

  return [session, dispatch, hydrated];
}
