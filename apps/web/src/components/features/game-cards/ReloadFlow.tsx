"use client";

/**
 * Public card-reload flow. Fast path: QR (`?id=`) → prefilled + auto-verified →
 * pick location → pick package → one-tap wallet / card / gift card → done.
 *
 * Payment is modeled on the booking checkout step: PaymentForm in onTokenize
 * mode (charge + Intercard load happen in ONE server round-trip — the
 * post-orphan-charge best practice; nothing is charged client-side).
 */

import { useEffect, useMemo, useState } from "react";
import PaymentForm from "@/components/square/PaymentForm";
import Button from "~/components/ui/Button";
import Card from "~/components/ui/Card";
import Input from "~/components/ui/Input";
import Spinner from "~/components/ui/Spinner";
import ErrorBox from "~/components/ui/ErrorBox";
import { CENTER_LIST, type CenterConfig } from "~/config/intercard-centers";
import { TOKEN_PACKAGES, type TokenPackage } from "~/features/game-cards";
import { useCardBalance, usePurchase } from "~/features/game-cards";
import type { CardBalance, PurchaseResult } from "~/features/game-cards";

const LOC_STORAGE_KEY = "gc-last-location";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/** Digits only, leading zeros dropped — the printed number often shows them but they aren't part of the account. */
function normalizeCard(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  return digits;
}

function BalanceRow({ balance }: { balance: CardBalance }) {
  const cells = [
    { label: "Tokens", value: balance.tokens },
    { label: "Bonus", value: balance.bonusTokens },
    { label: "Time (min)", value: balance.timeMinutes },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {cells.map((c) => (
        <div key={c.label} className="rounded-lg bg-white/[0.04] px-3 py-2 text-center">
          <div className="text-lg font-semibold text-white">{c.value.toLocaleString()}</div>
          <div className="text-xs text-white/50">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

export default function ReloadFlow({ initialCardId }: { initialCardId?: string }) {
  const initial = initialCardId ? normalizeCard(initialCardId) : "";
  const [accountNumber, setAccountNumber] = useState(initial);
  const [entry, setEntry] = useState(initial);
  const [center, setCenter] = useState<CenterConfig | null>(null);
  const [pkg, setPkg] = useState<TokenPackage | null>(null);
  const [email, setEmail] = useState("");
  const [payError, setPayError] = useState<string | null>(null);
  const [result, setResult] = useState<PurchaseResult | null>(null);

  const verify = useCardBalance(accountNumber, center?.code, accountNumber.length > 0);
  const purchase = usePurchase();

  // Remember the last-picked location for returning guests.
  useEffect(() => {
    if (center) {
      try {
        window.localStorage.setItem(LOC_STORAGE_KEY, String(center.code));
      } catch {
        /* ignore */
      }
    }
  }, [center]);
  useEffect(() => {
    if (center) return;
    try {
      const saved = Number(window.localStorage.getItem(LOC_STORAGE_KEY));
      const found = CENTER_LIST.find((c) => c.code === saved);
      if (found) setCenter(found);
    } catch {
      /* ignore */
    }
  }, [center]);

  const verified = verify.data?.exists === true;
  const balance = verify.data?.balance;

  // ── Success screen ──────────────────────────────────────────────────────
  if (result) {
    return (
      <Card className="mx-auto max-w-md space-y-4 p-6">
        <h1 className="text-xl font-semibold text-white">
          {result.loaded ? "Tokens added!" : "Payment received"}
        </h1>
        <p className="text-sm text-white/70">
          {result.loaded
            ? `${pkg?.label} added to card ${accountNumber}.`
            : "Your payment went through. Your tokens will appear on the card shortly — no need to pay again."}
        </p>
        {result.balance && (
          <div className="space-y-1">
            <div className="text-xs uppercase tracking-wide text-white/40">New balance</div>
            <BalanceRow balance={result.balance} />
          </div>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            setResult(null);
            setPkg(null);
            setPayError(null);
            void verify.refetch();
          }}
        >
          Reload again
        </Button>
      </Card>
    );
  }

  // ── Identify (enter card number) — skipped when the QR provided one ──────
  if (!accountNumber || (!verify.isFetching && verify.data && !verified)) {
    return (
      <Card className="mx-auto max-w-md space-y-4 p-6">
        <h1 className="text-xl font-semibold text-white">Reload your game card</h1>
        <p className="text-sm text-white/70">
          Enter the number printed <span className="text-white">under the barcode</span> on your
          card — not the QR code. Leading zeros aren&apos;t needed.
        </p>
        <Input
          label="Card number"
          inputMode="numeric"
          value={entry}
          onChange={(e) => setEntry(e.target.value.replace(/\D/g, ""))}
          error={verify.data && !verified ? "We couldn't find that card number." : undefined}
        />
        <Button
          onClick={() => setAccountNumber(normalizeCard(entry))}
          disabled={normalizeCard(entry).length === 0}
          loading={verify.isFetching}
        >
          Look up card
        </Button>
        <p className="text-center text-xs text-white/50">
          Tip: scan the QR code on your card with your phone for a faster reload.
        </p>
      </Card>
    );
  }

  // ── Verifying ─────────────────────────────────────────────────────────────
  if (verify.isFetching && !verify.data) {
    return (
      <div className="flex min-h-60 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (verify.isError) {
    return (
      <Card className="mx-auto max-w-md space-y-4 p-6">
        <ErrorBox>
          {verify.error instanceof Error
            ? verify.error.message
            : "We couldn't check that card right now."}
        </ErrorBox>
        <Button variant="secondary" onClick={() => verify.refetch()}>
          Try again
        </Button>
      </Card>
    );
  }

  const cardHeader = (
    <Card className="space-y-2 p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-white/60">Card {accountNumber}</div>
        <button
          className="text-xs text-white/40 underline"
          onClick={() => {
            setAccountNumber("");
            setEntry("");
          }}
        >
          Change
        </button>
      </div>
      {balance && <BalanceRow balance={balance} />}
    </Card>
  );

  // ── Pick location ──────────────────────────────────────────────────────────
  if (!center) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        {cardHeader}
        <Card className="space-y-3 p-6">
          <h2 className="text-lg font-semibold text-white">Which location?</h2>
          <div className="grid gap-2">
            {CENTER_LIST.map((c) => (
              <Button key={c.code} variant="secondary" onClick={() => setCenter(c)}>
                {c.label}
              </Button>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  // ── Pick package ────────────────────────────────────────────────────────────
  if (!pkg) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        {cardHeader}
        <Card className="space-y-3 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Add tokens</h2>
            <button className="text-xs text-white/40 underline" onClick={() => setCenter(null)}>
              {center.label}
            </button>
          </div>
          <div className="grid gap-2">
            {TOKEN_PACKAGES.map((p) => (
              <button
                key={p.id}
                onClick={() => setPkg(p)}
                className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition hover:border-white/30"
              >
                <span className="text-white">{p.label}</span>
                <span className="font-semibold text-[#00E2E5]">{dollars(p.priceCents)}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  // ── Pay ─────────────────────────────────────────────────────────────────────
  const handleTokenize = async ({
    cardNonce,
    savedCardId,
    giftCardNonce,
  }: {
    cardNonce: string | null;
    savedCardId: string | null;
    giftCardNonce: string | null;
  }) => {
    setPayError(null);
    try {
      const r = await purchase.mutateAsync({
        kind: "reload",
        locationCode: center.code,
        packageId: pkg.id,
        accountNumber,
        cardNonce: cardNonce ?? savedCardId ?? undefined,
        giftCardNonce: giftCardNonce ?? undefined,
        contact: email ? { email } : undefined,
      });
      setResult(r);
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "Payment failed. Please try again.");
      throw err; // let PaymentForm reset its button
    }
  };

  return (
    <div className="mx-auto max-w-md space-y-4">
      {cardHeader}
      <Card className="space-y-4 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{pkg.label}</h2>
          <button className="text-xs text-white/40 underline" onClick={() => setPkg(null)}>
            Change
          </button>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-white/60">{center.label}</span>
          <span className="text-lg font-semibold text-white">{dollars(pkg.priceCents)}</span>
        </div>
        <Input
          label="Email for receipt (optional)"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {payError && <ErrorBox>{payError}</ErrorBox>}
        <PaymentForm
          amount={pkg.priceCents / 100}
          itemName={pkg.label}
          billId={accountNumber}
          contact={{ firstName: "", lastName: "", email, phone: "" }}
          locationId={center.paymentFormKey}
          onTokenize={handleTokenize}
          onSuccess={() => {}}
          onError={(msg) => setPayError(msg)}
          onCancel={() => setPkg(null)}
        />
      </Card>
    </div>
  );
}
