"use client";

import { useState } from "react";
import { CENTER_LIST } from "~/config/intercard-centers";
import { formatVoucherCode } from "~/features/game-cards/vouchers/codes";
import type { VoucherStatus } from "~/features/game-cards/service/native-voucher";

/**
 * Guest voucher redemption — put the value on a card they already have.
 *
 * Per-item state is rendered, not a single verdict: a multi-item voucher is
 * partly redeemable, so a spent Game Zone line must not make the page read
 * "used" while other value is still live.
 *
 * There is no dispenser on a phone. A guest with no card is told to scan the
 * code at a kiosk instead of being dead-ended — that path DOES issue a card.
 */

/** Refusal → guest copy. Every reason is phrased: nobody is standing there. */
const REASON_COPY: Record<string, string> = {
  bad_format: "That code doesn’t look right — check it and try again.",
  unknown: "We couldn’t find that voucher.",
  voided: "That voucher was cancelled. Please contact us and we’ll sort it out.",
  expired: "That voucher has expired.",
  used: "That voucher has already been used.",
  not_redeemable: "That voucher can’t be loaded onto a card — bring it to Guest Services.",
  card_not_found: "We couldn’t find that card number. Check the number on the back of your card.",
  card_lookup_failed: "We couldn’t reach the card system just now — please try again shortly.",
  rate_limited: "Too many tries. Give it a few minutes and try again.",
  storage: "Something went wrong on our end — nothing was used. Please try again.",
};

export function VoucherRedeemView({ status }: { status: VoucherStatus }) {
  const [account, setAccount] = useState("");
  const [locationCode, setLocationCode] = useState(CENTER_LIST[0].code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    bonusTokens: number;
    balance?: { tokens: number; bonusTokens: number };
    pending?: boolean;
  } | null>(null);

  const redeemable = status.items.filter((i) => i.redeemable && !i.spent);
  const alreadySpent = status.items.filter((i) => i.spent);
  const notHere = status.items.filter((i) => !i.redeemable && !i.spent);
  const voided = !!status.voidedAt;
  // Server-resolved (see VoucherStatus.expired) — never read the clock here.
  const expired = status.expired;

  const submit = async () => {
    const acct = account.trim();
    if (!acct || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/game-cards/voucher-redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "to-card",
          code: status.code,
          accountNumber: acct,
          locationCode,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok !== true) {
        setError(REASON_COPY[data.reason ?? ""] ?? REASON_COPY.storage);
        return;
      }
      setDone({
        bonusTokens: data.credited?.bonusTokens ?? 0,
        balance: data.balance,
        pending: data.pending,
      });
    } catch {
      setError(REASON_COPY.storage);
    } finally {
      setBusy(false);
    }
  };

  return (
    // Renders INSIDE the brand chrome (fixed nav + dark site bg). Mirror the
    // /reload idiom: a fixed dark backdrop so contrast is ours, top padding to
    // clear the fixed nav, white-on-dark card. (Light-on-dark was the bug —
    // invisible under the real chrome.)
    <>
      <div className="fixed inset-0 -z-10 bg-[#00041b]" aria-hidden="true" />
      <main className="mx-auto flex min-h-screen max-w-md flex-col px-5 pb-16 pt-32 text-white sm:pt-36">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-white/45">
          Game Zone voucher
        </p>
        <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.06] px-5 py-4 font-mono text-2xl tracking-[0.12em] text-white">
          {formatVoucherCode(status.code)}
        </div>

        {/* What's on it, line by line. */}
        <ul className="mt-6 space-y-2">
          {status.items.map((i) => (
            <li key={i.index} className="flex items-center justify-between gap-3 text-lg">
              <span className={i.spent ? "text-white/35 line-through" : "text-white"}>
                {i.label}
              </span>
              <span className="shrink-0 text-sm text-white/50">
                {i.spent ? "used" : i.redeemable ? "ready" : "at Guest Services"}
              </span>
            </li>
          ))}
        </ul>

        {done ? (
          <div className="mt-8 rounded-2xl border-2 border-[#46d68c]/40 bg-[#46d68c]/[0.1] p-5">
            <p className="text-xl font-bold text-[#46d68c]">
              {done.pending ? "On its way" : "Loaded!"}
            </p>
            <p className="mt-1 text-white/80">
              {done.bonusTokens} bonus tokens{" "}
              {done.pending
                ? "are being added to your card — it can take a few minutes to reach the floor."
                : "are on your card."}
            </p>
            {done.balance && (
              <p className="mt-2 text-sm text-white/55">
                New balance: {done.balance.tokens} tokens + {done.balance.bonusTokens} bonus
              </p>
            )}
          </div>
        ) : voided ? (
          <p className="mt-8 text-lg text-white/70">{REASON_COPY.voided}</p>
        ) : expired ? (
          <p className="mt-8 text-lg text-white/70">{REASON_COPY.expired}</p>
        ) : redeemable.length === 0 ? (
          <div className="mt-8">
            <p className="text-lg text-white/70">
              {alreadySpent.length > 0 && notHere.length === 0
                ? REASON_COPY.used
                : REASON_COPY.not_redeemable}
            </p>
          </div>
        ) : (
          <>
            <h1 className="mt-8 text-2xl font-extrabold text-white">Load it on your card</h1>
            <p className="mt-1 text-white/60">
              Enter the number printed on the back of your game card.
            </p>

            <label className="mt-5 block text-sm font-semibold text-white/70" htmlFor="v-acct">
              Card number
            </label>
            <input
              id="v-acct"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={account}
              onChange={(e) => {
                setError(null);
                // Card numbers are digits only and stay STRINGS end to end
                // (Intercard accounts exceed float-safe range upstream).
                setAccount(e.target.value.replace(/\D/g, ""));
              }}
              placeholder="1063464"
              className="mt-1 w-full rounded-xl border-2 border-white/15 bg-[#040d24] px-4 py-3 font-mono text-xl text-white placeholder:text-white/30 focus:border-[#00e2e5] focus:outline-none"
            />

            <label className="mt-4 block text-sm font-semibold text-white/70" htmlFor="v-loc">
              Where do you play?
            </label>
            <select
              id="v-loc"
              value={locationCode}
              onChange={(e) => setLocationCode(Number(e.target.value))}
              className="mt-1 w-full rounded-xl border-2 border-white/15 bg-[#040d24] px-4 py-3 text-lg text-white focus:border-[#00e2e5] focus:outline-none"
            >
              {CENTER_LIST.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>

            <div
              className="mt-3 min-h-[24px] text-sm text-[#ff8c7a]"
              role="alert"
              aria-live="polite"
            >
              {error ?? ""}
            </div>

            <button
              type="button"
              onClick={submit}
              disabled={!account.trim() || busy}
              className="mt-2 w-full rounded-full bg-[#00e2e5] px-6 py-4 text-lg font-bold text-[#04252b] disabled:opacity-40"
            >
              {busy ? "Loading…" : "Load my card"}
            </button>

            <p className="mt-6 text-sm text-white/45">
              No game card yet? Scan this code at any kiosk and one comes out, already
              loaded.
            </p>
          </>
        )}
      </main>
    </>
  );
}
