"use client";

/**
 * Card-present card capture on a paired Square reader (kiosk cardInputMethod
 * "reader"/"swipe").
 *
 * Uses the Terminal SAVE_CARD action, NOT a Terminal checkout, on purpose:
 * the guest dips/taps/swipes on the reader, Square vaults the card to a
 * card-on-file id, and the caller hands that id to reserveAll as a "saved
 * card" (cardSourceId). The ENTIRE existing reserve/deposit/gift-card money
 * rail is reused unchanged — no deposit split, no pause/resume of the
 * multi-vendor reserve. The only new surface is capturing the card.
 *
 * Requires a Square customer to attach the card to — created here from the
 * guest's contact via /api/square/customer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandedLoader } from "./BrandedLoader";
import { useT } from "../i18n";
import type { Brand } from "~/features/booking";

type Phase = "customer" | "starting" | "waiting" | "done" | "error" | "canceled";

const POLL_MS = 1500;
const DEADLINE_MS = 180_000;

export function KioskReaderPayment({
  brand,
  deviceId,
  referenceId,
  amountLabelCents,
  contact,
  onCaptured,
  onCancel,
}: {
  brand: Brand;
  deviceId: string;
  referenceId: string;
  /** For the on-screen "insert to pay $X" prompt (the charge happens in reserve). */
  amountLabelCents: number;
  contact: { firstName?: string; lastName?: string; email?: string; phone?: string };
  /** Card-on-file id + the Square customer it belongs to → feed reserve as a saved card. */
  onCaptured: (result: { cardId: string; customerId: string }) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("customer");
  const [error, setError] = useState<string | null>(null);
  const actionIdRef = useRef<string | null>(null);
  const customerIdRef = useRef<string | null>(null);
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
    const id = actionIdRef.current;
    if (id) {
      await fetch(`/api/kiosk/save-card?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(
        () => {},
      );
    }
    setPhase("canceled");
    onCancel();
  }, [cleanup, onCancel]);

  const start = useCallback(async () => {
    setError(null);
    setPhase("customer");
    try {
      // 1. Ensure a Square customer to vault the card onto.
      const custRes = await fetch("/api/square/customer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: contact.phone,
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
        }),
      });
      const custData = await custRes.json();
      if (!custRes.ok || !custData.customerId) {
        setError(t("pay.err.startCapture"));
        setPhase("error");
        return;
      }
      customerIdRef.current = custData.customerId;

      // 2. Send SAVE_CARD to the reader.
      setPhase("starting");
      const res = await fetch("/api/kiosk/save-card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId, customerId: custData.customerId, referenceId }),
      });
      const data = await res.json();
      if (!res.ok || !data.actionId) {
        setError(data.error || t("pay.err.reachReader"));
        setPhase("error");
        return;
      }
      actionIdRef.current = data.actionId;
      setPhase("waiting");

      // 3. Poll until the guest presents their card.
      deadlineRef.current = setTimeout(() => void cancel(), DEADLINE_MS);
      pollRef.current = setInterval(async () => {
        const id = actionIdRef.current;
        if (!id) return;
        try {
          const pr = await fetch(`/api/kiosk/save-card?id=${encodeURIComponent(id)}`);
          const pd = await pr.json();
          if (pd.status === "COMPLETED" && pd.cardId) {
            cleanup();
            setPhase("done");
            onCaptured({ cardId: pd.cardId, customerId: customerIdRef.current! });
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
  }, [deviceId, referenceId, contact, cancel, cleanup, onCaptured, onCancel, t]);

  useEffect(() => {
    void start();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-8 py-8 text-center">
      {(phase === "customer" || phase === "starting" || phase === "waiting") && (
        <>
          <BrandedLoader
            brand={brand}
            label={t("pay.reader.followPrompts")}
            sublabel={t("pay.reader.insertToPay", {
              amount: `$${(amountLabelCents / 100).toFixed(2)}`,
            })}
          />
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
          label={t("pay.reader.cardRead")}
          sublabel={t("pay.finishingBooking")}
        />
      )}
    </div>
  );
}
