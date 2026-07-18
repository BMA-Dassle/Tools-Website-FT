"use client";

/**
 * Direct-Terminal card-present CHARGE on a paired Square reader (owner 2026-07-19:
 * "Kiosk is NOT going to use saved card").
 *
 * Unlike KioskReaderPayment (SAVE_CARD vault, being retired), this charges OUR
 * prepared deposit order DIRECTLY on the reader via a Terminal checkout → yields a
 * COMPLETED paymentId that reserve records as collected (no card is ever vaulted).
 * A Square reader also accepts HeadPinz/FastTrax gift-card SWIPES as tender, so
 * the gift-card prompt lives here.
 *
 * Idempotency: the checkout key is derived from the deposit order id — stable
 * across the reader mount (double-POST safe: the reader is armed once), unique per
 * prepare (a genuinely new booking gets a new order → new checkout).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandedLoader } from "./BrandedLoader";
import type { Brand } from "~/features/booking";

type Phase = "starting" | "waiting" | "done" | "error" | "canceled";

const POLL_MS = 1500;
const DEADLINE_MS = 180_000;

export function KioskReaderCheckout({
  brand,
  deviceId,
  seed,
  depositOrderId,
  depositCents,
  onCaptured,
  onCancel,
}: {
  brand: Brand;
  deviceId: string;
  /** Session anchor — the checkout reference + the anchor key the poll stamps. */
  seed: string;
  /** OUR deposit order the reader pays (created server-side in prepare). */
  depositOrderId: string;
  depositCents: number;
  /** The COMPLETED reader paymentId → reserve records it as collected. */
  onCaptured: (result: { paymentId: string }) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState<string | null>(null);
  const checkoutIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idemKey = `term-${depositOrderId}`;

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
        body: JSON.stringify({
          deviceId,
          amountCents: depositCents,
          referenceId: seed,
          orderId: depositOrderId,
          idempotencyKey: idemKey,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.checkoutId) {
        setError(data.error || "Couldn't reach the card reader.");
        setPhase("error");
        return;
      }
      checkoutIdRef.current = data.checkoutId;
      // Idempotent replay already finished (rare) — take the payment now.
      if (data.status === "COMPLETED" && data.paymentIds?.[0]) {
        setPhase("done");
        onCaptured({ paymentId: data.paymentIds[0] });
        return;
      }
      setPhase("waiting");

      deadlineRef.current = setTimeout(() => void cancel(), DEADLINE_MS);
      pollRef.current = setInterval(async () => {
        const id = checkoutIdRef.current;
        if (!id) return;
        try {
          const pr = await fetch(
            `/api/kiosk/terminal-checkout?id=${encodeURIComponent(id)}&seed=${encodeURIComponent(seed)}`,
          );
          const pd = await pr.json();
          if (pd.status === "COMPLETED" && pd.paymentIds?.[0]) {
            cleanup();
            setPhase("done");
            onCaptured({ paymentId: pd.paymentIds[0] });
          } else if (pd.status === "CANCELED") {
            cleanup();
            setPhase("canceled");
            onCancel();
          }
        } catch {
          /* transient — keep polling to the deadline */
        }
      }, POLL_MS);
    } catch {
      setError("Couldn't start the card reader.");
      setPhase("error");
    }
  }, [
    deviceId,
    depositCents,
    seed,
    depositOrderId,
    idemKey,
    cancel,
    cleanup,
    onCaptured,
    onCancel,
  ]);

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
            sublabel={`Tap, insert, or swipe to pay $${(depositCents / 100).toFixed(2)}`}
          />
          <div className="rounded-2xl border border-[#e8b14c]/40 bg-[#e8b14c]/10 px-6 py-4 text-lg text-[#f5d896]">
            Have a HeadPinz or FastTrax gift card? Swipe it on the credit card reader below.
          </div>
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
        <BrandedLoader brand={brand} label="Payment received" sublabel="Finishing your booking…" />
      )}
    </div>
  );
}
