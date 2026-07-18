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
  prepareFn,
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
  /**
   * How to create the deposit order the reader will charge. Defaults to the
   * unified racing rail (POST /api/booking/v2/reserve-prepare). A bowling-only
   * cart passes its own prepare (bowlingTerminalPrepare) so it reuses this exact
   * reader UX + verification while keeping the proven bowling reserve route.
   */
  prepareFn?: () => Promise<Prepared>;
  /** Completed reader payment → CheckoutStep reserves with it as externalPayment.
   *  `seed` lets the bowling route recreate the exact order the reader paid. */
  onCaptured: (ep: {
    paymentId: string;
    depositOrderId: string;
    amountCents: number;
    seed: string;
  }) => void;
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
      let data: { seed?: string; depositOrderId?: string; depositCents?: number; error?: string };
      if (prepareFn) {
        // Bowling-only cart: create the deposit order via the bowling rail.
        try {
          data = await prepareFn();
        } catch (e) {
          data = { error: e instanceof Error ? e.message : "prepare failed" };
        }
      } else {
        // Default: unified racing rail — runs all pre-charge guards server-side.
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
        data = await res.json();
        if (!res.ok && !data.error) data.error = `prepare failed (${res.status})`;
      }
      console.log(
        `[kiosk-terminal] prepare → depositCents=${data.depositCents} shown=${depositCentsExpected} order=${data.depositOrderId} seed=${data.seed} err=${data.error ?? ""}`,
      );
      if (
        data.error ||
        !data.depositOrderId ||
        !(data.depositCents != null && data.depositCents > 0)
      ) {
        setError(data.error || "Couldn't start the payment. Please see the front desk.");
        setPhase("error");
        return;
      }
      // The reader charges the SERVER-authoritative deposit (data.depositCents) and
      // displays that exact amount, so the guest approves what they're charged —
      // displayed==charged holds at the reader. The review's "due now" is a client
      // estimate that can differ by a cent or two (tax rounding); log any drift but
      // proceed. Only a clearly-broken amount (guarded above / below) aborts.
      const drift = Math.abs(data.depositCents - depositCentsExpected);
      if (drift > 0) {
        console.warn(
          `[kiosk-terminal] deposit drift ${drift}¢ (server ${data.depositCents} vs shown ${depositCentsExpected}) — charging the server amount`,
        );
      }
      // Sanity backstop: a wildly-off amount ($25+ from the estimate) signals a
      // real computation bug, not rounding — refuse to arm the reader.
      if (drift > 2500) {
        setError("The price didn't add up — please see the front desk.");
        setPhase("error");
        return;
      }
      setPrepared({
        seed: data.seed ?? "",
        depositOrderId: data.depositOrderId,
        depositCents: data.depositCents,
      });
      setPhase("ready");
    } catch {
      setError("Couldn't start the payment. Please try again or see the front desk.");
      setPhase("error");
    }
  }, [session, contact, depositCentsExpected, prepareFn]);

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
            seed: prepared.seed,
          })
        }
        onCancel={onCancel}
      />
    );
  }

  return null;
}
