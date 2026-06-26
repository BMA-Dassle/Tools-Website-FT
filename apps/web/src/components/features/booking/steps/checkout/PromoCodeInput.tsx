"use client";

import { useState } from "react";
import { clarityTag, clarityEvent } from "~/lib/clarity";
import type { AppliedPromo } from "~/features/discount-codes";

interface PromoCodeInputProps {
  /** The currently-applied session promo code, if any. */
  appliedCode: string | null;
  /** Dispatch the resolved multi-domain promo to the session. */
  onApply: (promo: AppliedPromo) => void;
  onClear: () => void;
}

/**
 * Checkout "Have a code?" field. Resolves the FULL multi-domain `AppliedPromo`
 * via `/api/booking/v2/promo` (same shape `session.appliedPromo` carries), so
 * the price-reduction seams pick it up. Mirrors the bowling DiscountCodeInput
 * styling; the difference is the multi-domain promo route + dispatch shape.
 *
 * The promo route is anti-enumeration (never says WHY a code is invalid), so
 * a failure shows a single generic message.
 */
export function PromoCodeInput({ appliedCode, onApply, onClear }: PromoCodeInputProps) {
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApply() {
    const code = input.trim().toUpperCase();
    if (!code) return;
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/booking/v2/promo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!data?.valid || !data?.promo) {
        setError(`Code ${code} isn't valid.`);
        clarityTag("promo_result", "rejected");
        clarityEvent("promo:rejected");
        return;
      }
      clarityTag("promo_code", data.promo.code);
      clarityEvent("promo:applied");
      onApply(data.promo as AppliedPromo);
      setInput("");
      setError(null);
    } catch {
      setError("Couldn't validate that code. Try again.");
    } finally {
      setChecking(false);
    }
  }

  if (appliedCode) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded-full bg-green-500/[0.18] px-2.5 py-1 text-xs font-bold tracking-wider text-green-500">
            &#10003; {appliedCode}
          </span>
          <span className="text-xs text-white/50">applied — savings shown below</span>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="text-xs uppercase tracking-wider text-white/40 transition-colors hover:text-white/80"
        >
          &#10005; Remove
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-[200px] flex-1 items-center gap-2">
          <span className="shrink-0 text-xs uppercase tracking-wider text-white/40">
            Promo code
          </span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleApply();
              }
            }}
            placeholder="Have a code?"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-white placeholder:text-white/30 focus:border-white/25 focus:outline-none"
          />
        </div>
        <button
          type="button"
          disabled={!input || checking}
          onClick={() => void handleApply()}
          className="rounded-lg bg-green-500/[0.18] px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-green-500 transition-all disabled:opacity-40"
        >
          {checking ? "Checking…" : "Apply"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
