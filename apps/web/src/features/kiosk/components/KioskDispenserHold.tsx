"use client";

/**
 * Full-screen hold shown when the card dispenser hits a recoverable fault
 * (out of cards, bin full, jam, motor). The guest flow pauses here; the paid
 * transaction is never lost and resumes at the same card.
 *
 * Recovery is ALWAYS a staff "Resume" tap — never automatic — and Resume is
 * gated behind a staff PIN so a guest can't dismiss the hold themselves. When
 * the fault has a sensor signal (`resumeReady`), the button stays DISABLED
 * until the sensor confirms it's cleared (we poll status here), so staff can't
 * resume before the physical fault is fixed. Faults with no sensor signal
 * enable Resume immediately (staff judgment). Modeled on
 * KioskTerminalCheckoutGate's error screen + IdleWatcher's blocking overlay.
 */
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import type { CrtStatus } from "../card-reader";

/** PIN a staff member enters to resume a held dispense (stops a guest from
 *  tapping Resume themselves). Placeholder for now (owner 2026-07-19) — wire to
 *  the real staff / kiosk-admin PIN later. */
const STAFF_RESUME_PIN = "4321";

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
  const t = useT();
  // No predicate → the fault has no sensor signal; let staff resume immediately.
  // (One hold is active at a time and it unmounts between faults, so this
  // initial value is always correct for the current fault.)
  const [ready, setReady] = useState<boolean>(!fault.resumeReady);
  // Resume asks for a staff PIN first — a guest must not be able to dismiss it.
  const [askingPin, setAskingPin] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);

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

  const submitPin = () => {
    if (pin === STAFF_RESUME_PIN) {
      setAskingPin(false);
      setPin("");
      setPinError(false);
      onResume();
    } else {
      setPinError(true);
      setPin("");
    }
  };

  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-[#000418]/95 px-8">
      <div className="w-full max-w-lg rounded-3xl border border-amber-400/30 bg-[#0d1a36] p-10 text-center">
        <div className="font-heading text-4xl font-extrabold italic text-amber-300">
          {fault.title}
        </div>
        <p className="mt-4 text-lg text-white/70">{fault.message}</p>
        {fault.hint && <p className="mt-2 text-sm text-white/45">{fault.hint}</p>}

        <p className="mt-6 text-sm text-white/55">{t("pay.dispenser.paymentSafe")}</p>

        {!askingPin ? (
          <>
            <button
              type="button"
              disabled={!ready}
              onClick={() => setAskingPin(true)}
              className="font-heading mt-8 h-16 w-full rounded-full bg-[#00e2e5] text-xl font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
            >
              {ready ? t("pay.dispenser.resume") : t("pay.dispenser.waitingCleared")}
            </button>
            {!ready && (
              <p className="mt-2 text-xs text-white/40">{t("pay.dispenser.resumeUnlocks")}</p>
            )}
          </>
        ) : (
          <div className="mt-8 space-y-3">
            <p className="text-sm text-white/60">Staff PIN required to resume.</p>
            <input
              type="password"
              inputMode="numeric"
              data-osk-layout="numeric"
              value={pin}
              onChange={(e) => {
                setPin(e.target.value);
                setPinError(false);
              }}
              onKeyDown={(e) => e.key === "Enter" && submitPin()}
              placeholder="Staff PIN"
              className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-center text-2xl tracking-[0.4em] text-white focus:border-[#00e2e5] focus:outline-none"
            />
            {pinError && <p className="text-sm text-red-300">Incorrect PIN.</p>}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setAskingPin(false);
                  setPin("");
                  setPinError(false);
                }}
                className="h-14 flex-1 rounded-full border border-white/15 text-lg font-bold text-white/60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitPin}
                className="font-heading h-14 flex-1 rounded-full bg-[#00e2e5] text-lg font-extrabold uppercase italic text-[#04252b]"
              >
                Confirm
              </button>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={onSeeAttendant}
          className="mt-5 text-sm font-semibold text-white/45 underline"
        >
          {t("pay.dispenser.seeAttendant")}
        </button>
      </div>
    </div>
  );
}
