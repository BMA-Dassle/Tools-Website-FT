"use client";

import { useEffect, useState } from "react";

interface Props {
  onExtend: () => Promise<boolean>;
  onStartOver: () => void;
}

export function ReservationExpiredModal({ onExtend, onStartOver }: Props) {
  const [extending, setExtending] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  async function handleExtend() {
    setExtending(true);
    setError(false);
    const ok = await onExtend();
    if (!ok) {
      setError(true);
      setExtending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Reservation expired"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 p-6"
        style={{ backgroundColor: "#0a1128" }}
      >
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10">
            <svg
              className="h-5 w-5 text-red-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <path strokeLinecap="round" d="M12 6v6l4 2" />
            </svg>
          </div>
          <h3 className="font-display text-xl tracking-widest text-white uppercase">
            Reservation Expired
          </h3>
        </div>

        <p className="text-sm text-white/60">
          Your 10-minute hold has ended. Extend your time to keep your selected heats, or start a
          new booking.
        </p>

        {error && (
          <p className="mt-2 text-xs text-red-400">
            Could not extend your reservation. Please try again or start over.
          </p>
        )}

        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onStartOver}
            disabled={extending}
            className="flex-1 rounded-xl border border-white/20 px-4 py-2.5 text-sm font-semibold text-white/70 transition-colors hover:border-white/40 hover:text-white disabled:opacity-40"
          >
            Start Over
          </button>
          <button
            type="button"
            onClick={() => void handleExtend()}
            disabled={extending}
            className="flex-1 rounded-xl bg-[#00E2E5] px-4 py-2.5 text-sm font-bold text-[#000418] transition-colors hover:bg-white disabled:opacity-60"
          >
            {extending ? (
              <span className="inline-flex items-center gap-2">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#000418]/20 border-t-[#000418]" />
                Extending…
              </span>
            ) : (
              "Extend Time"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
