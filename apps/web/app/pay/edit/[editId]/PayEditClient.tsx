"use client";

/**
 * Client half of the payment-difference page: loads the token-gated summary,
 * renders the shared Square Web Payments form in tokenize mode, and completes
 * the pending edit via POST /api/edit-payments/[editId].
 *
 * Deliberately brand-neutral (served on both domains) and single-purpose:
 * amount due + card form. Wallets/gift cards are hidden by keeping the form
 * to its card section (tokenize mode with card-only sources still shows
 * wallets when available — acceptable; wallet payments simply skip the vault).
 */

import { useCallback, useEffect, useState } from "react";
import PaymentForm from "@/components/square/PaymentForm";

interface Summary {
  guestName: string;
  amountDueCents: number;
  expiresAt: string;
  state: string;
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export default function PayEditClient({ editId, token }: { editId: string; token: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "paying" | "done" | "error" | "void">(
    "loading",
  );
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/edit-payments/${encodeURIComponent(editId)}?t=${encodeURIComponent(token)}`,
          { cache: "no-store" },
        );
        const data = (await res.json()) as Summary & { error?: string };
        if (!alive) return;
        if (!res.ok) {
          setPhase("void");
          setMessage(
            data.error === "link_expired"
              ? "This payment link has expired. Please contact the venue for a new one."
              : data.error === "already_paid"
                ? "This update has already been paid — you're all set!"
                : "This payment link is no longer valid. Please contact the venue.",
          );
          return;
        }
        setSummary(data);
        setPhase("ready");
      } catch {
        if (!alive) return;
        setPhase("void");
        setMessage("Could not load this payment link. Please try again or contact the venue.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [editId, token]);

  const completePayment = useCallback(
    async (params: { cardNonce: string | null; savedCardId: string | null }) => {
      const nonce = params.savedCardId ?? params.cardNonce;
      if (!nonce) {
        setPhase("error");
        setMessage("Card entry failed — please try again.");
        return;
      }
      setPhase("paying");
      try {
        const res = await fetch(`/api/edit-payments/${encodeURIComponent(editId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, cardNonce: nonce }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string; detail?: string };
        if (!res.ok || !data.ok) {
          setPhase("error");
          setMessage(
            data.error === "plan_stale"
              ? "Your reservation changed since this link was created — please contact the venue."
              : (data.detail ?? "Payment failed — please check your card and try again."),
          );
          return;
        }
        setPhase("done");
      } catch {
        setPhase("error");
        setMessage("Payment failed — please try again.");
      }
    },
    [editId, token],
  );

  return (
    <main className="mx-auto max-w-lg px-4 py-10">
      <h1 className="mb-2 text-2xl font-bold">Complete Your Reservation Update</h1>

      {phase === "loading" && <p className="text-gray-500">Loading…</p>}

      {(phase === "void" || phase === "error") && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900">
          {message}
          {phase === "error" && (
            <button
              type="button"
              className="mt-3 block rounded bg-amber-600 px-4 py-2 font-semibold text-white"
              onClick={() => setPhase("ready")}
            >
              Try again
            </button>
          )}
        </div>
      )}

      {phase === "done" && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-green-900">
          <p className="font-semibold">Payment received — your reservation has been updated!</p>
          <p className="mt-1 text-sm">A receipt is on its way from Square. See you soon!</p>
        </div>
      )}

      {summary && (phase === "ready" || phase === "paying") && (
        <>
          <p className="mb-6 text-gray-600">
            Hi {summary.guestName.split(" ")[0]} — your reservation update has a balance of{" "}
            <span className="font-bold">{dollars(summary.amountDueCents)}</span>. Enter your card
            below to confirm the change.
          </p>
          {phase === "paying" && <p className="mb-4 text-gray-500">Processing…</p>}
          <PaymentForm
            amount={summary.amountDueCents / 100}
            itemName="Reservation Update"
            billId={editId}
            contact={{ firstName: summary.guestName, lastName: "", email: "", phone: "" }}
            onTokenize={completePayment}
            onSuccess={() => {}}
            onError={(err) => {
              setPhase("error");
              setMessage(err);
            }}
          />
          <p className="mt-6 text-xs text-gray-400">
            This link expires {new Date(summary.expiresAt).toLocaleString()}. Questions? Call the
            venue.
          </p>
        </>
      )}
    </main>
  );
}
