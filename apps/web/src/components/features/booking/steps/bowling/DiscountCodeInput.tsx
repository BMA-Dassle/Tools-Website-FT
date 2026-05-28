"use client";

import { useState } from "react";

interface AppliedDiscount {
  code: string;
  description: string | null;
  amountPct: number | null;
  amountCents: number | null;
  allowedWeekdays: number[] | null;
  expiresAt: string;
}

interface DiscountCodeInputProps {
  locationId: string;
  appliedCode: string | null;
  onApply: (discount: AppliedDiscount) => void;
  onClear: () => void;
}

export function DiscountCodeInput({
  locationId,
  appliedCode,
  onApply,
  onClear,
}: DiscountCodeInputProps) {
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApply() {
    const code = input.trim().toUpperCase();
    if (!code) return;
    setChecking(true);
    setError(null);
    try {
      const res = await fetch("/api/discount-codes/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, domain: "bowling", locationId }),
      });
      const data = await res.json();
      if (!data?.valid) {
        const reason = data?.reason ?? "unknown";
        const messages: Record<string, string> = {
          expired: `Code ${code} has expired.`,
          not_yet_active: `Code ${code} isn't active yet.`,
          exhausted: `Code ${code} has been fully redeemed.`,
          wrong_location: `Code ${code} isn't valid at this center.`,
          wrong_domain: `Code ${code} isn't valid for bowling.`,
          rate_limited: "Too many attempts — try again shortly.",
        };
        setError(messages[reason] ?? `Code ${code} is not valid.`);
        return;
      }
      onApply({
        code: data.code,
        description: data.description ?? null,
        amountPct: data.amountPct ?? null,
        amountCents: data.amountCents ?? null,
        allowedWeekdays: data.allowedWeekdays ?? null,
        expiresAt: data.expiresAt,
      });
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
            Discount code
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
