"use client";

/**
 * Armed-only QR/barcode wedge capture for the check-in find screen.
 *
 * A hardware wedge scanner types its payload as a fast keystroke burst ending
 * in Enter. We capture that burst ONLY while `armed` (a "Scan my code" button
 * turns it on for a few seconds) so it never fights the on-screen keyboard or
 * IdleWatcher's own global keydown listener — outside the armed window this
 * hook adds no listeners at all.
 *
 * Unlike the card-reader wedge parsers (magstripe/digit-oriented — they'd
 * mangle a scanned URL), this hands the RAW burst to the caller, which passes
 * it to the server's classifyScan (URL / W# / r{billId} / native code).
 */
import { useEffect, useRef, useState } from "react";

const IDLE_MS = 400; // a gap this long after ≥4 chars ends the burst
const AUTO_DISARM_MS = 15_000;

export function useWedgeScan(onScan: (raw: string) => void): {
  armed: boolean;
  arm: () => void;
  disarm: () => void;
} {
  const [armed, setArmed] = useState(false);
  const bufRef = useRef("");
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the latest callback without re-arming the capture effect.
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!armed) return;
    const finish = () => {
      const raw = bufRef.current;
      bufRef.current = "";
      setArmed(false);
      if (raw.trim()) onScanRef.current(raw.trim());
    };
    const onKey = (e: KeyboardEvent) => {
      // Swallow the burst so it doesn't type into whatever has focus.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Enter") {
        finish();
        return;
      }
      if (e.key.length === 1) bufRef.current += e.key;
      if (idleRef.current) clearTimeout(idleRef.current);
      idleRef.current = setTimeout(() => {
        if (bufRef.current.length >= 4) finish();
      }, IDLE_MS);
    };
    const disarmTimer = setTimeout(() => finish(), AUTO_DISARM_MS);
    window.addEventListener("keydown", onKey, true); // capture phase
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(disarmTimer);
      if (idleRef.current) clearTimeout(idleRef.current);
    };
  }, [armed]);

  return {
    armed,
    arm: () => {
      bufRef.current = "";
      setArmed(true);
    },
    disarm: () => setArmed(false),
  };
}
