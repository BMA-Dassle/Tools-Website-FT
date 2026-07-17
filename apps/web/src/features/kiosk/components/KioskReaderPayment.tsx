"use client";

/**
 * Card-present payment on a paired Square reader (kiosk cardInputMethod
 * "reader"/"swipe"). Sends the amount to the Terminal via
 * /api/kiosk/terminal-checkout, then polls until the guest taps/dips/swipes.
 * On COMPLETED it hands the Square paymentId back to the caller.
 *
 * INTEGRATION SEAM (not yet wired into the reserve money rail): the reserve
 * routes currently consume a card NONCE (cardSourceId). A Terminal checkout
 * instead yields a completed paymentId, so reserve needs an
 * `externalPayment: { paymentId }` alternative that SKIPS its own Square
 * charge and books against the already-captured payment. That's a
 * deposit/unified-reserve change that must ship with a live card-present
 * smoke test (a launch gate) — this component is the ready client half.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandedLoader } from "./BrandedLoader";
import type { Brand } from "~/features/booking";

type Phase = "idle" | "starting" | "waiting" | "done" | "error" | "canceled";

const POLL_MS = 1500;
const DEADLINE_MS = 180_000; // match Mercury's 3-min terminal deadline

export function KioskReaderPayment({
  brand,
  deviceId,
  amountCents,
  referenceId,
  note,
  onComplete,
  onCancel,
}: {
  brand: Brand;
  deviceId: string;
  amountCents: number;
  referenceId: string;
  note?: string;
  onComplete: (paymentId: string) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const checkoutIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (deadlineRef.current) clearTimeout(deadlineRef.current);
    pollRef.current = null;
    deadlineRef.current = null;
  }, []);

  const cancel = useCallback(async () => {
    cleanup();
    const id = checkoutIdRef.current;
    if (id) {
      await fetch(`/api/kiosk/terminal-checkout?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
    setPhase("canceled");
    onCancel();
  }, [cleanup, onCancel]);

  const start = useCallback(async () => {
    setError(null);
    setPhase("starting");
    try {
      const res = await fetch("/api/kiosk/terminal-checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId, amountCents, referenceId, note }),
      });
      const data = await res.json();
      if (!res.ok || !data.checkoutId) {
        setError(data.error || "Couldn't reach the card reader.");
        setPhase("error");
        return;
      }
      checkoutIdRef.current = data.checkoutId;
      setPhase("waiting");

      deadlineRef.current = setTimeout(() => void cancel(), DEADLINE_MS);
      pollRef.current = setInterval(async () => {
        const id = checkoutIdRef.current;
        if (!id) return;
        try {
          const pr = await fetch(`/api/kiosk/terminal-checkout?id=${encodeURIComponent(id)}`);
          const pd = await pr.json();
          if (pd.status === "COMPLETED") {
            cleanup();
            setPhase("done");
            onComplete(pd.paymentIds?.[0] ?? "");
          } else if (pd.status === "CANCELED" || pd.status === "CANCEL_REQUESTED") {
            cleanup();
            setPhase("canceled");
            onCancel();
          }
        } catch {
          /* transient — keep polling until the deadline */
        }
      }, POLL_MS);
    } catch {
      setError("Couldn't start the card reader.");
      setPhase("error");
    }
  }, [deviceId, amountCents, referenceId, note, cancel, cleanup, onComplete, onCancel]);

  useEffect(() => {
    void start();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-8 py-8 text-center">
      {(phase === "starting" || phase === "waiting") && (
        <>
          <BrandedLoader
            brand={brand}
            label="Follow the prompts on the card reader"
            sublabel={`Tap, insert, or swipe to pay $${(amountCents / 100).toFixed(2)}`}
          />
          <button
            type="button"
            onClick={() => void cancel()}
            className="font-heading rounded-full border-2 border-white/15 px-8 py-3 text-lg font-bold uppercase tracking-widest text-white/60"
          >
            Cancel
          </button>
        </>
      )}
      {phase === "error" && (
        <div className="space-y-5">
          <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-6 py-5 text-lg text-red-100">
            {error}
          </div>
          <div className="flex justify-center gap-3">
            <button
              type="button"
              onClick={() => void start()}
              className="font-heading rounded-full bg-[#00e2e5] px-8 py-3 text-lg font-extrabold uppercase italic text-[#04252b]"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="font-heading rounded-full border-2 border-white/15 px-8 py-3 text-lg font-bold uppercase tracking-widest text-white/60"
            >
              Back
            </button>
          </div>
        </div>
      )}
      {phase === "done" && (
        <BrandedLoader brand={brand} label="Payment approved" sublabel="Finishing your booking…" />
      )}
    </div>
  );
}
