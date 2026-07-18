"use client";

/**
 * KIOSK direct-Terminal checkout orchestrator (owner: NO saved card).
 *
 * Sequence (all before any money moves except the reader tap itself):
 *   1. POST /api/booking/v2/reserve-prepare {session, contact} → the server runs
 *      ALL pre-charge guards, builds the day-of order(s), creates the GIFT_CARD
 *      deposit order, and writes a persist-first anchor → {seed, depositOrderId,
 *      depositCents}. (A stale/expired hold fails HERE, 409, with nothing charged.)
 *   2. Assert depositCents === the displayed "due now" (displayed==charged
 *      tripwire) — abort with no charge on a mismatch.
 *   3. Charge that deposit order DIRECTLY on the reader (KioskReaderCheckout).
 *   4. Hand the completed paymentId up → CheckoutStep calls reserve-all with it as
 *      externalPayment, which records it as collected (no re-charge).
 *
 * The bill-liveness window between prepare and the tap is covered server-side
 * (reserve re-checks) + by the terminal-orphan reconcile. See
 * tasks/kiosk-terminal-charge.md.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandedLoader } from "./BrandedLoader";
import { KioskReaderCheckout } from "./KioskReaderCheckout";
import type { Brand, BookingSession } from "~/features/booking";
import type { ContactInfo } from "~/features/booking/types";

interface Prepared {
  seed: string;
  depositOrderId: string;
  depositCents: number;
}

export function KioskTerminalCheckoutGate({
  session,
  contact,
  brand,
  deviceId,
  bmiBillId,
  depositCentsExpected,
  onCaptured,
  onCancel,
}: {
  session: BookingSession;
  contact: ContactInfo;
  brand: Brand;
  deviceId: string;
  bmiBillId: string;
  /** The displayed "due now" in cents — the server deposit MUST equal this. */
  depositCentsExpected: number;
  /** Completed reader payment → CheckoutStep reserves with it as externalPayment. */
  onCaptured: (ep: { paymentId: string; depositOrderId: string; amountCents: number }) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<"preparing" | "ready" | "error">("preparing");
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  // Prepare exactly once per mount — it creates a Square deposit order.
  const preparedOnce = useRef(false);

  const prepare = useCallback(async () => {
    setError(null);
    setPhase("preparing");
    try {
      const res = await fetch("/api/booking/v2/reserve-prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session,
          contact: {
            firstName: contact.firstName,
            lastName: contact.lastName,
            email: contact.email,
            phone: contact.phone,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.depositOrderId) {
        setError(data.error || "Couldn't start the payment. Please see the front desk.");
        setPhase("error");
        return;
      }
      // Displayed == charged tripwire: the reader must charge exactly what the
      // review screen showed. A mismatch means a pricing drift — abort BEFORE the
      // reader is armed (nothing charged) rather than take the wrong amount.
      if (data.depositCents !== depositCentsExpected) {
        console.error(
          `[kiosk-terminal] deposit mismatch: server ${data.depositCents} vs shown ${depositCentsExpected}`,
        );
        setError("The price changed — please go back and review before paying.");
        setPhase("error");
        return;
      }
      setPrepared({
        seed: data.seed,
        depositOrderId: data.depositOrderId,
        depositCents: data.depositCents,
      });
      setPhase("ready");
    } catch {
      setError("Couldn't start the payment. Please try again or see the front desk.");
      setPhase("error");
    }
  }, [session, contact, depositCentsExpected]);

  useEffect(() => {
    if (preparedOnce.current) return;
    preparedOnce.current = true;
    void prepare();
  }, [prepare]);

  if (phase === "preparing") {
    return (
      <div className="py-8">
        <BrandedLoader brand={brand} label="Getting the reader ready…" sublabel="One moment" />
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="mx-auto max-w-md space-y-5 py-8 text-center">
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-6 py-5 text-lg text-red-100">
          {error}
        </div>
        <div className="flex justify-center gap-3">
          <button
            type="button"
            onClick={() => {
              preparedOnce.current = true;
              void prepare();
            }}
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
    );
  }

  if (phase === "ready" && prepared) {
    return (
      <KioskReaderCheckout
        brand={brand}
        deviceId={deviceId}
        seed={prepared.seed || bmiBillId}
        depositOrderId={prepared.depositOrderId}
        depositCents={prepared.depositCents}
        onCaptured={({ paymentId }) =>
          onCaptured({
            paymentId,
            depositOrderId: prepared.depositOrderId,
            amountCents: prepared.depositCents,
          })
        }
        onCancel={onCancel}
      />
    );
  }

  return null;
}
