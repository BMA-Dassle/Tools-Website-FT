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
 */
const SCHEMA_VERSION = 2;

interface PersistedEnvelope {
  v: number;
  session: BookingSession;
}

function readSession(): BookingSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedEnvelope>;
    if (parsed?.v !== SCHEMA_VERSION || !parsed.session) {
      // Older build (or pre-versioning raw session) — discard so the customer
      // starts the current flow cleanly rather than mid-way with stale data.
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed.session;
  } catch {
    return null;
  }
}

function writeSession(session: BookingSession): void {
  try {
    const envelope: PersistedEnvelope = { v: SCHEMA_VERSION, session };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    /* storage full or disabled — non-fatal */
  }
}

export function clearBookingSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* non-fatal */
  }
}

export function usePersistedReducer(
  fallbackInitial: BookingSession,
): [BookingSession, React.Dispatch<Action>, boolean] {
  const [session, dispatch] = useReducer(reducer, fallbackInitial);
  const [hydrated, setHydrated] = useState(false);
  const didRestore = useRef(false);

  // Hydrate from sessionStorage after mount (SSR-safe: no browser API during render)
  useEffect(() => {
    if (didRestore.current) return;
    didRestore.current = true;
    const stored = readSession();
    if (stored) {
      dispatch({ type: "restoreSession", session: stored });
    }
    setHydrated(true);
  }, []);

  // Persist on every state change, but only after hydration is complete
  useEffect(() => {
    if (hydrated) {
      writeSession(session);
    }
  }, [session, hydrated]);

  return [session, dispatch, hydrated];
}
