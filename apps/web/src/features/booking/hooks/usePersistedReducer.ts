"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import type { BookingSession } from "../state/types";
import type { Action } from "../state/machine";
import { reducer } from "../state/machine";

const STORAGE_KEY = "booking_session";

function readSession(): BookingSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as BookingSession;
  } catch {
    return null;
  }
}

function writeSession(session: BookingSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
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
