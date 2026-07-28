"use client";

import { useState } from "react";
import { clarityTag, clarityEvent } from "~/lib/clarity";
import type { AppliedPromo } from "~/features/discount-codes";
import { BMI_VOUCHER_RE } from "~/features/booking/service/voucher-redeem";
import type { AppliedVoucherState } from "~/features/booking/state/types";

/** Voucher support (flag-gated by the caller) — the SAME rail the kiosk code
 *  entry uses (/api/booking/v2/voucher): a BMI voucher number typed into this
 *  field applies to the session's live BMI bill instead of the promo path. */
export interface PromoVoucherProps {
  /** The session's BMI bill — vouchers need one to apply to. */
  billId: string | null;
  center: string | null;
  /** Every session voucher, scan order (multiple comps stack). */
  applied: AppliedVoucherState[];
  onApplied: (voucher: AppliedVoucherState) => void;
  onCleared: (code: string) => void;
}

interface PromoCodeInputProps {
  /** The currently-applied session promo code, if any. */
  appliedCode: string | null;
  /** Dispatch the resolved multi-domain promo to the session. */
  onApply: (promo: AppliedPromo) => void;
  onClear: () => void;
  /** Present = this surface also accepts BMI voucher numbers. */
  voucher?: PromoVoucherProps;
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
export function PromoCodeInput({ appliedCode, onApply, onClear, voucher }: PromoCodeInputProps) {
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleApply() {
    const code = input.trim().toUpperCase().replace(/\s+/g, "");
    if (!code) return;
    // BMI voucher number? Route it down the voucher rail instead (same
    // endpoint + ledger the kiosk uses) — vouchers are BMI's, not our
    // discount codes, and they apply to the live bill.
    if (voucher && BMI_VOUCHER_RE.test(code)) {
      if (appliedVouchers.some((v) => v.code === code)) {
        setError("That voucher is already on this order.");
        return;
      }
      if (!voucher.billId) {
        setError("Pick your race time first, then apply your voucher here.");
        return;
      }
      setChecking(true);
      setError(null);
      try {
        const res = await fetch("/api/booking/v2/voucher", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "apply",
            billId: voucher.billId,
            code,
            center: voucher.center ?? undefined,
            source: "web",
          }),
        });
        const data = await res.json().catch(() => null);
        if (data?.ok && data.voucherOrderItemId) {
          clarityEvent("voucher:applied");
          voucher.onApplied({
            code,
            name: data.name,
            billId: voucher.billId,
            voucherOrderItemId: String(data.voucherOrderItemId),
          });
          setInput("");
        } else {
          clarityEvent("voucher:rejected");
          setError(
            data?.reason === "unknown"
              ? "We couldn't find that voucher — double-check the code."
              : data?.reason === "expired"
                ? "That voucher has expired."
                : data?.reason === "used"
                  ? "That voucher has already been used."
                  : "Couldn't apply that voucher. Try again or see the front desk.",
          );
        }
      } catch {
        setError("Couldn't apply that voucher. Try again.");
      } finally {
        setChecking(false);
      }
      return;
    }
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

  const appliedVouchers = voucher?.applied ?? [];

  async function clearVoucher(v: AppliedVoucherState) {
    if (!voucher) return;
    if (v.billId && v.voucherOrderItemId && !v.pending && !v.error) {
      await fetch("/api/booking/v2/voucher", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "remove",
          billId: v.billId,
          code: v.code,
          voucherOrderItemId: v.voucherOrderItemId,
          center: voucher.center ?? undefined,
        }),
      }).catch(() => {});
    }
    voucher.onCleared(v.code);
  }

  const voucherChips =
    appliedVouchers.length > 0 ? (
      <div className="mb-2 space-y-2">
        {appliedVouchers.map((v) => (
          <div
            key={v.code}
            className="flex items-center justify-between rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3"
          >
            <div className="text-sm">
              <span className="font-semibold text-amber-300">
                {v.name ?? "Voucher"}
                {v.pending ? " (applies at booking)" : v.error ? " — could not apply" : " applied"}
              </span>
              <span className="ml-2 font-mono text-xs text-white/50">…{v.code.slice(-4)}</span>
            </div>
            <button
              type="button"
              onClick={() => void clearVoucher(v)}
              className="text-sm text-white/50 underline-offset-2 hover:text-white hover:underline"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    ) : null;

  if (appliedCode) {
    return (
      <div>
        {voucherChips}
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
      </div>
    );
  }

  return (
    <div>
      {voucherChips}
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
    </div>
  );
}
