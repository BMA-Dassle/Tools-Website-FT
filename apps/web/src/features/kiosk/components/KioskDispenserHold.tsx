"use client";

/**
 * Full-screen hold shown when the card dispenser hits a recoverable fault
 * (out of cards, bin full, jam, motor). The guest flow pauses here; the paid
 * transaction is never lost and resumes at the same card.
 *
 * Recovery is ALWAYS a staff "Resume" tap — never automatic. When the fault
 * has a sensor signal (`resumeReady`), the button stays DISABLED until the
 * sensor confirms it's cleared (we poll status here), so staff can't resume
 * before the physical fault is fixed. Faults with no sensor signal enable
 * Resume immediately (staff judgment). Modeled on KioskTerminalCheckoutGate's
 * error screen + IdleWatcher's blocking overlay.
 */
import { useEffect, useState } from "react";
import type { CrtStatus } from "../card-reader";

export interface DispenserHoldFault {
  title: string;
  message: string;
  hint?: string;
  /** Gates the Resume button — disabled until this returns true. Omitted = enabled now. */
  resumeReady?: (s: CrtStatus) => boolean;
}

export function KioskDispenserHold({
  fault,
  getStatusNow,
  onResume,
  onSeeAttendant,
}: {
  fault: DispenserHoldFault;
  getStatusNow: () => Promise<CrtStatus | null>;
  onResume: () => void;
  onSeeAttendant: () => void;
}) {
  // No predicate → the fault has no sensor signal; let staff resume immediately.
  // (One hold is active at a time and it unmounts between faults, so this
  // initial value is always correct for the current fault.)
  const [ready, setReady] = useState<boolean>(!fault.resumeReady);

  // Poll status while the predicate hasn't cleared, to unlock Resume. `setReady`
  // is only called from the async poll callback (never synchronously here).
  useEffect(() => {
    const pred = fault.resumeReady;
    if (!pred) return; // already enabled from initial state
    let alive = true;
    const tick = async () => {
      const s = await getStatusNow();
      if (alive && s && pred(s)) setReady(true);
    };
    void tick();
    const timer = setInterval(() => void tick(), 700);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [fault, getStatusNow]);

  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-[#000418]/95 px-8">
      <div className="w-full max-w-lg rounded-3xl border border-amber-400/30 bg-[#0d1a36] p-10 text-center">
        <div className="font-heading text-4xl font-extrabold italic text-amber-300">
          {fault.title}
        </div>
        <p className="mt-4 text-lg text-white/70">{fault.message}</p>
        {fault.hint && <p className="mt-2 text-sm text-white/45">{fault.hint}</p>}

        <p className="mt-6 text-sm text-white/55">
          Your payment is safe — the transaction will pick up right where it left off.
        </p>

        <button
          type="button"
          disabled={!ready}
          onClick={onResume}
          className="font-heading mt-8 h-16 w-full rounded-full bg-[#00e2e5] text-xl font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
        >
          {ready ? "Resume" : "Waiting until it’s cleared…"}
        </button>
        {!ready && (
          <p className="mt-2 text-xs text-white/40">
            Resume unlocks automatically once the dispenser reports it’s clear.
          </p>
        )}

        <button
          type="button"
          onClick={onSeeAttendant}
          className="mt-5 text-sm font-semibold text-white/45 underline"
        >
          See an attendant
        </button>
      </div>
    </div>
  );
}
