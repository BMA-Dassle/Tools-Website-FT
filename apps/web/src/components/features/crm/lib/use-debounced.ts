"use client";

import { useEffect, useRef, useState } from "react";

/**
 * `value` once it has stopped changing for `delayMs`.
 *
 * Why a separate `key`: the things we debounce are OBJECTS rebuilt on every
 * render, so an effect keyed on the value itself would reset its timer forever
 * and never fire. `key` is the caller's cheap identity for the value (a joined
 * string); the value itself is read from a ref when the timer fires, so the
 * settled result is always the newest one.
 *
 * Used by "Try a lead": without it every keystroke in the Guests box ran the
 * whole engine — four Neon queries per character.
 */
export function useDebouncedValue<T>(value: T, delayMs: number, key: string): T {
  const [settled, setSettled] = useState(value);
  const latest = useRef(value);
  const settledKey = useRef(key);

  useEffect(() => {
    latest.current = value;
  });

  useEffect(() => {
    if (settledKey.current === key) return undefined;
    const timer = setTimeout(() => {
      settledKey.current = key;
      setSettled(latest.current);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [key, delayMs]);

  return settled;
}
