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
import { creditTokensViaBridge } from "../service/game-card-bridge";
import { kioskTerminalEnabled, kioskGzCartEnabled } from "~/features/kiosk/flags";
import {
  TOKEN_PACKAGES,
  ACTIVATION_FEE_CENTS,
  activationFeeCents,
} from "~/features/game-cards/constants";
import { centerCodeFor } from "~/config/intercard-centers";
import type { Brand, CenterCode } from "~/features/booking";
import { useGameCardDispenser, useSerialMsr, type FaultBehavior } from "../card-reader";
import type { GameCardCartPurchase } from "~/features/booking/state/types";
import { useKioskConfig } from "../KioskConfigContext";
import { BrandedLoader } from "./BrandedLoader";
import { CardSlotGuide } from "./CardSlotGuide";
import { KioskDispenserHold } from "./KioskDispenserHold";

/** A recoverable dispenser fault the flow holds on until staff resume. */
type HoldFault = Extract<FaultBehavior, { kind: "hold" }>;

const SEE_ATTENDANT_SAFE = "Your payment is safe — please see an attendant.";

/** Consecutive unreadable/duplicate blanks tolerated before we STOP dispensing
 *  and hold for staff. Bounded so a stack loaded facing the wrong way can't be
 *  fed through the reader one card at a time until the whole stacker is gone. */
const MAX_BAD_BLANKS = 3;

/** Consecutive failed AUTO reads (reload / balance) before we stop re-arming the
 *  gate and wait for an explicit tap. Without this, an unreadable or stuck card
 *  loops forever — the reader keeps re-ingesting and re-presenting it ("it keeps
 *  asking / keeps the card"). The guest's card is never captured or swapped;
 *  reload only ever reads an inserted card and presents it back. */
const MAX_AUTO_READ_FAILS = 3;

/** The final "cards ready / tokens loaded" screen auto-closes after this many
 *  seconds (owner 2026-07-19). We only reach it once the dispenser sensor has
 *  confirmed every card was taken (waitTaken), so this is a hands-off "you're
 *  done" timeout — no one has to tap Done. */
const DONE_AUTO_CLOSE_SECONDS = 30;

/** Hold shown when too many blanks in a row can't be read — almost always the
 *  stock loaded facing the wrong way. No sensor can confirm orientation, so
 *  Resume is enabled immediately (staff judgment) and re-inits on resume. */
const BAD_READ_HOLD: HoldFault = {
  kind: "hold",
  title: "Check the card stock",
  message: "Several new cards in a row couldn't be read — they may be loaded facing the wrong way.",
  hint: "Reload the dispenser with the cards facing the correct direction, then resume.",
  reinitOnResume: true,
};

/** Hold shown when the reject/error bin is FULL. Checked PROACTIVELY — before
 *  charging and before every card — because a full bin only surfaces via
 *  capture() when a bad card needs rejecting; a bin that's already full at the
 *  start (with cards that all read fine) would otherwise never be caught (owner
 *  2026-07-19: "assume bin full at the start, check constantly"). Resume is
 *  GATED on the bin reporting clear (sensor-derived errorBin === "ok"). */
const BIN_FULL_HOLD: HoldFault = {
  kind: "hold",
  title: "Card bin full",
  message: "The reject bin needs to be emptied before more cards can be dispensed.",
  hint: "Empty the reject bin — Resume unlocks once the sensor reads clear.",
  // Watch the sensor for full → empty: Resume unlocks the moment the bin reads
  // clear (a pull-out to empty it triggers this once).
  resumeReady: (s) => s.errorBin === "ok",
  reinitOnResume: true,
};

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
type Mode = "choose" | "reload" | "newcard" | "balance";

/**
 * Guest-facing card number. The mag track pads the account to a fixed-width
 * digit field with LEADING ZEROS (track2 "P6283=0000000001037356"), but the
 * number PRINTED on the card is the unpadded form — showing the raw track read
 * as "the card number" looked wrong to guests (owner 2026-07-18, visual only:
 * Intercard accepts both forms, so verify/load always worked). Display strips
 * the zeros; EVERY API call keeps the raw value it was given (the on-prem EIS
 * bridge is only proven with the as-read form).
 */
function displayCardNumber(acct: string): string {
  return acct.replace(/^0+(?=\d)/, "");
}

/** One recent-activity row from the verify lookup (web ReloadFlow parity). */
interface BalanceTxn {
  transType?: string;
  tokens?: number;
  bonusTokens?: number;
  points?: number;
  timeStamp?: string;
  location?: string;
  device?: string;
}

/** Balance-check card state (mode "balance" — one card at a time, owner rule). */
interface BalanceCard {
  accountNumber: string;
  status: "reading" | "checking" | "ok" | "bad";
  name?: string;
  balance?: { tokens: number; bonusTokens: number; eTickets: number; timeMinutes: number };
  /** Recent card activity — shown like the web reload page (owner 2026-07-18). */
  transactions?: BalanceTxn[];
}

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
  onBusyChange,
  cartHasItems = false,
  onAddToVisit,
}: {
  center: CenterCode;
  brand: Brand;
  /** "full" = dispenser (buy + reload + balance); "reload" = MSR reader only —
   *  reload + balance check, NO new-card sales (that tile greys out and points
   *  to the front kiosk / Guest Services — owner 2026-07-20). */
  capability?: "full" | "reload";
  onExit: () => void;
  /** Fires true while the dispenser is mid-operation/holding so the flow can
   *  pause the idle watchdog (don't reset a guest mid-dispense). */
  onBusyChange?: (busy: boolean) => void;
  /** KIOSK cart mode (owner 2026-07-18): with activities already in the cart,
   *  cards join the BOOKING instead of checking out here — one payment at the
   *  shared checkout, fulfillment on the confirmation screen. */
  cartHasItems?: boolean;
  onAddToVisit?: (purchase: GameCardCartPurchase) => void;
}) {
  // Every kiosk lands on the chooser — MSR-only kiosks offer reload + balance
  // check there, with new-card sales greyed out (owner 2026-07-20; the first
  // MSR release wrongly jumped straight to reload, hiding balance check).
  const [mode, setMode] = useState<Mode>("choose");
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
  // Auto-read backoff (reload + balance): consecutive failed auto-reads, and a
  // flag that pauses the auto-arm once they pile up so a bad/stuck card can't
  // loop the gate forever. Reset on a clean read or an explicit retry tap.
  const autoReadFailsRef = useRef(0);
  const [autoReadBlocked, setAutoReadBlocked] = useState(false);
  // Balance check (mode "balance") — ONE card at a time (owner rule).
  const [balCard, setBalCard] = useState<BalanceCard | null>(null);
  const [balTyped, setBalTyped] = useState("");
  // Seconds left before the final screen auto-closes (null = not counting).
  const [doneAutoCloseIn, setDoneAutoCloseIn] = useState<number | null>(null);
  const locationCode = centerCodeFor(center, brand);

  // The CRT-591 dispenser owns ONE connection for the whole Game Zone session
  // (this component stays mounted until the guest exits). Auto-reconnects
  // silently on a provisioned kiosk.
  const { config } = useKioskConfig();
  const dispenser = useGameCardDispenser({ config });
  const readerReady = dispenser.ready;

  // KIOSK cart mode: with activities already in the cart, "Add to my visit"
  // hands the cards to the booking so they ride the ONE shared checkout the
  // Square reader charges (fulfillment on the confirmation screen). Requires
  // the reader rail (cards join the deposit order the reader charges); the
  // standalone empty-cart flow is untouched. Null = pay & dispense here.
  const addToVisit =
    cartHasItems &&
    onAddToVisit &&
    kioskGzCartEnabled() &&
    kioskTerminalEnabled() &&
    config?.readerId
      ? onAddToVisit
      : null;

  // Recoverable-fault hold: the flow pauses on a full-screen hold overlay until
  // staff resume. `holdRef` carries the promise resolver the dispense loop
  // awaits (true = resume + retry the same card, false = give up → attendant).
  const [holdFault, setHoldFault] = useState<HoldFault | null>(null);
  const holdRef = useRef<{ resolve: (resume: boolean) => void; reinit: boolean } | null>(null);
  const [reloadPending, setReloadPending] = useState(false);

  const holdUntilResolved = (fault: HoldFault): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      holdRef.current = { resolve, reinit: fault.reinitOnResume };
      setHoldFault(fault);
    });
  const onHoldResume = async () => {
    const h = holdRef.current;
    holdRef.current = null;
    setHoldFault(null);
    if (h?.reinit) await dispenser.reinit(); // device lost its card position
    h?.resolve(true);
  };
  const onHoldAttendant = () => {
    const h = holdRef.current;
    holdRef.current = null;
    setHoldFault(null);
    h?.resolve(false);
  };

  // When leaving reload, stop the gate from accepting more cards.
  useEffect(() => {
    if (mode !== "reload") return;
    return () => {
      if (dispenser.ready) void dispenser.stopAccepting();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Pause the idle watchdog while the dispenser is working or holding.
  useEffect(() => {
    onBusyChange?.(phase === "loading" || phase === "paying" || holdFault != null);
  }, [phase, holdFault, onBusyChange]);

  // Final screen auto-closes hands-free: we only land on "done" once the cards
  // are dispensed + taken (sensor-confirmed via waitTaken), so no one has to tap
  // Done — count down and exit. Tapping Done still closes immediately.
  useEffect(() => {
    if (phase !== "done") {
      setDoneAutoCloseIn(null);
      return;
    }
    const deadline = Date.now() + DONE_AUTO_CLOSE_SECONDS * 1000;
    setDoneAutoCloseIn(DONE_AUTO_CLOSE_SECONDS);
    const t = setInterval(() => {
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      setDoneAutoCloseIn(left);
      if (left <= 0) {
        clearInterval(t);
        onExit();
      }
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const totalCents = cards.reduce((sum, c) => {
    const pkg = TOKEN_PACKAGES.find((p) => p.id === c.packageId);
    return sum + (pkg?.priceCents ?? 0);
  }, 0);
  const allReady = cards.length > 0 && cards.every((c) => c.status === "ok" && c.packageId);

  // New cards owe a $2 activation fee each (owner 2026-07-18) — added here so the
  // displayed total matches what the reader charges (prepareTerminalPurchase adds
  // the identical fee). Reloads never activate → totalCents above carries no fee.
  const newTotalCents =
    newCards.reduce((sum, c) => {
      const pkg = TOKEN_PACKAGES.find((p) => p.id === c.packageId);
      return sum + (pkg?.priceCents ?? 0);
    }, 0) + activationFeeCents("new_card", newCards.length);
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
  // acceptAndRead closes the entry gate before we present, so the unit can't
  // auto-swallow the returned card (the "it takes it" bug).
  const readReloadCard = async (i: number) => {
    const r = await dispenser.acceptAndRead({ timeoutMs: 30_000 });
    await dispenser.present(); // ALWAYS hand the card back — reload NEVER keeps a card
    if (!r.ok) {
      // Read/absent-card fault. Bound the auto-arm: after a few misses stop
      // re-arming so an unreadable or stuck card can't loop the gate forever.
      if (++autoReadFailsRef.current >= MAX_AUTO_READ_FAILS) setAutoReadBlocked(true);
      return; // the dispenser.error banner explains; guest taps to retry
    }
    autoReadFailsRef.current = 0;
    setAutoReadBlocked(false);
    setCard(i, { accountNumber: r.value, status: "unverified" });
    await verify(i, r.value);
  };

  // BALANCE CHECK: insert → read → give the card straight back → look it up.
  const fetchBalance = async (acct: string) => {
    setBalCard({ accountNumber: acct, status: "checking" });
    try {
      const res = await fetch("/api/game-cards/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountNumber: acct, locationCode }),
      });
      const data = await res.json();
      if (res.ok && data.ok !== false && (data.balance || data.tokens != null)) {
        const bal = data.balance ?? data;
        setBalCard({
          accountNumber: acct,
          status: "ok",
          name: bal.name ?? data.name,
          balance: {
            tokens: bal.tokens ?? 0,
            bonusTokens: bal.bonusTokens ?? 0,
            eTickets: bal.eTickets ?? 0,
            timeMinutes: bal.timeMinutes ?? 0,
          },
          transactions: Array.isArray(data.transactions) ? data.transactions : undefined,
        });
      } else {
        setBalCard({ accountNumber: acct, status: "bad" });
      }
    } catch {
      setBalCard({ accountNumber: acct, status: "bad" });
    }
  };
  const readBalanceCard = async () => {
    setBalCard({ accountNumber: "", status: "reading" });
    const r = await dispenser.acceptAndRead({ timeoutMs: 30_000 });
    await dispenser.present(); // give it straight back — never keep the card
    if (!r.ok) {
      if (++autoReadFailsRef.current >= MAX_AUTO_READ_FAILS) setAutoReadBlocked(true);
      setBalCard(null); // dispenser.error banner explains what happened
      return;
    }
    autoReadFailsRef.current = 0;
    setAutoReadBlocked(false);
    await fetchBalance(r.value);
  };

  // Serial-swipe MSR (reload-only kiosks, capability "reload"): a raw COM
  // swipe reader instead of the CRT-591 — each swipe streams `;6283=<acct>?`
  // (see useSerialMsr.ts). A valid swipe lands wherever the screen is waiting
  // for a card — the expanded reload row, or the balance check — and verifies
  // / looks up immediately, exactly like a typed entry. A kiosk has a
  // dispenser OR an MSR, never both (dispenser wins in gameZoneCapability).
  const msrActive = capability === "reload" && !!config?.msrEnabled;
  const [msrBadSwipe, setMsrBadSwipe] = useState(false);
  const onMsrSwipe = (acct: string) => {
    if (phase !== "cart") return; // never mid-payment/loading
    setMsrBadSwipe(false);
    if (mode === "balance") {
      setBalTyped(acct);
      void fetchBalance(acct);
    } else if (mode === "reload" && reloadEditIdx != null) {
      setCard(reloadEditIdx, { accountNumber: acct, status: "unverified" });
      void verify(reloadEditIdx, acct);
    }
  };
  const msr = useSerialMsr({
    enabled: msrActive,
    portInfo: config?.msrPortInfo ?? null,
    baud: config?.msrBaud ?? null,
    onSwipe: onMsrSwipe,
    onBadSwipe: () => setMsrBadSwipe(true),
  });
  const msrListening = msrActive && msr.connection.state === "listening";

  // AUTO-ARM the card slot (owner 2026-07-18: "guest should never have to push
  // a button to insert a card"): whenever a screen is WAITING on a card — the
  // balance screen with none read yet, or the expanded reload row with no
  // account — open the gate ourselves. acceptAndRead times out after 30s (and
  // the gate closes after every read), so this re-arms on a 400ms debounce;
  // dispenser.busy guards double-arming and the cleanup cancels stale arms.
  // Placed AFTER the read handlers so the closure never references them
  // before declaration; still above every early return (hooks order safe).
  useEffect(() => {
    if (!readerReady || dispenser.busy || phase !== "cart" || autoReadBlocked) return;
    const armBalance = mode === "balance" && !balCard;
    const reloadRow = mode === "reload" && reloadEditIdx != null ? cards[reloadEditIdx] : undefined;
    const armReload =
      !!reloadRow && !reloadRow.accountNumber.trim() && reloadRow.status === "unverified";
    if (!armBalance && !armReload) return;
    const t = setTimeout(() => {
      if (armBalance) void readBalanceCard();
      else if (reloadEditIdx != null) void readReloadCard(reloadEditIdx);
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerReady, dispenser.busy, phase, mode, balCard, reloadEditIdx, cards, autoReadBlocked]);

  // A fresh card slot / mode change gets a clean auto-read budget (so a block on
  // one card doesn't strand a different one).
  useEffect(() => {
    autoReadFailsRef.current = 0;
    setAutoReadBlocked(false);
  }, [reloadEditIdx, mode]);

  // BUY: one upfront charge for the basket, THEN dispense + load + present each
  // card one at a time (load must clear before a card is handed over).
  const payNewCards = async (cardNonce: string) => {
    // Don't take money if the bin is already full — hold up front so staff empty
    // it before we charge (bail → stay on the cart, nothing charged).
    if (!(await holdIfBinFull())) return;
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

  // Bin a bad/unloaded blank while honoring the HARD rule that a card is NEVER
  // moved into a FULL bin: dispenser.capture() reads the bin sensor first and
  // returns a bin-full HOLD instead of issuing the move, so we pause on the hold
  // overlay until staff empty the bin, then complete the capture. Returns false
  // only if staff bail to an attendant — the card is left where it is (held),
  // never forced into a full bin.
  const captureSafely = async (): Promise<boolean> => {
    for (;;) {
      const r = await dispenser.capture();
      if (r.ok) return true;
      if (r.fault.kind === "hold") {
        const resumed = await holdUntilResolved(r.fault);
        if (!resumed) return false;
        continue; // bin emptied → complete the move
      }
      return false; // any other fault binning a blank → give up safely
    }
  };

  // Proactive bin-full gate: the bin can be full at the START of a buy (or fill
  // mid-run) with every card reading fine, in which case capture() never runs
  // and the fault would go unseen. Check the sensor-derived bin state up front
  // and before each card; hold until staff empty it (owner 2026-07-19: "check
  // constantly"). Only a CONFIRMED "full" holds — a transient "unknown" read
  // (already retried in getBinState) proceeds, so normal buys aren't blocked.
  // Returns false only if staff bail to an attendant.
  const holdIfBinFull = async (): Promise<boolean> => {
    while ((await dispenser.getBinState()) === "full") {
      const resumed = await holdUntilResolved(BIN_FULL_HOLD);
      if (!resumed) return false;
    }
    return true;
  };

  // Dispense → read → load → present, ONE card at a time. Faults are handled by
  // category: a recoverable "hold" (out of cards, jam, bin) pauses on the hold
  // overlay and, on staff resume, retries the SAME card; a bad blank is captured
  // and re-dispensed, but only up to MAX_BAD_BLANKS in a row — then it holds for
  // staff too (wrong-way stock); a dead-end aborts (money safe, rows pending).
  const dispenseNewCards = async (groupId: string, rows: Array<{ txnId: string }>) => {
    const abort = (i: number, message: string) => {
      setNewCardAt(i, { cardStatus: "failed" });
      setError(message);
      setPhase("error");
    };
    let blanksBad = 0; // consecutive bad-blank captures (bounded → hold for staff)
    // Every dispensed blank has a UNIQUE pre-encoded account. A repeat means the
    // reader handed back a stale/duplicate read (the "2124 on four cards" bug) —
    // treat it as a bad read so we never load the same account twice.
    const usedAccounts = new Set<string>();

    for (let i = 0; i < newCards.length; i++) {
      const txnId = rows[i]?.txnId;
      if (!txnId) break;
      // Assume the bin can be full at any point — check BEFORE every dispense
      // (owner 2026-07-19). A full bin has nowhere to reject a bad blank, so
      // hold here until staff empty it rather than dispensing into a dead end.
      if (!(await holdIfBinFull())) return abort(i, SEE_ATTENDANT_SAFE);
      setNewCardAt(i, { cardStatus: "dispensing" });
      setDispenseMsg(`Dispensing card ${i + 1} of ${newCards.length}…`);

      const r = await dispenser.dispenseAndRead();
      if (!r.ok) {
        const f = r.fault;
        if (f.kind === "hold") {
          const resumed = await holdUntilResolved(f);
          if (!resumed) return abort(i, SEE_ATTENDANT_SAFE);
          i--; // retry the same paid card once the fault is cleared
          continue;
        }
        if (f.kind === "card-retry") {
          // Unreadable blank (e.g. loaded facing the wrong way) — bin it to the
          // error bin. A lone misfeed clears on the next card; too many in a row
          // means the stock is wrong-way, so HOLD for staff instead of feeding
          // the whole stacker through one card at a time.
          if (!(await captureSafely())) return abort(i, SEE_ATTENDANT_SAFE);
          if (++blanksBad >= MAX_BAD_BLANKS) {
            const resumed = await holdUntilResolved(BAD_READ_HOLD);
            if (!resumed) return abort(i, SEE_ATTENDANT_SAFE);
            blanksBad = 0; // staff fixed the stock — start the count fresh
          }
          i--;
          continue;
        }
        return abort(
          i,
          f.kind === "abort" ? f.message : `${r.info.message}. ${SEE_ATTENDANT_SAFE}`,
        );
      }
      const account = r.value;

      // Stale/duplicate read guard — bin this blank and re-dispense rather than
      // credit an account we already loaded this session. Same bounded-then-hold
      // guard so a run of bad reads can't drain the stacker.
      if (usedAccounts.has(account)) {
        if (!(await captureSafely())) return abort(i, SEE_ATTENDANT_SAFE);
        if (++blanksBad >= MAX_BAD_BLANKS) {
          const resumed = await holdUntilResolved(BAD_READ_HOLD);
          if (!resumed) {
            return abort(i, `Couldn't get a clean read from the dispenser. ${SEE_ATTENDANT_SAFE}`);
          }
          blanksBad = 0;
        }
        i--;
        continue;
      }
      blanksBad = 0;
      usedAccounts.add(account);

      setDispenseMsg(`Loading tokens onto card ${i + 1}…`);
      let loaded = false;
      let balanceTokens: number | undefined;
      // On-prem FIRST: load through the kiosk-PC bridge → local EIS server (fast).
      // If it isn't reachable, the server falls back to the cloud SOAP path
      // (preLoaded:false). Never both — no double-credit.
      const pkg = TOKEN_PACKAGES.find((p) => p.id === newCards[i]?.packageId);
      const bridged = pkg
        ? await creditTokensViaBridge({
            accountNumber: account,
            tokens: pkg.tokens,
            bonusTokens: pkg.bonusTokens,
          })
        : false;
      try {
        const res = await fetch("/api/game-cards/load-card", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            groupId,
            txnId,
            accountNumber: account,
            locationCode,
            preLoaded: bridged,
          }),
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
        // captureSafely holds for staff if the bin is full (never binned into a
        // full bin); either way the guest gets the money-safe attendant message.
        setNewCardAt(i, { account, loaded: false, cardStatus: "failed" });
        await captureSafely();
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
    // New-card dispense needs a non-full bin — hold before charging on the
    // reader (reload never dispenses/bins, so it's exempt). Staff bail → throw
    // the money-safe message so the terminal flow aborts before any charge.
    if (kind === "new_card" && !(await holdIfBinFull())) {
      throw new Error(SEE_ATTENDANT_SAFE);
    }
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

  // reload via the reader: after the charge, load each already-charged card on the
  // on-prem bridge, then report through /load-card (preLoaded=true → the server
  // records it without re-crediting via SOAP; preLoaded=false → SOAP fallback). A
  // failed report leaves the row pending for the reconcile cron — never a
  // double-credit (the two paths don't share dedup).
  const loadReloadViaBridge = async (
    groupId: string,
    rows: Array<{ txnId: string; accountNumber: string; tokens: number; bonusTokens: number }>,
  ) => {
    let anyPending = false;
    for (const r of rows) {
      const bridged = await creditTokensViaBridge({
        accountNumber: r.accountNumber,
        tokens: r.tokens,
        bonusTokens: r.bonusTokens,
      });
      try {
        const res = await fetch("/api/game-cards/load-card", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            groupId,
            txnId: r.txnId,
            accountNumber: r.accountNumber,
            locationCode,
            preLoaded: bridged,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.loaded !== true) anyPending = true;
      } catch {
        anyPending = true; // pending → reconcile cron recovers via cloud SOAP
      }
    }
    // The card is already back in the guest's hand — always finish, but flag a
    // soft "may take a minute" note if any credit didn't confirm (recover-forward).
    setReloadPending(anyPending);
    setPhase("done");
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
        // reload: cards are already in the guest's hand — load each on the on-prem
        // bridge, then report through /load-card (owner: kiosk reload uses the
        // bridge, not SOAP).
        await loadReloadViaBridge(data.groupId, data.rows ?? []);
      }
    } catch {
      setError(
        "We received your payment but couldn't finish — please see the front desk (do not pay again).",
      );
      setPhase("error");
    }
  };

  // ── Dispenser offline & couldn't reconnect: disable Game Zone entirely ──
  // No dispenser → can't dispense → don't sell or offer it. Highest priority.
  if (dispenser.unavailable) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center kiosk-zoom">
        <div className="font-heading text-5xl font-extrabold italic text-amber-300">
          Game Zone is temporarily unavailable
        </div>
        <p className="mt-5 text-lg text-white/65">
          The card machine is offline right now, so we can&rsquo;t sell or reload cards here. Please
          see an attendant — they can help at the front desk.
        </p>
        <button
          type="button"
          onClick={onExit}
          className="font-heading mt-10 h-16 w-full rounded-full bg-[#00e2e5] text-xl font-extrabold uppercase italic text-[#04252b]"
        >
          Back
        </button>
      </div>
    );
  }

  // ── Recoverable dispenser fault: full-screen hold until staff resume ──
  // Takes over whenever active (can arise mid-dispense), above every other view.
  if (holdFault) {
    return (
      <KioskDispenserHold
        fault={holdFault}
        getStatusNow={dispenser.getStatusNow}
        onResume={() => void onHoldResume()}
        onSeeAttendant={onHoldAttendant}
      />
    );
  }

  // ── Connecting to the dispenser: cover the whole screen with the loader ──
  // While the reader is (re)connecting we can't dispense yet, so don't show a
  // half-usable screen — the branded loader takes the whole page until it's
  // ready. Skipped during payment / done / error so those views aren't hidden.
  if (dispenser.reconnecting && phase !== "paying" && phase !== "done" && phase !== "error") {
    return (
      <div className="flex h-full items-center justify-center py-16">
        <BrandedLoader
          brand={brand}
          label="Connecting to the card dispenser…"
          sublabel="One moment"
        />
      </div>
    );
  }

  // ── Mode chooser: New card vs Reload vs Balance ──
  if (mode === "choose") {
    // MSR-only kiosks read cards but can't dispense — new cards are sold at
    // the front kiosk / Guest Services (owner 2026-07-20). The tile stays
    // visible so guests learn where to go, but greyed out.
    const canSellNewCards = capability !== "reload";
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
            disabled={!canSellNewCards || !readerReady}
            onClick={() => setMode("newcard")}
            className="k-glass k-tap p-[40px] text-left disabled:opacity-40"
            style={{ borderLeft: "8px solid #f800c6" }}
          >
            <div className="k-display text-[48px]">New Game Zone cards</div>
            <div className="mt-[10px] text-[28px] text-white/55">
              {!canSellNewCards
                ? "Not available at this kiosk — new Game Zone cards can be purchased at the front kiosk or at Guest Services"
                : readerReady
                  ? "Set up 1–10 fresh cards — pick a token package for each"
                  : dispenser.reconnecting
                    ? "Connecting to the card dispenser…"
                    : "Card dispenser unavailable — see an attendant"}
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
          <button
            type="button"
            onClick={() => {
              setBalCard(null);
              setBalTyped("");
              setMode("balance");
            }}
            className="k-glass k-tap p-[40px] text-left"
            style={{ borderLeft: "8px solid #46d68c" }}
          >
            <div className="k-display text-[48px]">Check card balance</div>
            <div className="mt-[10px] text-[28px] text-white/55">
              {/* MSR kiosks swipe; dispenser kiosks insert. */}
              {capability === "reload"
                ? "Swipe a card to see its tokens, bonus tokens & eTickets"
                : "Insert a card to see its tokens, bonus tokens & eTickets"}
            </div>
          </button>
        </div>
      </div>
    );
  }

  // ── Balance check — ONE card at a time (owner 2026-07-18) ──
  if (mode === "balance") {
    const bal = balCard?.balance;
    return (
      <div className="mx-auto max-w-2xl px-2 py-6 kiosk-zoom">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="font-heading text-4xl font-extrabold italic">Card balance</h1>
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="rounded-full border border-white/15 px-5 py-2 text-sm text-white/60"
          >
            Back
          </button>
        </div>

        {dispenser.error && (
          <div className="mb-4 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-amber-100">
            {dispenser.error.message}
            {dispenser.error.hint ? ` — ${dispenser.error.hint}` : ""}
          </div>
        )}

        {balCard?.status === "reading" || balCard?.status === "checking" ? (
          <div className="flex justify-center py-12">
            {balCard.status === "reading" ? (
              <CardSlotGuide
                label="Insert your card"
                sublabel="Use the card slot on the left — it reads in a second and comes right back out"
              />
            ) : (
              <BrandedLoader brand={brand} label="Checking balance…" />
            )}
          </div>
        ) : balCard?.status === "ok" && bal ? (
          <div className="rounded-2xl border border-[#46d68c]/40 bg-white/[0.04] p-6">
            <div className="text-sm uppercase tracking-[0.25em] text-white/45">
              Card #{displayCardNumber(balCard.accountNumber)}
              {balCard.name ? ` · ${balCard.name}` : ""}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4">
                <div className="font-heading text-4xl font-extrabold tabular-nums text-[#00e2e5]">
                  {bal.tokens}
                </div>
                <div className="mt-1 text-xs font-bold uppercase tracking-[0.2em] text-white/45">
                  Tokens
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4">
                <div className="font-heading text-4xl font-extrabold tabular-nums text-[#46d68c]">
                  {bal.bonusTokens}
                </div>
                <div className="mt-1 text-xs font-bold uppercase tracking-[0.2em] text-white/45">
                  Bonus tokens
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4">
                <div className="font-heading text-4xl font-extrabold tabular-nums text-[#e8b14c]">
                  {bal.eTickets}
                </div>
                <div className="mt-1 text-xs font-bold uppercase tracking-[0.2em] text-white/45">
                  eTickets
                </div>
              </div>
              {bal.timeMinutes > 0 && (
                <div className="rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4">
                  <div className="font-heading text-4xl font-extrabold tabular-nums text-white">
                    {bal.timeMinutes}
                  </div>
                  <div className="mt-1 text-xs font-bold uppercase tracking-[0.2em] text-white/45">
                    Time play (min)
                  </div>
                </div>
              )}
            </div>
            {/* Recent activity — web /reload parity (owner 2026-07-18). */}
            {balCard.transactions && balCard.transactions.length > 0 && (
              <div className="mt-5 border-t border-white/10 pt-4">
                <div className="text-sm font-bold uppercase tracking-[0.25em] text-white/45">
                  Recent activity
                </div>
                <ul className="mt-2 max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
                  {balCard.transactions.slice(0, 10).map((t, i) => {
                    const tok = t.tokens || t.bonusTokens || 0;
                    const detail = tok
                      ? `${tok > 0 ? "+" : ""}${tok} tokens`
                      : t.points
                        ? `${t.points > 0 ? "+" : ""}${t.points} eTickets`
                        : "";
                    const when = t.timeStamp ? t.timeStamp.slice(0, 16) : "";
                    return (
                      <li
                        key={i}
                        className="flex items-start justify-between gap-3 rounded-lg bg-white/[0.03] px-4 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-base text-white/80">
                            {t.transType || "Activity"}
                            {t.device ? ` · ${t.device}` : ""}
                          </div>
                          <div className="text-sm text-white/40">
                            {t.location || "—"}
                            {when ? ` · ${when}` : ""}
                          </div>
                        </div>
                        <span className="shrink-0 text-base font-semibold tabular-nums text-white/70">
                          {detail}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => {
                  setBalCard(null);
                  setBalTyped("");
                }}
                className="rounded-xl border border-white/15 px-5 py-3.5 text-base font-semibold text-white/60"
              >
                Check another card
              </button>
              <button
                type="button"
                onClick={() => {
                  // Hand-off to reload with this card pre-verified.
                  setCards([
                    {
                      accountNumber: balCard.accountNumber,
                      packageId: TOKEN_PACKAGES[1].id,
                      status: "ok",
                      balance: { tokens: bal.tokens, bonusTokens: bal.bonusTokens },
                      holderName: balCard.name,
                    },
                  ]);
                  setReloadEditIdx(0);
                  setMode("reload");
                }}
                className="rounded-xl bg-[#00e2e5] px-5 py-3.5 text-base font-bold text-[#04252b]"
              >
                Reload this card
              </button>
            </div>
          </div>
        ) : (
          <>
            {balCard?.status === "bad" && (
              <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-red-100">
                We couldn&rsquo;t find that card — try inserting it again.
              </div>
            )}
            {readerReady ? (
              <button
                type="button"
                disabled={!!dispenser.busy}
                onClick={() => {
                  autoReadFailsRef.current = 0;
                  setAutoReadBlocked(false);
                  void readBalanceCard();
                }}
                className="w-full rounded-2xl bg-[#00e2e5] px-6 py-6 text-xl font-extrabold text-[#04252b] disabled:opacity-40"
              >
                {autoReadBlocked
                  ? "Couldn’t read — flip the card & tap to try again"
                  : "Insert your card to check it"}
              </button>
            ) : (
              // Readerless kiosk fallback only — with a reader, insert is the ONE way.
              <div className="space-y-2">
                {msrListening && (
                  <p className="text-sm text-white/70">
                    Swipe your card on the reader — or type the number below.
                  </p>
                )}
                {msrActive && msrBadSwipe && (
                  <p className="text-sm text-amber-300">
                    Couldn’t read that swipe — flip the card and swipe again, slow and steady.
                  </p>
                )}
                <div className="flex gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={balTyped}
                    onChange={(e) => setBalTyped(e.target.value)}
                    placeholder="Card number"
                    className="flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-lg text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => balTyped.trim() && void fetchBalance(balTyped.trim())}
                    className="rounded-xl bg-[#00e2e5] px-5 py-2.5 text-sm font-bold text-[#04252b]"
                  >
                    Check
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  if (phase === "loading") {
    // New-card dispense: show a LIVE per-card list — card number (once read off
    // the blank) + the tokens being loaded + status — so the guest can see each
    // card fill in, not just a spinner (owner 2026-07-19).
    if (mode === "newcard") {
      const statusLabel = (c: NewCard): string => {
        if (c.cardStatus === "loaded") return "Loaded ✓";
        if (c.cardStatus === "failed") return "See attendant";
        if (c.cardStatus === "dispensing") return "Dispensing…";
        if (c.account) return "Loading tokens…";
        return "Waiting…";
      };
      return (
        <div className="mx-auto max-w-md py-10 kiosk-zoom">
          <div className="mb-6 text-center">
            <div className="font-heading text-4xl font-extrabold italic">
              {newCards.length > 1 ? "Setting up your cards…" : "Setting up your card…"}
            </div>
            {dispenseMsg && <p className="mt-2 text-sm text-white/55">{dispenseMsg}</p>}
          </div>
          <div className="space-y-3 text-left">
            {newCards.map((c, i) => {
              const pkg = TOKEN_PACKAGES.find((p) => p.id === c.packageId);
              const toks = c.balanceTokens ?? (pkg ? pkg.tokens + (pkg.bonusTokens || 0) : 0);
              const done = c.cardStatus === "loaded";
              const failed = c.cardStatus === "failed";
              return (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-2xl border border-white/15 bg-white/[0.04] px-6 py-4"
                >
                  <div className="min-w-0">
                    <div className="font-heading text-[0.65rem] font-bold uppercase tracking-[0.3em] text-white/45">
                      Card {i + 1}
                    </div>
                    <div className="font-heading text-xl font-extrabold tabular-nums">
                      {c.account ? displayCardNumber(c.account) : "Dispensing…"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-heading text-lg font-extrabold tabular-nums text-[#00e2e5]">
                      {toks} tk
                    </div>
                    <div
                      className={`text-xs ${failed ? "text-red-300" : done ? "text-[#46d68c]" : "text-white/50"}`}
                    >
                      {statusLabel(c)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
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
                      {c.account ? displayCardNumber(c.account) : "—"}
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
          {doneAutoCloseIn != null && (
            <p className="mt-3 text-sm text-white/40">
              Closing automatically in {doneAutoCloseIn}s
            </p>
          )}
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-md py-16 text-center kiosk-zoom">
        <div className="font-heading text-6xl font-extrabold italic">
          {reloadPending ? "Payment received!" : "Tokens loaded!"}
        </div>
        <p className="mt-4 text-lg text-white/60">
          {reloadPending ? (
            <>
              Your tokens may take a minute to appear — if your balance looks off, see an attendant.
            </>
          ) : (
            <>
              {cards.length === 1 ? "Your card is" : `All ${cards.length} cards are`} ready — tap in
              at the games.
            </>
          )}
        </p>
        <button
          type="button"
          onClick={onExit}
          className="font-heading mt-10 h-16 w-full rounded-full bg-[#00e2e5] text-xl font-extrabold uppercase italic text-[#04252b]"
        >
          Done
        </button>
        {doneAutoCloseIn != null && (
          <p className="mt-3 text-sm text-white/40">Closing automatically in {doneAutoCloseIn}s</p>
        )}
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
          <div>
            <div className="font-heading text-2xl font-extrabold tabular-nums">
              ${(newTotalCents / 100).toFixed(2)}
            </div>
            <div className="text-xs text-white/45">
              includes ${(ACTIVATION_FEE_CENTS / 100).toFixed(0)} activation per card
            </div>
          </div>
          {addToVisit ? (
            <button
              type="button"
              disabled={!readerReady || dispenser.stacker === "empty"}
              onClick={() =>
                addToVisit({
                  mode: "new_card",
                  cards: newCards.map((c) => ({ packageId: c.packageId })),
                })
              }
              className="font-heading h-14 rounded-full bg-[#00e2e5] px-8 text-lg font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
            >
              Add to my visit
            </button>
          ) : (
            <button
              type="button"
              disabled={!readerReady || dispenser.stacker === "empty"}
              onClick={() => setPhase("paying")}
              className="font-heading h-14 rounded-full bg-[#00e2e5] px-8 text-lg font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
            >
              Pay &amp; dispense
            </button>
          )}
        </div>
        {addToVisit && (
          <p className="mt-2 text-center text-sm text-white/45">
            Cards are paid with your booking at checkout and dispense on the confirmation screen.
          </p>
        )}
        {!readerReady ? (
          <p className="mt-2 text-center text-sm text-amber-300/80">
            {dispenser.reconnecting
              ? "Connecting to the card dispenser…"
              : "Card dispenser is offline — please see an attendant to buy new cards."}
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
    <div className="relative mx-auto max-w-2xl px-2 py-6">
      {/* READ LOCK (owner 2026-07-18: a guest tapped "+ Add another card" mid-
          read): while the reader is holding/reading a card, block every button
          on this screen. The utility strip (Start over / Guest assistance)
          lives outside this component and stays reachable; a no-card read
          times out on its own in ~30s. */}
      {dispenser.busy && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center rounded-2xl bg-[#000418]/88 backdrop-blur-sm">
          {dispenser.busy === "presenting card" ? (
            <BrandedLoader
              brand={brand}
              label="Take your card"
              sublabel="It's coming back out now"
            />
          ) : (
            <CardSlotGuide
              label="Insert your card"
              sublabel="Use the card slot on the left — it reads in a second and comes right back"
            />
          )}
        </div>
      )}
      <div className="mb-5 flex items-center justify-between">
        <h1 className="font-heading text-4xl font-extrabold italic">Reload game cards</h1>
        <button
          type="button"
          onClick={() => setMode("choose")}
          className="rounded-full border border-white/15 px-5 py-2 text-sm text-white/60"
        >
          Back
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
                      onClick={() => {
                        autoReadFailsRef.current = 0;
                        setAutoReadBlocked(false);
                        void readReloadCard(i);
                      }}
                      className="mt-3 w-full rounded-xl bg-[#00e2e5] px-5 py-3.5 text-base font-bold text-[#04252b] disabled:opacity-40"
                    >
                      {dispenser.busy && c.status !== "ok"
                        ? "Insert your card…"
                        : autoReadBlocked
                          ? "Couldn’t read — flip the card & tap to try again"
                          : c.accountNumber.trim()
                            ? "Insert a different card"
                            : "Insert card to read"}
                    </button>
                  )}
                  {/* Typed entry ONLY on a readerless kiosk — with a reader, insert
                      is the one way in (owner 2026-07-18: "should not have an
                      option to type in card"). */}
                  {!readerReady && expanded && msrListening && (
                    <p className="mt-3 text-sm text-white/70">
                      Swipe your card on the reader — or type the number below.
                    </p>
                  )}
                  {!readerReady && expanded && msrActive && msrBadSwipe && (
                    <p className="mt-2 text-sm text-amber-300">
                      Couldn’t read that swipe — flip the card and swipe again, slow and steady.
                    </p>
                  )}
                  {!readerReady && (
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
                  )}
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
                  {c.accountNumber.trim()
                    ? `#${displayCardNumber(c.accountNumber.trim())}`
                    : "No card number"}{" "}
                  · {pkgLabel(c.packageId)}
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
        {addToVisit ? (
          <button
            type="button"
            disabled={!allReady}
            onClick={() =>
              addToVisit({
                mode: "reload",
                cards: cards.map((c) => ({
                  packageId: c.packageId,
                  accountNumber: c.accountNumber.trim(),
                })),
              })
            }
            className="font-heading h-14 rounded-full bg-[#00e2e5] px-8 text-lg font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
          >
            Add to my visit
          </button>
        ) : (
          <button
            type="button"
            disabled={!allReady}
            onClick={() => setPhase("paying")}
            className="font-heading h-14 rounded-full bg-[#00e2e5] px-8 text-lg font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
          >
            Pay &amp; load
          </button>
        )}
      </div>
      {addToVisit && (
        <p className="mt-2 text-center text-sm text-white/45">
          Tokens are paid with your booking at checkout and load right after payment.
        </p>
      )}
      {!allReady && (
        <p className="mt-2 text-center text-sm text-white/40">
          Check each card number to continue.
        </p>
      )}
    </div>
  );
}
