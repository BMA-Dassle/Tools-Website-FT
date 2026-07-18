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
 *
 * NEW cards (1–10 in one order) run through the same UX — pick a package per
 * card, pay, "dispense" — but the dispense is SIMULATED for now (owner
 * 2026-07-18): no physical card is ejected and no real charge/account is
 * created. Swap simDispense() for real create-account + purchase + hardware
 * dispense once the dispenser + Intercard new-account issuance are wired.
 */
import { useEffect, useRef, useState } from "react";
import PaymentForm from "@/components/square/PaymentForm";
import { KioskTerminalCheckoutGate } from "./KioskTerminalCheckoutGate";
import { kioskTerminalEnabled } from "~/features/kiosk/flags";
import { TOKEN_PACKAGES } from "~/features/game-cards/constants";
import { centerCodeFor } from "~/config/intercard-centers";
import type { Brand, CenterCode } from "~/features/booking";
import { useGameCardDispenser } from "../card-reader";
import { useKioskConfig } from "../KioskConfigContext";
import { BrandedLoader } from "./BrandedLoader";

interface CartCard {
  accountNumber: string;
  packageId: string;
  status: "unverified" | "verifying" | "ok" | "bad";
  balance?: { tokens: number; bonusTokens?: number };
  holderName?: string;
}

/**
 * A brand-new card being purchased. Its Intercard account is read off the
 * blank as it's dispensed (pre-encoded stock); tokens are loaded before the
 * card is presented. `txnId` ties it to the charged ledger row.
 */
interface NewCard {
  packageId: string;
  txnId?: string; // ledger row from the upfront charge
  account?: string; // read off the blank during dispense
  loaded?: boolean; // tokens confirmed loaded
  cardStatus?: "pending" | "dispensing" | "loaded" | "failed";
  balanceTokens?: number; // real balance after load
}

/** The game-cards API returns errors as `{ error: string, code }`. */
function errText(data: unknown): string | null {
  if (data && typeof data === "object") {
    const d = data as { error?: unknown; message?: unknown };
    if (typeof d.error === "string") return d.error;
    if (typeof d.message === "string") return d.message;
  }
  return null;
}

type Phase = "cart" | "paying" | "loading" | "done" | "error";
type Mode = "choose" | "reload" | "newcard";

/** Token-package tile body — labels the amount as TOKENS and calls out the free
 *  bonus clearly (owner ask 2026-07-18). Shared by the reload + new-card grids. */
function TokenTileBody({ p }: { p: (typeof TOKEN_PACKAGES)[number] }) {
  return (
    <>
      <div className="font-heading text-3xl font-extrabold leading-none tabular-nums">
        {p.tokens}
      </div>
      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/45">tokens</div>
      {p.bonusTokens ? (
        <div className="mt-1 text-base font-extrabold text-[#46d68c]">+{p.bonusTokens} free</div>
      ) : null}
      <div className="mt-1.5 text-sm text-white/55">${(p.priceCents / 100).toFixed(0)}</div>
    </>
  );
}

/** One-line package summary for a COLLAPSED card row (owner: minimize after pick). */
function pkgLabel(packageId: string): string {
  const p = TOKEN_PACKAGES.find((x) => x.id === packageId);
  if (!p) return "";
  return `${p.tokens} tokens${p.bonusTokens ? ` +${p.bonusTokens} free` : ""} · $${(p.priceCents / 100).toFixed(0)}`;
}

export function KioskGameZone({
  center,
  brand,
  capability = "full",
  onExit,
}: {
  center: CenterCode;
  brand: Brand;
  /** "full" = dispenser (buy + reload); "reload" = MSR reader only (reload, no
   *  new-card dispense). Owner 2026-07-19. */
  capability?: "full" | "reload";
  onExit: () => void;
}) {
  // Reload-only kiosks skip the buy/reload chooser and land straight on reload.
  const [mode, setMode] = useState<Mode>(capability === "reload" ? "reload" : "choose");
  const [cards, setCards] = useState<CartCard[]>([
    { accountNumber: "", packageId: TOKEN_PACKAGES[1].id, status: "unverified" },
  ]);
  const [phase, setPhase] = useState<Phase>("cart");
  const [error, setError] = useState<string | null>(null);
  // New-card cart: 1–10 fresh cards, each with its own package. Accounts are
  // read off each blank as it's dispensed (see the buy dispense loop).
  const [newCards, setNewCards] = useState<NewCard[]>([{ packageId: TOKEN_PACKAGES[1].id }]);
  // Which card is EXPANDED (showing the package grid); the rest collapse to a
  // one-line summary + Edit so more cards fit on screen (owner ask 2026-07-18).
  const [newEditIdx, setNewEditIdx] = useState<number | null>(0);
  const [reloadEditIdx, setReloadEditIdx] = useState<number | null>(0);
  const [dispenseMsg, setDispenseMsg] = useState<string | null>(null);
  const locationCode = centerCodeFor(center, brand);

  // The CRT-591 dispenser owns ONE connection for the whole Game Zone session
  // (this component stays mounted until the guest exits). Auto-reconnects
  // silently on a provisioned kiosk.
  const { config } = useKioskConfig();
  const dispenser = useGameCardDispenser({ config });
  const readerReady = dispenser.ready;

  // When leaving reload, stop the gate from accepting more cards.
  useEffect(() => {
    if (mode !== "reload") return;
    return () => {
      if (dispenser.ready) void dispenser.stopAccepting();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const totalCents = cards.reduce((sum, c) => {
    const pkg = TOKEN_PACKAGES.find((p) => p.id === c.packageId);
    return sum + (pkg?.priceCents ?? 0);
  }, 0);
  const allReady = cards.length > 0 && cards.every((c) => c.status === "ok" && c.packageId);

  const newTotalCents = newCards.reduce((sum, c) => {
    const pkg = TOKEN_PACKAGES.find((p) => p.id === c.packageId);
    return sum + (pkg?.priceCents ?? 0);
  }, 0);
  const setNewCard = (i: number, patch: Partial<NewCard>) =>
    setNewCards((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addNewCard = () =>
    setNewCards((cs) => (cs.length >= 10 ? cs : [...cs, { packageId: TOKEN_PACKAGES[1].id }]));
  const removeNewCard = (i: number) => setNewCards((cs) => cs.filter((_, idx) => idx !== i));

  const setCard = (i: number, patch: Partial<CartCard>) =>
    setCards((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  const verify = async (i: number, acctOverride?: string) => {
    const acct = (acctOverride ?? cards[i].accountNumber).trim();
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

  const newTokensTotal = newCards.reduce((sum, c) => {
    const pkg = TOKEN_PACKAGES.find((p) => p.id === c.packageId);
    return sum + (pkg ? pkg.tokens + (pkg.bonusTokens || 0) : 0);
  }, 0);
  const setNewCardAt = (i: number, patch: Partial<NewCard>) =>
    setNewCards((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  // RELOAD read: insert a card → the reader reads its account and returns it
  // (always — never captures a guest's card), then we verify to show balance.
  const readReloadCard = async (i: number) => {
    const acct = await dispenser.acceptAndRead({ timeoutMs: 30_000 });
    await dispenser.present(); // ALWAYS hand the card back
    if (!acct) return; // read failed — dispenser.error shows why
    setCard(i, { accountNumber: acct, status: "unverified" });
    await verify(i, acct);
  };

  // BUY: one upfront charge for the basket, THEN dispense + load + present each
  // card one at a time (load must clear before a card is handed over).
  const payNewCards = async (cardNonce: string) => {
    setPhase("loading");
    setError(null);
    setDispenseMsg("Processing payment…");
    try {
      const res = await fetch("/api/game-cards/purchase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "new_card",
          locationCode,
          items: newCards.map((c) => ({ packageId: c.packageId })),
          cardNonce,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false || !Array.isArray(data.rows)) {
        setError(errText(data) || "Payment failed. Please see the front desk.");
        setPhase("error");
        return;
      }
      // Seed each card with its charged ledger row, then dispense sequentially.
      setNewCards((cs) =>
        cs.map((c, i) => ({ ...c, txnId: data.rows[i]?.txnId, cardStatus: "pending" as const })),
      );
      await dispenseNewCards(data.groupId, data.rows);
    } catch {
      setError("Payment failed. Please try again or see the front desk.");
      setPhase("error");
    }
  };

  // Dispense → read → load → present, ONE card at a time. A load that fails
  // captures the blank (never hand over an empty card); the row stays pending.
  const dispenseNewCards = async (groupId: string, rows: Array<{ txnId: string }>) => {
    for (let i = 0; i < newCards.length; i++) {
      const txnId = rows[i]?.txnId;
      if (!txnId) break;
      setNewCardAt(i, { cardStatus: "dispensing" });
      setDispenseMsg(`Dispensing card ${i + 1} of ${newCards.length}…`);

      const account = await dispenser.dispenseAndRead();
      if (!account) {
        // Jam / empty stacker / read fail — stop; charged-but-undispensed rows
        // stay pending (staff resolves). Never auto-refund.
        setNewCardAt(i, { cardStatus: "failed" });
        setError(
          dispenser.error?.message ??
            "We couldn't dispense a card. Your payment is safe — please see an attendant.",
        );
        setPhase("error");
        return;
      }

      setDispenseMsg(`Loading tokens onto card ${i + 1}…`);
      let loaded = false;
      let balanceTokens: number | undefined;
      try {
        const res = await fetch("/api/game-cards/load-card", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ groupId, txnId, accountNumber: account, locationCode }),
        });
        const data = await res.json();
        loaded = res.ok && data.loaded === true;
        balanceTokens = data.balance?.tokens;
      } catch {
        loaded = false;
      }

      if (loaded) {
        setNewCardAt(i, { account, loaded: true, cardStatus: "loaded", balanceTokens });
        setDispenseMsg(`Take card ${i + 1}…`);
        await dispenser.present();
        await dispenser.waitTaken({ timeoutMs: 30_000 });
      } else {
        // Don't hand over an unloaded blank — bin it; row recovers forward.
        setNewCardAt(i, { account, loaded: false, cardStatus: "failed" });
        await dispenser.capture();
        setError(
          "A card couldn't be loaded and was retained. Your payment is safe — please see an attendant.",
        );
        setPhase("error");
        return;
      }
    }
    setDispenseMsg(null);
    setPhase("done");
  };

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
        setError(errText(data) || "Reload failed. Please see the front desk.");
        setPhase("error");
        return;
      }
      setPhase("done");
    } catch {
      setError("Reload failed. Please try again or see the front desk.");
      setPhase("error");
    }
  };

  // ── Kiosk direct-Terminal (Square reader) rail ──
  // Mirrors pay()/payNewCards() but the reader charges OUR prepared order (no card
  // token). PREPARE persists the ledger rows + creates the order; the gate charges
  // it on the reader; FINALIZE verifies the payment + loads (reload) / hands rows
  // back to dispense (new_card). readerPrep holds PREPARE's rows for FINALIZE.
  const readerPrep = useRef<{
    groupId: string;
    orderId: string;
    totalCents: number;
    rows: Array<{ txnId: string }>;
  } | null>(null);

  const readerPrepare = async (kind: "reload" | "new_card") => {
    const items =
      kind === "new_card"
        ? newCards.map((c) => ({ packageId: c.packageId }))
        : cards.map((c) => ({ accountNumber: c.accountNumber.trim(), packageId: c.packageId }));
    const res = await fetch("/api/game-cards/terminal-prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, locationCode, items }),
    });
    const data = await res.json();
    if (!res.ok || !data.orderId || !(data.totalCents > 0)) {
      throw new Error(errText(data) || "Couldn't start the reader payment.");
    }
    readerPrep.current = data;
    return { seed: data.groupId, depositOrderId: data.orderId, depositCents: data.totalCents };
  };

  const readerFinalize = async (
    kind: "reload" | "new_card",
    ep: { paymentId: string; depositOrderId: string; amountCents: number },
  ) => {
    const prep = readerPrep.current;
    if (!prep) {
      setError("Payment session expired. Please see the front desk.");
      setPhase("error");
      return;
    }
    setPhase("loading");
    setError(null);
    try {
      const res = await fetch("/api/game-cards/terminal-finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          locationCode,
          groupId: prep.groupId,
          txnIds: prep.rows.map((r) => r.txnId),
          externalPayment: {
            paymentId: ep.paymentId,
            orderId: ep.depositOrderId,
            amountCents: ep.amountCents,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        // Money is ALREADY captured on the reader — never imply "pay again".
        setError(
          errText(data) ||
            "We received your payment but couldn't finish — please see the front desk (do not pay again).",
        );
        setPhase("error");
        return;
      }
      if (kind === "new_card") {
        setNewCards((cs) =>
          cs.map((c, i) => ({
            ...c,
            txnId: data.rows?.[i]?.txnId,
            cardStatus: "pending" as const,
          })),
        );
        await dispenseNewCards(data.groupId, data.rows ?? []);
      } else {
        setPhase("done");
      }
    } catch {
      setError(
        "We received your payment but couldn't finish — please see the front desk (do not pay again).",
      );
      setPhase("error");
    }
  };

  // ── Mode chooser: New card vs Reload ──
  if (mode === "choose") {
    return (
      <div className="w-full">
        <div className="mb-[32px] flex items-center justify-between">
          <h1 className="k-display text-[74px]">Game Zone cards</h1>
          <button
            type="button"
            onClick={onExit}
            className="rounded-full border border-white/15 px-[28px] py-[12px] text-[24px] text-white/60"
          >
            Cancel
          </button>
        </div>
        <div className="grid gap-[24px]">
          <button
            type="button"
            onClick={() => setMode("newcard")}
            className="k-glass k-tap p-[40px] text-left"
            style={{ borderLeft: "8px solid #f800c6" }}
          >
            <div className="k-display text-[48px]">New Game Zone cards</div>
            <div className="mt-[10px] text-[28px] text-white/55">
              Set up 1–10 fresh cards — pick a token package for each
            </div>
          </button>
          <button
            type="button"
            onClick={() => setMode("reload")}
            className="k-glass k-tap p-[40px] text-left"
            style={{ borderLeft: "8px solid #00e2e5" }}
          >
            <div className="k-display text-[48px]">Reload existing cards</div>
            <div className="mt-[10px] text-[28px] text-white/55">
              Add tokens to 1–10 cards you already have
            </div>
          </button>
        </div>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div className="flex h-full items-center justify-center py-16">
        <BrandedLoader
          brand={brand}
          label={
            mode === "newcard"
              ? newCards.length > 1
                ? "Setting up your cards…"
                : "Setting up your card…"
              : "Loading your tokens…"
          }
          sublabel={
            mode === "newcard"
              ? (dispenseMsg ?? "Dispensing your cards")
              : "Charging once, loading each card"
          }
        />
      </div>
    );
  }

  if (phase === "done") {
    // New-card success: each dispensed card with its loaded token balance.
    if (mode === "newcard") {
      return (
        <div className="mx-auto max-w-md py-12 text-center kiosk-zoom">
          <div className="font-heading text-6xl font-extrabold italic">
            {newCards.length === 1 ? "Card ready!" : "Cards ready!"}
          </div>
          <p className="mt-4 text-lg text-white/60">
            {newTokensTotal} tokens across {newCards.length} card
            {newCards.length > 1 ? "s" : ""}.
          </p>
          <div className="mt-6 space-y-3 text-left">
            {newCards.map((c, i) => {
              const pkg = TOKEN_PACKAGES.find((p) => p.id === c.packageId);
              const toks = c.balanceTokens ?? (pkg ? pkg.tokens + (pkg.bonusTokens || 0) : 0);
              return (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-2xl border border-white/15 bg-white/[0.04] px-6 py-4"
                >
                  <div>
                    <div className="font-heading text-[0.65rem] font-bold uppercase tracking-[0.3em] text-white/45">
                      Card {i + 1}
                    </div>
                    <div className="font-heading text-xl font-extrabold tabular-nums">
                      {c.account ?? "—"}
                    </div>
                  </div>
                  <div className="font-heading text-lg font-extrabold tabular-nums text-[#46d68c]">
                    {toks} tk
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-sm text-white/50">
            Grab your card{newCards.length > 1 ? "s" : ""} from the dispenser — tap in at the games.
          </p>
          <button
            type="button"
            onClick={onExit}
            className="font-heading mt-8 h-16 w-full rounded-full bg-[#00e2e5] text-xl font-extrabold uppercase italic text-[#04252b]"
          >
            Done
          </button>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-md py-16 text-center kiosk-zoom">
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

  // ── New cards — add 1–10 cards, pick a package each, "pay & dispense" ──
  if (mode === "newcard" && phase === "cart") {
    return (
      <div className="mx-auto max-w-2xl px-2 py-6 kiosk-zoom">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="font-heading text-4xl font-extrabold italic">New cards</h1>
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="rounded-full border border-white/15 px-5 py-2 text-sm text-white/60"
          >
            Back
          </button>
        </div>
        <p className="mb-5 text-white/55">
          Add a card for everyone in your group and pick each one&rsquo;s token package. One payment
          covers them all.
        </p>

        <div className="space-y-4">
          {newCards.map((c, i) => {
            const expanded = newEditIdx === i;
            return (
              <div key={i} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <div className="flex items-center justify-between">
                  <span className="font-heading text-lg font-extrabold italic">Card {i + 1}</span>
                  <div className="flex items-center gap-4">
                    {!expanded && (
                      <button
                        type="button"
                        onClick={() => setNewEditIdx(i)}
                        className="text-sm font-bold text-[#00e2e5]"
                      >
                        Edit
                      </button>
                    )}
                    {newCards.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          removeNewCard(i);
                          setNewEditIdx(null);
                        }}
                        className="text-sm text-white/45"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                {expanded ? (
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {TOKEN_PACKAGES.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setNewCard(i, { packageId: p.id });
                          setNewEditIdx(null); // collapse after picking
                        }}
                        className={`rounded-xl border-2 px-3 py-4 text-center ${
                          c.packageId === p.id
                            ? "border-[#00e2e5] bg-[#00e2e5]/10 text-white"
                            : "border-white/10 bg-white/[0.02] text-white/60"
                        }`}
                      >
                        <TokenTileBody p={p} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="mt-1 text-lg font-semibold text-white/80">
                    {pkgLabel(c.packageId)}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {newCards.length < 10 && (
          <button
            type="button"
            onClick={() => {
              addNewCard();
              setNewEditIdx(newCards.length); // expand the newly added card
            }}
            className="mt-4 w-full rounded-2xl border-2 border-dashed border-[#f800c6]/40 px-5 py-4 font-bold text-[#f800c6]"
          >
            + Add another card
          </button>
        )}

        <div className="mt-6 flex items-center justify-between rounded-2xl border border-[#00e2e5]/35 bg-white/[0.04] px-6 py-4">
          <div className="font-heading text-2xl font-extrabold tabular-nums">
            ${(newTotalCents / 100).toFixed(2)}
          </div>
          <button
            type="button"
            disabled={!readerReady || dispenser.stacker === "empty"}
            onClick={() => setPhase("paying")}
            className="font-heading h-14 rounded-full bg-[#00e2e5] px-8 text-lg font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
          >
            Pay &amp; dispense
          </button>
        </div>
        {!readerReady ? (
          <p className="mt-2 text-center text-sm text-amber-300/80">
            Card dispenser is offline — please see an attendant to buy new cards.
          </p>
        ) : dispenser.stacker === "empty" ? (
          <p className="mt-2 text-center text-sm text-amber-300/80">
            The card dispenser is out of cards — please see an attendant.
          </p>
        ) : dispenser.stacker === "few" ? (
          <p className="mt-2 text-center text-sm text-white/40">
            Pay, then take each card as it&rsquo;s dispensed.
          </p>
        ) : null}
      </div>
    );
  }

  if (phase === "paying") {
    const isNew = mode === "newcard";
    const payTotalCents = isNew ? newTotalCents : totalCents;
    const payAmount = payTotalCents / 100;
    const payCount = isNew ? newCards.length : cards.length;
    // Charge on the paired Square reader when one is configured (owner: kiosk
    // uses the reader, not the embedded card iframe). Falls back to the typed
    // card only on a readerless device.
    const readerId = config?.readerId ?? null;
    const useReader = kioskTerminalEnabled() && !!readerId;
    return (
      <div className="mx-auto max-w-md py-8 kiosk-zoom">
        <div className="mb-6 text-center">
          <div className="font-heading text-3xl font-extrabold italic">
            Pay ${payAmount.toFixed(2)}
          </div>
          <p className="mt-1 text-sm text-white/50">
            {payCount} card{payCount > 1 ? "s" : ""} ·{" "}
            {isNew ? "cards dispense once payment clears" : "tokens load the moment payment clears"}
          </p>
        </div>
        {useReader && readerId ? (
          <KioskTerminalCheckoutGate
            brand={brand}
            deviceId={readerId}
            depositCentsExpected={payTotalCents}
            prepareFn={() => readerPrepare(isNew ? "new_card" : "reload")}
            onCaptured={(ep) => void readerFinalize(isNew ? "new_card" : "reload", ep)}
            onCancel={() => setPhase("cart")}
          />
        ) : (
          <PaymentForm
            amount={payAmount}
            itemName="Game Zone tokens"
            billId={
              isNew
                ? `gznew-${newCards.length}x`
                : `gz-${cards
                    .map((c) => c.accountNumber.trim())
                    .join("-")
                    .slice(0, 40)}`
            }
            contact={{ firstName: "Game", lastName: "Zone", email: "", phone: "" }}
            locationId={
              center === "naples" ? "naples" : brand === "headpinz" ? "headpinz" : "fasttrax"
            }
            onTokenize={async ({ cardNonce }) => {
              if (!cardNonce) return;
              if (isNew) await payNewCards(cardNonce);
              else await pay(cardNonce);
            }}
            onSuccess={() => {
              /* tokenize-only mode: the charge happens in onTokenize → pay()/payNewCards() */
            }}
            onError={(m) => {
              setError(m);
              setPhase("error");
            }}
            onCancel={() => setPhase("cart")}
          />
        )}
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
        {readerReady
          ? "Add each card and pick its token package — insert each card to read it. One payment covers them all."
          : "Add each card and pick its token package — scan the barcode or type the number. One payment covers them all."}
      </p>

      {error && phase === "error" && (
        <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-red-100">
          {error}
        </div>
      )}
      {dispenser.error && (
        <div className="mb-4 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-amber-100">
          {dispenser.error.message}
          {dispenser.error.hint ? ` — ${dispenser.error.hint}` : ""}
        </div>
      )}

      <div className="space-y-4">
        {cards.map((c, i) => {
          const expanded = reloadEditIdx === i;
          return (
            <div key={i} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <div className="flex items-center justify-between">
                <span className="font-heading text-lg font-extrabold italic">Card {i + 1}</span>
                <div className="flex items-center gap-4">
                  {!expanded && (
                    <button
                      type="button"
                      onClick={() => setReloadEditIdx(i)}
                      className="text-sm font-bold text-[#00e2e5]"
                    >
                      Edit
                    </button>
                  )}
                  {cards.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        removeCard(i);
                        setReloadEditIdx(null);
                      }}
                      className="text-sm text-white/45"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {expanded ? (
                <>
                  {readerReady && (
                    <button
                      type="button"
                      disabled={!!dispenser.busy}
                      onClick={() => void readReloadCard(i)}
                      className="mt-3 w-full rounded-xl bg-[#00e2e5] px-5 py-3.5 text-base font-bold text-[#04252b] disabled:opacity-40"
                    >
                      {dispenser.busy && c.status !== "ok"
                        ? "Insert your card…"
                        : c.accountNumber.trim()
                          ? "Insert a different card"
                          : "Insert card to read"}
                    </button>
                  )}
                  <div className="mt-3 flex gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={c.accountNumber}
                      onChange={(e) =>
                        setCard(i, { accountNumber: e.target.value, status: "unverified" })
                      }
                      onBlur={() =>
                        c.accountNumber.trim() && c.status === "unverified" && verify(i)
                      }
                      placeholder={
                        readerReady ? "…or type the number" : "Card number (scan or type)"
                      }
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
                      {c.holderName ? `${c.holderName} · ` : ""}balance {c.balance?.tokens ?? 0}{" "}
                      tokens
                    </div>
                  )}
                  {c.status === "bad" && (
                    <div className="mt-2 text-sm text-red-300">
                      Card not found — check the number.
                    </div>
                  )}
                  <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {TOKEN_PACKAGES.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setCard(i, { packageId: p.id });
                          // Collapse after picking IF the card is verified; keep it
                          // open when the number still needs checking.
                          if (c.status === "ok") setReloadEditIdx(null);
                        }}
                        className={`rounded-xl border-2 px-3 py-4 text-center ${
                          c.packageId === p.id
                            ? "border-[#00e2e5] bg-[#00e2e5]/10 text-white"
                            : "border-white/10 bg-white/[0.02] text-white/60"
                        }`}
                      >
                        <TokenTileBody p={p} />
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="mt-1 text-lg font-semibold text-white/80">
                  {c.accountNumber.trim() ? `#${c.accountNumber.trim()}` : "No card number"} ·{" "}
                  {pkgLabel(c.packageId)}
                  {c.status === "ok" ? (
                    <span className="text-[#46d68c]"> · ✓</span>
                  ) : (
                    <span className="text-[#f0b341]"> · needs check</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {cards.length < 10 && (
        <button
          type="button"
          onClick={() => {
            addCard();
            setReloadEditIdx(cards.length); // expand the newly added card
          }}
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
