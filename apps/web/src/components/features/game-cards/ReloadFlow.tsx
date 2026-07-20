"use client";

/**
 * Public card-reload flow (cart of 1..10 cards, one payment).
 *
 * UX: card lookup (QR ?id prefilled + auto-verified) → shows balances +
 * expandable recent activity → "Reload Card" CTA → pick location → pick
 * package → cart (add more cards) → one payment (Apple/Google Pay, card, or
 * gift card) → per-card result. Payment is modeled on the booking checkout
 * step: PaymentForm in onTokenize mode (charge + Intercard load in one server
 * round-trip). Full-bleed Game Zone background.
 */

import { useState } from "react";
import PaymentForm from "@/components/square/PaymentForm";
import Button from "~/components/ui/Button";
import Card from "~/components/ui/Card";
import Input from "~/components/ui/Input";
import Spinner from "~/components/ui/Spinner";
import ErrorBox from "~/components/ui/ErrorBox";
import Modal from "~/components/ui/Modal";
import { CENTER_LIST, type CenterConfig } from "~/config/intercard-centers";
import { TOKEN_PACKAGES, type TokenPackage } from "~/features/game-cards";
import { useCardBalance, usePurchase } from "~/features/game-cards";
import type { CardBalance, CardTxn, PurchaseResult } from "~/features/game-cards";
import { normalizeCard } from "~/features/game-cards/normalize";
import { useGameCardAccount } from "~/features/game-cards/account-hooks";
import AccountPanel from "./AccountPanel";

const GAME_ZONE_BG =
  "https://wuce3at4k1appcmf.public.blob.vercel-storage.com/images/headpinz/gallery-arcade.webp";

type Phase = "lookup" | "location" | "package" | "cart" | "pay";

interface CartLine {
  accountNumber: string;
  pkg: TokenPackage;
  balance?: CardBalance;
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function GameZoneBackground() {
  return (
    <div className="fixed inset-0 -z-10" aria-hidden="true">
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${GAME_ZONE_BG})` }}
      />
      <div className="absolute inset-0 bg-[#00041b]/85" />
    </div>
  );
}

function BalanceRow({ balance }: { balance: CardBalance }) {
  const cells = [
    { label: "Tokens", value: balance.tokens },
    { label: "Bonus", value: balance.bonusTokens },
    { label: "eTickets", value: balance.eTickets },
    { label: "Time (min)", value: balance.timeMinutes },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="rounded-lg bg-white/[0.04] px-3 py-2 text-center">
          <div className="text-lg font-semibold text-white">{c.value.toLocaleString()}</div>
          <div className="text-xs text-white/50">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

const SYNC_NOTE =
  "Balances sync from the game system and may take a few minutes to reflect recent play or reloads.";

function RecentActivity({ transactions }: { transactions: CardTxn[] }) {
  const [open, setOpen] = useState(false);
  if (!transactions.length) return null;
  return (
    <div className="border-t border-white/10 pt-3">
      <button
        className="flex w-full items-center justify-between text-sm text-white/70"
        onClick={() => setOpen(true)}
      >
        <span>Recent activity</span>
        <span className="text-white/40">View →</span>
      </button>
      {open && (
        <Modal title="Recent activity" onClose={() => setOpen(false)}>
          <ul className="space-y-1">
            {transactions.map((t, i) => {
              const tok = t.tokens || t.bonusTokens;
              const detail = tok
                ? `${tok > 0 ? "+" : ""}${tok} tokens`
                : t.points
                  ? `${t.points > 0 ? "+" : ""}${t.points} eTickets`
                  : "";
              const when = t.timeStamp ? t.timeStamp.slice(0, 16) : "";
              return (
                <li
                  key={i}
                  className="flex items-start justify-between gap-3 rounded bg-white/[0.03] px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <div className="text-white/80">
                      {t.transType || "Activity"}
                      {t.device ? ` · ${t.device}` : ""}
                    </div>
                    <div className="text-xs text-white/40">
                      {t.location || "—"}
                      {when ? ` · ${when}` : ""}
                    </div>
                  </div>
                  <span className="shrink-0 text-white/60">{detail}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[11px] leading-snug text-white/40">{SYNC_NOTE}</p>
        </Modal>
      )}
    </div>
  );
}

export default function ReloadFlow({ initialCardId }: { initialCardId?: string }) {
  const initial = initialCardId ? normalizeCard(initialCardId) : "";
  const [phase, setPhase] = useState<Phase>("lookup");
  const [entry, setEntry] = useState(initial);
  const [lookupAccount, setLookupAccount] = useState(initial);
  const [center, setCenter] = useState<CenterConfig | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [email, setEmail] = useState("");
  const [payError, setPayError] = useState<string | null>(null);
  const [result, setResult] = useState<PurchaseResult | null>(null);

  const [queue, setQueue] = useState<string[]>([]);

  const account = useGameCardAccount();
  const verify = useCardBalance(lookupAccount, center?.code, phase === "lookup" && !!lookupAccount);
  const purchase = usePurchase();

  // Reload one or more saved game cards from the account panel: seed a queue,
  // confirm the location, then assign a package to each into the cart. The
  // saved cards' home center pre-selects in the picker, but the guest ALWAYS
  // confirms — tokens load onto the chosen center's system right away, so
  // "where are you NOW" beats "where was this card used before".
  const reloadSavedCards = (accountNumbers: string[], locationCode: number | null) => {
    if (accountNumbers.length === 0) return;
    setCart([]);
    setQueue(accountNumbers);
    const c =
      locationCode != null ? (CENTER_LIST.find((x) => x.code === locationCode) ?? null) : null;
    setCenter(c);
    setPhase("location");
  };
  const accountPanel = <AccountPanel account={account} onReloadCards={reloadSavedCards} />;

  const verifiedCard = verify.data?.exists ? verify.data : null;
  const totalCents = cart.reduce((s, l) => s + l.pkg.priceCents, 0);

  // ── Success ────────────────────────────────────────────────────────────
  if (result) {
    return (
      <>
        <GameZoneBackground />
        <Card className="mx-auto max-w-md space-y-4 p-6 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
          <h1 className="text-xl font-semibold text-white">
            {result.anyPending ? "Payment received" : "Tokens added!"}
          </h1>
          <div className="space-y-3">
            {result.results.map((r) => (
              <div key={r.accountNumber} className="space-y-2 rounded-lg bg-white/[0.04] px-3 py-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white/70">Card {r.accountNumber}</span>
                  <span className={r.loaded ? "text-[#00E2E5]" : "text-amber-300"}>
                    {r.loaded
                      ? `+${r.tokens}${r.bonusTokens ? ` +${r.bonusTokens} bonus` : ""} tokens`
                      : "Credit pending"}
                  </span>
                </div>
                {r.balance && (
                  <div>
                    <div className="mb-1 text-[10px] uppercase tracking-wide text-white/40">
                      New balance
                    </div>
                    <BalanceRow balance={r.balance} />
                  </div>
                )}
                {r.transactions && r.transactions.length > 0 && (
                  <RecentActivity transactions={r.transactions} />
                )}
              </div>
            ))}
          </div>
          <p className="text-[11px] leading-snug text-white/40">
            Card balances sync from the game system — a reload can take a few minutes to appear on
            your card and at the games.
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              setResult(null);
              setCart([]);
              setPayError(null);
              setPhase("lookup");
              setLookupAccount("");
              setEntry("");
            }}
          >
            Reload another card
          </Button>
        </Card>
      </>
    );
  }

  const shell = (children: React.ReactNode) => (
    <>
      <GameZoneBackground />
      <div className="mx-auto max-w-md space-y-4">{children}</div>
    </>
  );

  // ── Lookup (enter/scan card, verify, show balances + Reload CTA) ─────────
  if (phase === "lookup") {
    if (verify.isFetching && !verify.data) {
      return shell(
        <div className="flex min-h-60 items-center justify-center">
          <Spinner />
        </div>,
      );
    }
    if (verifiedCard) {
      return shell(
        <Card className="space-y-4 p-6 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-white">Your Game Card</h1>
              <p className="text-sm text-white/60">
                Card {verifiedCard.accountNumber} · current balance
              </p>
            </div>
            <button
              onClick={() => verify.refetch()}
              disabled={verify.isFetching}
              className="shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-[#00E2E5] transition hover:border-white/30 disabled:opacity-50"
            >
              {verify.isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {verifiedCard.balance && <BalanceRow balance={verifiedCard.balance} />}
          <p className="text-[11px] leading-snug text-white/40">{SYNC_NOTE}</p>
          {verifiedCard.transactions && <RecentActivity transactions={verifiedCard.transactions} />}
          <Button onClick={() => setPhase("location")}>Reload Card</Button>
          <button
            className="w-full text-center text-xs text-white/40 underline"
            onClick={() => {
              setLookupAccount("");
              setEntry("");
            }}
          >
            Use a different card
          </button>
        </Card>,
      );
    }
    // No verified card yet → account panel + entry form.
    return shell(
      <>
        {accountPanel}
        <Card className="space-y-4 p-6 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
          <h1 className="text-xl font-semibold text-white">Check Balance or Reload</h1>
          <p className="text-sm text-white/70">
            Enter the number printed <span className="text-white">under the barcode</span> on your
            card — not the QR code. Leading zeros aren&apos;t needed.
          </p>
          <Input
            label="Card number"
            inputMode="numeric"
            value={entry}
            onChange={(e) => setEntry(e.target.value.replace(/\D/g, ""))}
            error={verify.data && !verifiedCard ? "We couldn't find that card number." : undefined}
          />
          <Button
            onClick={() => setLookupAccount(normalizeCard(entry))}
            disabled={normalizeCard(entry).length === 0}
            loading={verify.isFetching}
          >
            Look up card
          </Button>
          <p className="text-center text-xs text-white/50">
            Tip: scan the QR code on your card with your phone for a faster reload.
          </p>
        </Card>
      </>,
    );
  }

  // ── Location (always confirmed — tokens load onto that center's system) ──
  if (phase === "location") {
    return shell(
      <Card className="space-y-3 p-6 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
        <h2 className="text-lg font-semibold text-white">Which center are you at?</h2>
        <p className="text-sm text-white/60">
          Tokens load onto that center&apos;s system right away — confirm where you are.
        </p>
        <div className="grid gap-2">
          {CENTER_LIST.map((c) => (
            <Button
              key={c.code}
              variant={center?.code === c.code ? "primary" : "secondary"}
              onClick={() => {
                setCenter(c);
                setPhase("package");
              }}
            >
              {c.label}
            </Button>
          ))}
        </div>
      </Card>,
    );
  }

  // ── Package (for the card currently being added; may be one of a queue) ──
  if (phase === "package") {
    const target = queue[0] ?? lookupAccount;
    const queuedTotal = queue.length + cart.length;
    return shell(
      <Card className="space-y-3 p-6 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Add tokens</h2>
          <span className="text-xs text-white/50">
            Card {target}
            {queue.length > 1 ? ` · ${cart.length + 1} of ${queuedTotal}` : ""}
          </span>
        </div>
        <div className="grid gap-2">
          {TOKEN_PACKAGES.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                const fromQueue = queue.length > 0;
                setCart((c) => [
                  ...c,
                  {
                    accountNumber: target,
                    pkg: p,
                    balance: fromQueue ? undefined : verifiedCard?.balance,
                  },
                ]);
                if (fromQueue) {
                  const rest = queue.slice(1);
                  setQueue(rest);
                  setPhase(rest.length ? "package" : "cart");
                } else {
                  setPhase("cart");
                }
              }}
              className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left transition hover:border-white/30"
            >
              <span className="text-white">{p.label}</span>
              <span className="font-semibold text-[#00E2E5]">{dollars(p.priceCents)}</span>
            </button>
          ))}
        </div>
      </Card>,
    );
  }

  // ── Cart (review, add more cards, pay) ───────────────────────────────────
  if (phase === "cart") {
    return shell(
      <Card className="space-y-4 p-6 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
        <h2 className="text-lg font-semibold text-white">Your reload</h2>
        <div className="space-y-2">
          {cart.map((l, i) => (
            <div
              key={`${l.accountNumber}-${i}`}
              className="flex items-center justify-between rounded-lg bg-white/[0.04] px-3 py-2 text-sm"
            >
              <div>
                <div className="text-white">{l.pkg.label}</div>
                <div className="text-xs text-white/50">Card {l.accountNumber}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-white">{dollars(l.pkg.priceCents)}</span>
                <button
                  className="text-xs text-white/40 underline"
                  onClick={() => setCart((c) => c.filter((_, idx) => idx !== i))}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
        {cart.length < 10 && (
          <button
            className="w-full rounded-lg border border-dashed border-white/20 px-4 py-2 text-sm text-white/70 transition hover:border-white/40"
            onClick={() => {
              setLookupAccount("");
              setEntry("");
              setPhase("lookup");
            }}
          >
            + Add another card
          </button>
        )}
        <div className="flex items-center justify-between border-t border-white/10 pt-3">
          <span className="text-white/60">Total</span>
          <span className="text-lg font-semibold text-white">{dollars(totalCents)}</span>
        </div>
        <Button onClick={() => setPhase("pay")} disabled={cart.length === 0}>
          Pay {dollars(totalCents)}
        </Button>
        <p className="text-xs text-white/50">{center?.label}</p>
      </Card>,
    );
  }

  // ── Pay ───────────────────────────────────────────────────────────────────
  const handleTokenize = async ({
    cardNonce,
    savedCardId,
    giftCardNonce,
    saveCardConsent,
  }: {
    cardNonce: string | null;
    savedCardId: string | null;
    giftCardNonce: string | null;
    saveCardConsent: boolean;
  }) => {
    setPayError(null);
    try {
      const r = await purchase.mutateAsync({
        kind: "reload",
        locationCode: center!.code,
        items: cart.map((l) => ({ accountNumber: l.accountNumber, packageId: l.pkg.id })),
        cardNonce: cardNonce ?? savedCardId ?? undefined,
        giftCardNonce: giftCardNonce ?? undefined,
        contact: email ? { email } : undefined,
        // Signed-in extras: attribute + optionally vault + auto-link. The server
        // ignores squareCustomerId unless it belongs to the session.
        squareCustomerId: account.selectedCustomerId ?? undefined,
        saveCard: saveCardConsent,
      });
      setResult(r);
    } catch (err) {
      setPayError(err instanceof Error ? err.message : "Payment failed. Please try again.");
      throw err; // let PaymentForm reset its button
    }
  };

  return shell(
    <Card className="space-y-4 p-6 backdrop-blur-md !bg-[rgba(7,11,28,0.92)]">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">
          {cart.length === 1 ? "Reload" : `${cart.length} cards`}
        </h2>
        <button className="text-xs text-white/40 underline" onClick={() => setPhase("cart")}>
          Back
        </button>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-white/60">{center?.label}</span>
        <span className="text-lg font-semibold text-white">{dollars(totalCents)}</span>
      </div>
      <Input
        label="Email for receipt (optional)"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      {payError && <ErrorBox>{payError}</ErrorBox>}
      <PaymentForm
        amount={totalCents / 100}
        itemName={cart.length === 1 ? cart[0].pkg.label : `${cart.length}-card reload`}
        billId={cart[0]?.accountNumber ?? "reload"}
        contact={{ firstName: "", lastName: "", email, phone: "" }}
        locationId={center!.paymentFormKey}
        squareCustomerId={account.selectedCustomerId ?? undefined}
        savedCards={account.savedCards}
        allowSaveCard={!!account.selectedCustomerId}
        onTokenize={handleTokenize}
        onSuccess={() => {}}
        onError={(msg) => setPayError(msg)}
        onCancel={() => setPhase("cart")}
      />
    </Card>,
  );
}
