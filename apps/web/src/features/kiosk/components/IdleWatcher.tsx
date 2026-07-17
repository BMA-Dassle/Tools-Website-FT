"use client";

/**
 * Kiosk idle watchdog. Any pointer/key activity resets the timer; expiry
 * shows a "Still there?" countdown sheet; the countdown running out fires
 * onReset (which must release vendor holds BEFORE clearing the session —
 * see KioskFlow.handleStartOver). `paused` freezes the whole watchdog while
 * a charge or vendor hold is mid-flight: never reset a guest who's paying.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const WARNING_SECONDS = 20;

export function IdleWatcher({
  timeoutMs,
  paused,
  onReset,
}: {
  timeoutMs: number;
  paused: boolean;
  onReset: () => void;
}) {
  const [warning, setWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(WARNING_SECONDS);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warningRef = useRef(false);
  warningRef.current = warning;

  const armIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setWarning(true), timeoutMs);
  }, [timeoutMs]);

  // Activity resets the idle timer (but never dismisses an OPEN warning —
  // that requires the explicit "I'm still here" tap, so a pocket-brush
  // doesn't silently keep a stale session alive).
  useEffect(() => {
    if (paused) {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      return;
    }
    const onActivity = () => {
      if (!warningRef.current) armIdleTimer();
    };
    armIdleTimer();
    document.addEventListener("pointerdown", onActivity, { passive: true, capture: true });
    document.addEventListener("keydown", onActivity, { passive: true, capture: true });
    return () => {
      document.removeEventListener("pointerdown", onActivity, { capture: true });
      document.removeEventListener("keydown", onActivity, { capture: true });
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [paused, armIdleTimer]);

  // Warning countdown.
  useEffect(() => {
    if (!warning) return;
    setSecondsLeft(WARNING_SECONDS);
    const iv = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(iv);
          setWarning(false);
          onReset();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [warning, onReset]);

  if (!warning) return null;

  const dash = 553; // 2π × r(88)
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#000418]/95 backdrop-blur">
      <div className="flex w-[min(90vw,560px)] flex-col items-center gap-8 rounded-3xl border border-white/10 bg-[#0d1a36] px-10 py-12 text-center">
        <div className="relative grid h-[140px] w-[140px] place-items-center">
          <svg
            width="140"
            height="140"
            viewBox="0 0 200 200"
            className="absolute inset-0 -rotate-90"
          >
            <circle
              cx="100"
              cy="100"
              r="88"
              fill="none"
              strokeWidth="10"
              className="stroke-white/10"
            />
            <circle
              cx="100"
              cy="100"
              r="88"
              fill="none"
              strokeWidth="10"
              strokeLinecap="round"
              stroke="#f0b341"
              strokeDasharray={dash}
              strokeDashoffset={dash * (1 - secondsLeft / WARNING_SECONDS)}
              style={{ transition: "stroke-dashoffset 1s linear" }}
            />
          </svg>
          <span className="font-heading text-5xl font-extrabold tabular-nums">{secondsLeft}</span>
        </div>
        <div className="font-heading text-4xl font-extrabold italic">Still there?</div>
        <p className="max-w-[24ch] text-lg text-white/55">
          We&rsquo;ll clear this session and release your held times
        </p>
        <button
          type="button"
          onClick={() => setWarning(false)}
          className="font-heading h-16 w-full rounded-full bg-[#00e2e5] text-xl font-extrabold uppercase italic tracking-wide text-[#04252b]"
        >
          I&rsquo;m still here
        </button>
        <button
          type="button"
          onClick={() => {
            setWarning(false);
            onReset();
          }}
          className="font-heading text-base font-bold uppercase tracking-widest text-white/50"
        >
          Start over instead
        </button>
      </div>
    </div>
  );
}
