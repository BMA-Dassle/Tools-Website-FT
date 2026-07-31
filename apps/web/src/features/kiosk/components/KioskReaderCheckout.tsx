"use client";

/**
 * Direct-Terminal card-present CHARGE on a paired Square reader (owner 2026-07-19:
 * "Kiosk is NOT going to use saved card").
 *
 * Unlike the retired KioskReaderPayment (SAVE_CARD vault, deleted 2026-07-31 —
 * no card is ever vaulted on a kiosk), this charges OUR
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
import { useT } from "../i18n";
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
  split,
  giftCardAction,
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
  /** GIFT-CARD (split v1) mode: arm the reader auth-only for the REMAINDER —
   *  the server validates the amount against the anchor and salts the key;
   *  capture happens later via /deposit-tenders/capture. */
  split?: { splitToken: string; amountCents: number };
  /** Flag-gated "Use a gift card" entry: replaces the amber swipe banner.
   *  Activating it cancels the armed full-amount checkout FIRST, then hands
   *  control to the gift-card flow — the reader is never double-armed. */
  giftCardAction?: { label: string; onActivate: () => void };
  /** The COMPLETED reader paymentId → reserve records it as collected. */
  onCaptured: (result: { paymentId: string }) => void;
  onCancel: () => void;
}) {
  const t = useT();
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

  const dismissArmed = useCallback(async () => {
    cleanup();
    const id = checkoutIdRef.current;
    if (id) {
      await fetch(`/api/kiosk/terminal-checkout?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
  }, [cleanup]);

  const cancel = useCallback(async () => {
    await dismissArmed();
    setPhase("canceled");
    onCancel();
  }, [dismissArmed, onCancel]);

  const start = useCallback(async () => {
    setError(null);
    setPhase("starting");
    try {
      const res = await fetch("/api/kiosk/terminal-checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          split
            ? {
                // Split mode: the SERVER computes + validates the amount from
                // the anchor and derives the salted key — the client claim is
                // only cross-checked (409 = re-sync).
                deviceId,
                referenceId: seed,
                seed,
                splitToken: split.splitToken,
                splitAmountCents: split.amountCents,
              }
            : {
                deviceId,
                amountCents: depositCents,
                referenceId: seed,
                orderId: depositOrderId,
                idempotencyKey: idemKey,
              },
        ),
      });
      const data = await res.json();
      if (!res.ok || !data.checkoutId) {
        setError(data.error || t("pay.err.reachReader"));
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
      setError(t("pay.err.startReader"));
      setPhase("error");
    }
  }, [
    deviceId,
    depositCents,
    seed,
    depositOrderId,
    idemKey,
    split,
    cancel,
    cleanup,
    onCaptured,
    onCancel,
    t,
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
            label={t("pay.reader.followPrompts")}
            sublabel={t("pay.reader.tapToPay", {
              amount: `$${((split?.amountCents ?? depositCents) / 100).toFixed(2)}`,
            })}
          />
          {split ? (
            <div className="text-base text-white/40">{t("giftcard.readerExactAmount")}</div>
          ) : giftCardAction ? (
            <button
              type="button"
              onClick={() => {
                // Release the armed full-amount checkout BEFORE the gift-card
                // flow starts — one live checkout at a time.
                void dismissArmed().then(giftCardAction.onActivate);
              }}
              className="flex w-full items-center justify-between rounded-2xl border-2 border-[#f0b341]/55 bg-[#f0b341]/10 px-6 py-5 text-left text-lg font-bold text-[#f0b341]"
            >
              <span>🎁 {giftCardAction.label}</span>
              <span aria-hidden="true">→</span>
            </button>
          ) : (
            <div className="rounded-2xl border border-[#e8b14c]/40 bg-[#e8b14c]/10 px-6 py-4 text-lg text-[#f5d896]">
              {t("pay.reader.giftCardSwipe")}
            </div>
          )}
          <button
            type="button"
            onClick={() => void cancel()}
            className="font-heading rounded-full border-2 border-white/15 px-8 py-3 text-lg font-bold uppercase tracking-widest text-white/60"
          >
            {t("pay.cancel")}
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
              {t("pay.tryAgain")}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="font-heading rounded-full border-2 border-white/15 px-8 py-3 text-lg font-bold uppercase tracking-widest text-white/60"
            >
              {t("pay.back")}
            </button>
          </div>
        </div>
      )}
      {phase === "done" && (
        <BrandedLoader
          brand={brand}
          label={t("pay.reader.paymentReceived")}
          sublabel={t("pay.finishingBooking")}
        />
      )}
    </div>
  );
}
