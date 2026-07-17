"use client";

/**
 * Kiosk Game Zone — MULTI-CARD token reload (owner ask 2026-07-18).
 *
 * Surfaces the existing, tested game-cards rail on the kiosk:
 *  - add 1–10 cards (type or SCAN the account number → /api/game-cards/verify
 *    shows the current balance), each with its own token package,
 *  - pay ONCE via the Square card iframe (manual entry; the reader path lands
 *    with the card-present smoke),
 *  - /api/game-cards/purchase charges once and loads every card via Intercard.
 *
 * No booking/deposit money rail here — it's the straightforward game-card
 * purchase path used by the public /reload page, so it's safe to reuse as-is.
 * New physical cards need a dispenser (owner decision pending) — this screen
 * is reload/add-value, which needs no dispenser.
 */
import { useState } from "react";
import PaymentForm from "@/components/square/PaymentForm";
import { TOKEN_PACKAGES } from "~/features/game-cards/constants";
import type { Brand, CenterCode } from "~/features/booking";
import { BrandedLoader } from "./BrandedLoader";

/** Intercard location code per venue (SWFLPassport map; load is account-global). */
function intercardLocationCode(center: CenterCode, brand: Brand): number {
  if (center === "naples") return 6; // HeadPinz Naples
  return brand === "headpinz" ? 9 : 11; // HeadPinz FM : FastTrax FM
}

interface CartCard {
  accountNumber: string;
  packageId: string;
  status: "unverified" | "verifying" | "ok" | "bad";
  balance?: { tokens: number; bonusTokens?: number };
  holderName?: string;
}

type Phase = "cart" | "paying" | "loading" | "done" | "error";

export function KioskGameZone({
  center,
  brand,
  onExit,
}: {
  center: CenterCode;
  brand: Brand;
  onExit: () => void;
}) {
  const [cards, setCards] = useState<CartCard[]>([
    { accountNumber: "", packageId: TOKEN_PACKAGES[1].id, status: "unverified" },
  ]);
  const [phase, setPhase] = useState<Phase>("cart");
  const [error, setError] = useState<string | null>(null);
  const locationCode = intercardLocationCode(center, brand);

  const totalCents = cards.reduce((sum, c) => {
    const pkg = TOKEN_PACKAGES.find((p) => p.id === c.packageId);
    return sum + (pkg?.priceCents ?? 0);
  }, 0);
  const allReady = cards.length > 0 && cards.every((c) => c.status === "ok" && c.packageId);

  const setCard = (i: number, patch: Partial<CartCard>) =>
    setCards((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  const verify = async (i: number) => {
    const acct = cards[i].accountNumber.trim();
    if (!acct) return;
    setCard(i, { status: "verifying" });
    try {
      const res = await fetch("/api/game-cards/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountNumber: acct, locationCode }),
      });
      const data = await res.json();
      if (res.ok && data.ok !== false && (data.balance || data.tokens != null)) {
        const bal = data.balance ?? data;
        setCard(i, {
          status: "ok",
          balance: { tokens: bal.tokens ?? 0, bonusTokens: bal.bonusTokens },
          holderName: bal.name ?? data.name,
        });
      } else {
        setCard(i, { status: "bad" });
      }
    } catch {
      setCard(i, { status: "bad" });
    }
  };

  const addCard = () =>
    setCards((cs) =>
      cs.length >= 10
        ? cs
        : [...cs, { accountNumber: "", packageId: TOKEN_PACKAGES[1].id, status: "unverified" }],
    );
  const removeCard = (i: number) => setCards((cs) => cs.filter((_, idx) => idx !== i));

  const pay = async (cardNonce: string) => {
    setPhase("loading");
    setError(null);
    try {
      const res = await fetch("/api/game-cards/purchase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "reload",
          locationCode,
          items: cards.map((c) => ({
            accountNumber: c.accountNumber.trim(),
            packageId: c.packageId,
          })),
          cardNonce,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setError(
          data.error?.message || data.message || "Reload failed. Please see the front desk.",
        );
        setPhase("error");
        return;
      }
      setPhase("done");
    } catch {
      setError("Reload failed. Please try again or see the front desk.");
      setPhase("error");
    }
  };

  if (phase === "loading") {
    return (
      <div className="flex h-full items-center justify-center py-16">
        <BrandedLoader
          brand={brand}
          label="Loading your tokens…"
          sublabel="Charging once, loading each card"
        />
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <div className="font-heading text-6xl font-extrabold italic">Tokens loaded!</div>
        <p className="mt-4 text-lg text-white/60">
          {cards.length === 1 ? "Your card is" : `All ${cards.length} cards are`} ready — tap in at
          the games.
        </p>
        <button
          type="button"
          onClick={onExit}
          className="font-heading mt-10 h-16 w-full rounded-full bg-[#00e2e5] text-xl font-extrabold uppercase italic text-[#04252b]"
        >
          Done
        </button>
      </div>
    );
  }

  if (phase === "paying") {
    return (
      <div className="mx-auto max-w-md py-8">
        <div className="mb-6 text-center">
          <div className="font-heading text-3xl font-extrabold italic">
            Pay ${(totalCents / 100).toFixed(2)}
          </div>
          <p className="mt-1 text-sm text-white/50">
            {cards.length} card{cards.length > 1 ? "s" : ""} · tokens load the moment payment clears
          </p>
        </div>
        <PaymentForm
          amount={totalCents / 100}
          itemName="Game Zone tokens"
          billId={`gz-${cards
            .map((c) => c.accountNumber.trim())
            .join("-")
            .slice(0, 40)}`}
          contact={{ firstName: "Game", lastName: "Zone", email: "", phone: "" }}
          locationId={
            center === "naples" ? "naples" : brand === "headpinz" ? "headpinz" : "fasttrax"
          }
          onTokenize={async ({ cardNonce }) => {
            if (cardNonce) await pay(cardNonce);
          }}
          onSuccess={() => {
            /* tokenize-only mode: the reload happens in onTokenize → pay() */
          }}
          onError={(m) => {
            setError(m);
            setPhase("error");
          }}
          onCancel={() => setPhase("cart")}
        />
        <button
          type="button"
          onClick={() => setPhase("cart")}
          className="mt-4 w-full rounded-xl border border-white/15 px-5 py-3 text-sm font-semibold text-white/60"
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-2 py-6">
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-heading text-4xl font-extrabold italic">Reload game cards</h1>
        <button
          type="button"
          onClick={onExit}
          className="rounded-full border border-white/15 px-5 py-2 text-sm text-white/60"
        >
          Cancel
        </button>
      </div>
      <p className="mb-5 text-white/55">
        Add each card and pick its token package — scan the barcode or type the number. One payment
        covers them all.
      </p>

      {error && phase === "error" && (
        <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-red-100">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {cards.map((c, i) => (
          <div key={i} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-heading text-lg font-extrabold italic">Card {i + 1}</span>
              {cards.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeCard(i)}
                  className="text-sm text-white/45"
                >
                  Remove
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="numeric"
                value={c.accountNumber}
                onChange={(e) =>
                  setCard(i, { accountNumber: e.target.value, status: "unverified" })
                }
                onBlur={() => c.accountNumber.trim() && c.status === "unverified" && verify(i)}
                placeholder="Card number (scan or type)"
                className="flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-lg text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => verify(i)}
                className="rounded-xl bg-[#00e2e5] px-5 py-2.5 text-sm font-bold text-[#04252b]"
              >
                {c.status === "verifying" ? "…" : "Check"}
              </button>
            </div>
            {c.status === "ok" && (
              <div className="mt-2 text-sm text-[#46d68c]">
                {c.holderName ? `${c.holderName} · ` : ""}balance {c.balance?.tokens ?? 0} tokens
              </div>
            )}
            {c.status === "bad" && (
              <div className="mt-2 text-sm text-red-300">Card not found — check the number.</div>
            )}
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {TOKEN_PACKAGES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setCard(i, { packageId: p.id })}
                  className={`rounded-xl border-2 px-3 py-3 text-center ${
                    c.packageId === p.id
                      ? "border-[#00e2e5] bg-[#00e2e5]/10 text-white"
                      : "border-white/10 bg-white/[0.02] text-white/60"
                  }`}
                >
                  <div className="font-heading text-xl font-extrabold tabular-nums">
                    {p.tokens}
                    {p.bonusTokens ? <span className="text-[#46d68c]"> +{p.bonusTokens}</span> : ""}
                  </div>
                  <div className="text-xs text-white/45">${(p.priceCents / 100).toFixed(0)}</div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {cards.length < 10 && (
        <button
          type="button"
          onClick={addCard}
          className="mt-4 w-full rounded-2xl border-2 border-dashed border-[#00e2e5]/40 px-5 py-4 font-bold text-[#00e2e5]"
        >
          + Add another card
        </button>
      )}

      <div className="mt-6 flex items-center justify-between rounded-2xl border border-[#00e2e5]/35 bg-white/[0.04] px-6 py-4">
        <div className="font-heading text-2xl font-extrabold tabular-nums">
          ${(totalCents / 100).toFixed(2)}
        </div>
        <button
          type="button"
          disabled={!allReady}
          onClick={() => setPhase("paying")}
          className="font-heading h-14 rounded-full bg-[#00e2e5] px-8 text-lg font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
        >
          Pay &amp; load
        </button>
      </div>
      {!allReady && (
        <p className="mt-2 text-center text-sm text-white/40">
          Check each card number to continue.
        </p>
      )}
    </div>
  );
}
