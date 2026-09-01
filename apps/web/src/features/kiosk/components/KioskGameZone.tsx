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
 * card, pay once — and are fulfilled on one of TWO hardware rails, chosen by
 * `capability`:
 *  - "full"  — CRT-591 DISPENSER: pay → dispense a blank → read its account →
 *              load → present, one card at a time (the reader holds one card).
 *  - "swipe" — MSR ONLY (owner 2026-08-28; these kiosks used to be reload-only):
 *              the guest takes a blank from the holder UNDER the screen and
 *              swipes it BEFORE paying. Each swipe is verified blank (never
 *              found in Intercard, or found empty with no history — see
 *              game-cards/blank-card.ts); Pay arms only when every card in the
 *              cart holds a verified blank. After the charge the loads are a
 *              pure credit loop — no hardware step can fail, and nothing is
 *              ever "retained": a load that doesn't confirm leaves the row
 *              pending for the reconcile cron, and the guest keeps the card.
 *              A swiped card is never clear-on-encoded (load-card.ts).
 *              The same rail fulfils comp vouchers (swipe → claim → credit)
 *              and turns a "card not found" on Reload / Check balance into a
 *              "Looks like a new card — set it up" hand-off.
 */
import { useEffect, useRef, useState } from "react";
import PaymentForm from "@/components/square/PaymentForm";
import { KioskTerminalCheckoutGate } from "./KioskTerminalCheckoutGate";
import { onsiteHealth, type OnsiteChipStatus } from "../service/game-card-bridge";
import { kioskGzCartEnabled, kioskVoucherGzEnabled } from "~/features/kiosk/flags";
import { useQrScanner } from "../qr-scanner/useQrScanner";
import { useWedgeScan } from "../checkin/wedge-scan";
import { classifyKioskCode } from "../code-entry/classify";
/** What the redeem route reports back — issuer-agnostic (ours or BMI's). */
interface RedeemedGrant {
  tokens: number;
  bonusTokens: number;
  bonusCashDollars: number;
  label: string;
}
import {
  TOKEN_PACKAGES,
  ACTIVATION_FEE_CENTS,
  activationFeeCents,
} from "~/features/game-cards/constants";
import { centerCodeFor } from "~/config/intercard-centers";
import type { Brand, CenterCode } from "~/features/booking";
import {
  useGameCardDispenser,
  useSerialMsr,
  createSwipeWaiter,
  type FaultBehavior,
} from "../card-reader";
import { acquireBlankBySwipe, classifySwipedAccount } from "../service/swiped-card";
import { accountFromScan } from "../service/scanned-card";
import type { GameCardCartPurchase } from "~/features/booking/state/types";
import { useKioskConfig } from "../KioskConfigContext";
import { kioskDeviceKey } from "../config";
import { BrandedLoader } from "./BrandedLoader";
import { CardSlotGuide } from "./CardSlotGuide";
import { SwipeBlankGuide } from "./SwipeBlankGuide";
import { KioskDispenserHold } from "./KioskDispenserHold";
import { useT, type Translate } from "../i18n";

/**
 * Comp-voucher refusal → guest copy. Every reason the server can return is
 * phrased: an unattended guest has no cashier to ask, and "something went
 * wrong" on a voucher they were handed reads as us keeping their comp.
 */
const VOUCHER_REFUSAL_KEY: Record<string, Parameters<Translate>[0]> = {
  bad_format: "gamezone.voucher.err.badFormat",
  unknown: "gamezone.voucher.err.unknown",
  // Ours (vouchers table) — an issuer decision and an expiry, both phrased
  // plainly so a guest knows whether to bother asking staff.
  voided: "gamezone.voucher.err.voided",
  expired: "gamezone.voucher.err.expired",
  // Live voucher, nothing on it we can hand over HERE (e.g. laser tag only).
  // Distinct from "used" on purpose — the guest still has value.
  not_redeemable: "gamezone.voucher.err.notRedeemable",
  // BMI-issued only.
  unverifiable: "gamezone.voucher.err.unverifiable",
  unsupported: "gamezone.voucher.err.unsupported",
  multi_item: "gamezone.voucher.err.multiItem",
  used: "gamezone.voucher.err.used",
  rate_limited: "gamezone.voucher.err.generic",
  storage: "gamezone.voucher.err.generic",
};

/** A recoverable dispenser fault the flow holds on until staff resume. */
type HoldFault = Extract<FaultBehavior, { kind: "hold" }>;

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

/** Combine cards (consolidation) entry point — ON (owner 2026-07-23). The combine
 *  runs through the shared Intercard router, which prefers the ONSITE proxy
 *  (Api_External `consolidatecards`) and falls back to cloud SOAP
 *  (TPI_ConsolidateAccounts) — same host either way, no extra hosts or env.
 *
 *  It used to be CLOUD-ONLY, hidden whenever a kiosk had a local bridge, because
 *  the bridge's EIS socket had no consolidate op. The onsite path does, so that
 *  restriction is gone (owner 2026-08-31): Combine now shows on every kiosk
 *  whose center has a card backend configured.
 *  Flip to false to hide the button. */
const GC_CONSOLIDATE_LIVE = true;

/** The final "cards ready / tokens loaded" screen auto-closes after this many
 *  seconds (owner 2026-07-19). We only reach it once the dispenser sensor has
 *  confirmed every card was taken (waitTaken), so this is a hands-off "you're
 *  done" timeout — no one has to tap Done. */
const DONE_AUTO_CLOSE_SECONDS = 30;

/** Hold shown when too many blanks in a row can't be read — almost always the
 *  stock loaded facing the wrong way. No sensor can confirm orientation, so
 *  Resume is enabled immediately (staff judgment) and re-inits on resume. */
// TODO(i18n): module-scope hold-fault copy (staff-facing dispenser recovery) —
// can't reach the useT() hook here; stays English until the hold copy is threaded
// through the locale (KioskDispenserHold render site).
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
  /** `notfound` = Intercard CONFIRMED no such account (a blank — on a swipe
   *  kiosk that's the "set it up as a new card" hand-off); `bad` = the lookup
   *  failed or was ambiguous, so the guest is asked to try again. */
  status: "unverified" | "verifying" | "ok" | "bad" | "notfound";
  balance?: { tokens: number; bonusTokens?: number };
  holderName?: string;
}

/**
 * A brand-new card being purchased. On a dispenser kiosk its Intercard account
 * is read off the blank as it's dispensed (pre-encoded stock) AFTER payment; on
 * a swipe kiosk the guest swipes the blank BEFORE payment and `blankStatus`
 * records the verdict. Tokens are loaded before the card is presented / as
 * soon as the charge clears. `txnId` ties it to the charged ledger row.
 */
interface NewCard {
  packageId: string;
  txnId?: string; // ledger row from the upfront charge
  account?: string; // read off the blank during dispense, or swiped up front
  loaded?: boolean; // tokens confirmed loaded
  cardStatus?: "pending" | "dispensing" | "loaded" | "failed";
  balanceTokens?: number; // real balance after load
  /** Swipe kiosks only — what the swipe-time lookup said about `account`.
   *  "blank" is the ONLY state that arms Pay. */
  blankStatus?: "checking" | "blank" | "active" | "duplicate" | "unknown";
  /** For the "that card isn't new" message: tokens already on it (0 = a card
   *  with history / cash / time but no tokens — "has been used before"). */
  existingTokens?: number;
}

/** The verify route CONFIRMED there is no such account — a blank, or a cleared
 *  card. A failed or ambiguous lookup (503, network, exception code) must never
 *  read as "this card is blank": that would sell a guest their own card back. */
function confirmedNotFound(ok: boolean, data: unknown): boolean {
  if (!ok || !data || typeof data !== "object") return false;
  const d = data as { exists?: unknown; notFound?: unknown };
  return d.exists === false && d.notFound === "confirmed";
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
type Mode = "choose" | "reload" | "newcard" | "balance" | "consolidate" | "voucher";

/**
 * Comp-voucher redemption (owner 2026-07-29). NO money leg: a BMI
 * "Complimentary N Token Game Card" voucher is validated + claimed server-side,
 * then ONE card is dispensed and credited on the shared rail. Works with an
 * empty cart and never joins the booking (a comp has nothing to add to a
 * checkout), so it is deliberately outside the addToVisit path below.
 *
 *   entry      waiting for a scan / typed code
 *   checking   server-side: BMI peek → grant → global single-use claim
 *   dispensing claim held; card being dispensed + credited
 *   done       card credited and taken
 *   error      refused, or dispensed-but-not-credited (staff)
 */
type VoucherPhase = "entry" | "checking" | "dispensing" | "done" | "error";

/** One voucher waiting in (or moving through) the basket. */
interface VoucherBasketRow {
  code: string;
  /** What it's worth, from the scan-time validate ("100 bonus tokens"). */
  label: string;
  /** UNSPENT game-card legs on this code at scan time. A VIP voucher carries
   *  one leg per guest, and the run owes a card for EVERY leg — the server
   *  spends exactly one leg per claim, so this is how many claims we make. */
  gzCount: number;
  /** Cards actually dispensed for this code so far (across retries). */
  issued: number;
  status: "ready" | "dispensing" | "loaded" | "failed";
  /** Card number handed over, once loaded. */
  cardNumber?: string;
  /** Why this one didn't make it (shown per row, never as a whole-run failure). */
  error?: string;
}

/** Cards per run — same ceiling as a paid multi-card buy. */
const MAX_VOUCHERS_PER_RUN = 10;
/** Consolidate flow steps: read the target card, then feed sources, then done. */
type ConsoStep = "target" | "sources" | "done";

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

/** Balance-check card state (mode "balance" — one card at a time, owner rule).
 *  `notfound` = confirmed absent (a blank); `bad` = lookup failed/ambiguous. */
interface BalanceCard {
  accountNumber: string;
  status: "reading" | "checking" | "ok" | "bad" | "notfound";
  name?: string;
  balance?: { tokens: number; bonusTokens: number; eTickets: number; timeMinutes: number };
  /** Recent card activity — shown like the web reload page (owner 2026-07-18). */
  transactions?: BalanceTxn[];
}

/** Token-package tile body — labels the amount as TOKENS and calls out the free
 *  bonus clearly (owner ask 2026-07-18). Shared by the reload + new-card grids. */
function TokenTileBody({ p }: { p: (typeof TOKEN_PACKAGES)[number] }) {
  const t = useT();
  return (
    <>
      <div className="font-heading text-3xl font-extrabold leading-none tabular-nums">
        {p.tokens}
      </div>
      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/45">
        {t("gamezone.tokensUnit")}
      </div>
      {p.bonusTokens ? (
        <div className="mt-1 text-base font-extrabold text-[#46d68c]">
          {t("gamezone.freeBonus", { n: p.bonusTokens })}
        </div>
      ) : null}
      <div className="mt-1.5 text-sm text-white/55">${(p.priceCents / 100).toFixed(0)}</div>
    </>
  );
}

/** One-line package summary for a COLLAPSED card row (owner: minimize after
 *  pick). Module-scope, so the catalog `t` is threaded in. */
function pkgLabel(t: Translate, packageId: string): string {
  const p = TOKEN_PACKAGES.find((x) => x.id === packageId);
  if (!p) return "";
  const bonus = p.bonusTokens ? ` ${t("gamezone.freeBonus", { n: p.bonusTokens })}` : "";
  return `${p.tokens} ${t("gamezone.tokensUnit")}${bonus} · $${(p.priceCents / 100).toFixed(0)}`;
}

/** Staff-readable card-system status: ONSITE (the site's own card system —
 *  real-time, instant to the floor) vs CLOUD (Intercard's replicated
 *  datacenter copy — correct, but slower to reach the readers).
 *
 *  "Onsite" (was "Local") is the same word the server-side onsite client uses
 *  for this path — see `probeOnsite` / `OnsiteStatus` in
 *  features/game-cards/data/intercard-onsite.ts — so staff, logs, and code all
 *  name the path identically when something goes wrong.
 *
 *  Renders nothing until the first health check answers. */
function BridgeChip({ status }: { status: OnsiteChipStatus | null }) {
  if (status === null) return null;
  // Three states worth distinguishing to staff:
  //   onsite     — green:  the site's own card system is serving; instant.
  //   unlicensed — red:    a CONFIG fault (MAC/token/licence mismatch). Loads
  //                        still land via cloud, but someone must fix it, so it
  //                        must not hide behind the same amber as a normal
  //                        cloud fallback.
  //   otherwise  — amber:  riding the cloud path (relay offline, kill switch
  //                        on, or probe failed) — correct, just slower to the
  //                        floor.
  const tone =
    status === "onsite"
      ? { pill: "bg-emerald-400/10 text-emerald-300/70", dot: "bg-emerald-300/80", label: "Onsite" }
      : status === "unlicensed"
        ? { pill: "bg-red-400/10 text-red-300/80", dot: "bg-red-300/80", label: "Unlicensed" }
        : { pill: "bg-amber-400/10 text-amber-300/70", dot: "bg-amber-300/80", label: "Cloud" };
  // Deliberately tiny — a staff glance-check, not a guest-facing element.
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-[2px] text-[9px] font-medium uppercase leading-none tracking-wide ${tone.pill}`}
    >
      <span className={`h-[5px] w-[5px] rounded-full ${tone.dot}`} />
      {tone.label}
    </span>
  );
}

export function KioskGameZone({
  center,
  brand,
  capability = "full",
  onExit,
  onBusyChange,
  cartHasItems = false,
  onAddToVisit,
  onCardFault,
  initialVoucherCodes = null,
  initialCardAccount = null,
  onVoucherOutcome,
}: {
  center: CenterCode;
  brand: Brand;
  /** "full" = CRT-591 dispenser (buy from the stacker + reload + balance);
   *  "swipe" = MSR swipe reader only — reload + balance check, and new cards
   *  by swiping a blank from the holder under the screen (owner 2026-08-28,
   *  reversing the 2026-07-20 reload-only rule). */
  capability?: "full" | "swipe";
  onExit: () => void;
  /** Fires true while the dispenser is mid-operation/holding so the flow can
   *  pause the idle watchdog (don't reset a guest mid-dispense). */
  onBusyChange?: (busy: boolean) => void;
  /** KIOSK cart mode (owner 2026-07-18): with activities already in the cart,
   *  cards join the BOOKING instead of checking out here — one payment at the
   *  shared checkout, fulfillment on the confirmation screen. */
  cartHasItems?: boolean;
  onAddToVisit?: (purchase: GameCardCartPurchase) => void;
  /** Fires ONCE per dispenser hold fault (out of cards / bin full / jam / bad
   *  stock) so the flow can raise the guest-assistance beacon (owner
   *  2026-07-20). Never re-fires for the same fault — after staff clear the
   *  beacon they need the hold screen (Resume / See attendant) usable. */
  onCardFault?: () => void;
  /** Comp vouchers already scanned on the coupon screen — they land straight in
   *  the basket so the guest never scans the same code twice. */
  initialVoucherCodes?: string[] | null;
  /** A game card already scanned on an ENTRY screen (attract / the category
   *  chooser). Opens straight on the balance check with the lookup already
   *  running — the same landing an MSR swipe produces (`onMsrSwipe`), so the
   *  guest never presents the card twice. */
  initialCardAccount?: string | null;
  /** Per-code result of a voucher dispense run — the flow drops DISPENSED codes
   *  from its pending list and keeps failed ones offering a way back. */
  onVoucherOutcome?: (outcomes: { code: string; loaded: boolean }[]) => void;
}) {
  const t = useT();
  // Every kiosk lands on the chooser — dispenser and swipe kiosks alike offer
  // new cards, reload and balance check there (the first MSR release wrongly
  // jumped straight to reload, hiding balance check). EXCEPT when a comp
  // voucher was already scanned on the coupon screen: go straight to
  // redemption.
  const [mode, setMode] = useState<Mode>(
    initialVoucherCodes?.length ? "voucher" : initialCardAccount ? "balance" : "choose",
  );

  // ── Comp-voucher redemption state ──
  // A BASKET, not one code at a time (owner 2026-07-29: "it would make sense to
  // be able to scan multiple vouchers before hitting get my cards"). A family
  // holding three vouchers shouldn't queue three times. Scanning only
  // VALIDATES; the destructive claim happens per card inside the dispense run.
  const [voucherPhase, setVoucherPhase] = useState<VoucherPhase>("entry");
  const [voucherTyped, setVoucherTyped] = useState("");
  const [voucherMsg, setVoucherMsg] = useState<string | null>(null);
  const [voucherBasket, setVoucherBasket] = useState<VoucherBasketRow[]>([]);
  /** Live mirror of the basket for ASYNC code — the seed loop and the redeem
   *  run's finally both execute inside one closure whose `voucherBasket` is a
   *  snapshot; guards (duplicate / MAX per run) and the outcome report must
   *  see the CURRENT rows. Kept in sync by every setVoucherBasket below. */
  const voucherBasketRef = useRef<VoucherBasketRow[]>([]);
  const updateBasket = (fn: (rows: VoucherBasketRow[]) => VoucherBasketRow[]) =>
    setVoucherBasket((rows) => {
      const next = fn(rows);
      voucherBasketRef.current = next;
      return next;
    });
  /** The claim being fulfilled RIGHT NOW (we dispense strictly one at a time,
   *  because the reader holds one card at a time). Present = that voucher is
   *  spent unless we release it. */
  const voucherClaimRef = useRef<{ code: string; txnId: string; groupId: string } | null>(null);
  /** Guards scans + taps against re-entry. */
  const voucherBusyRef = useRef(false);
  const setBasketRow = (code: string, patch: Partial<VoucherBasketRow>) =>
    updateBasket((rows) => rows.map((r) => (r.code === code ? { ...r, ...patch } : r)));

  // Onsite card-system status chip (staff-facing, guest-benign). Asks OUR
  // server about the ONSITE proxy for this center — not the old on-prem bridge
  // on 127.0.0.1, whose health describes a different path (the EIS socket,
  // which cannot consolidate or clear) and so says nothing about whether the
  // real-time card system is serving us.
  //
  // centerCodeFor(...) is called INSIDE the effect on purpose: `locationCode`
  // is declared further down this component, and referencing it here would be
  // a temporal-dead-zone error at render.
  const [onsiteStatus, setOnsiteStatus] = useState<OnsiteChipStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const s = await onsiteHealth(centerCodeFor(center, brand));
      if (!cancelled) setOnsiteStatus(s);
    };
    void check();
    const id = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [center, brand]);
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

  // Consolidation (CLOUD ONLY — gated on bridgeUp===false): combine several
  // cards' balances onto one target card, one source at a time. The target is
  // read + returned; each source is moved server-side (/api/game-cards/consolidate)
  // then binned. consoBusy pauses the idle watchdog during the (up-to-30s) reads.
  const [consoStep, setConsoStep] = useState<ConsoStep>("target");
  const [consoTarget, setConsoTarget] = useState<{
    account: string;
    tokens: number;
    bonusTokens: number;
    eTickets: number;
    timeMinutes: number;
  } | null>(null);
  const [consoSources, setConsoSources] = useState<
    Array<{ account: string; tokens: number; bonusTokens: number }>
  >([]);
  const [consoBusy, setConsoBusy] = useState(false);
  // TRUE only while a card is actually being processed (read → move → bin) —
  // a few seconds. consoBusy alone covered the WHOLE cycle including the 30s
  // wait-for-insert, which kept Done/Back disabled almost permanently and
  // showed "Combining…" while merely waiting (owner 2026-07-23: "people keep
  // getting stuck — need a way to exit and click done").
  const [consoCombining, setConsoCombining] = useState(false);
  // Cancel generation: Done/Back bump this so an in-flight wait/read bails
  // silently (returning any held card) instead of writing stale state.
  const consoRunRef = useRef(0);
  const [consoMsg, setConsoMsg] = useState<string | null>(null);
  // HALT: a service/transport failure STOPS the auto-accept loop and shows the
  // real reason + a "Try again" tap. Without this the loop re-armed straight
  // into the same failure forever — 30s gate wait, error, gate reopens (live
  // 2026-07-23: "it just resets and keeps waiting for a card").
  const [consoHalted, setConsoHalted] = useState<string | null>(null);
  // Backend availability probe (null = checking). The Combine button only
  // shows when a card backend is actually configured for this center — an
  // unconfigured backend must never dead-end a guest mid-flow. No longer
  // conditioned on the transport: consolidate runs onsite OR cloud, so the
  // probe runs on every kiosk (owner 2026-08-31).
  const [consoAvailable, setConsoAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!GC_CONSOLIDATE_LIVE) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/game-cards/consolidate?locationCode=${locationCode}`, {
          signal: AbortSignal.timeout(6_000),
        });
        const data = (await res.json().catch(() => null)) as {
          available?: boolean;
          reason?: string;
        } | null;
        if (cancelled) return;
        setConsoAvailable(data?.available === true);
        if (data?.available !== true) {
          console.warn(`[kiosk] Combine cards hidden: ${data?.reason ?? "probe failed"}`);
        }
      } catch {
        if (!cancelled) setConsoAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locationCode]);

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
    cartHasItems && onAddToVisit && kioskGzCartEnabled() && config?.readerId ? onAddToVisit : null;

  // Recoverable-fault hold: the flow pauses on a full-screen hold overlay until
  // staff resume. `holdRef` carries the promise resolver the dispense loop
  // awaits (true = resume + retry the same card, false = give up → attendant).
  const [holdFault, setHoldFault] = useState<HoldFault | null>(null);
  const holdRef = useRef<{ resolve: (resume: boolean) => void; reinit: boolean } | null>(null);
  const [reloadPending, setReloadPending] = useState(false);
  // Voucher run on a swipe kiosk: the leg currently waiting for a swipe (the
  // step guide renders instead of the loader) + the last swipe's verdict.
  const [swipeWait, setSwipeWait] = useState<{
    n: number;
    total: number;
    checking: boolean;
    note: string | null;
  } | null>(null);

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

  // When leaving reload/consolidate (both accept cards at the gate), stop the
  // gate from accepting more.
  useEffect(() => {
    if (mode !== "reload" && mode !== "consolidate") return;
    return () => {
      if (dispenser.ready) void dispenser.stopAccepting();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Pause the idle watchdog while the dispenser is working, holding, or in the
  // middle of a consolidate read/move (consoBusy).
  useEffect(() => {
    onBusyChange?.(
      phase === "loading" ||
        phase === "paying" ||
        holdFault != null ||
        consoBusy ||
        // A voucher redemption is a live dispense — never reset a guest mid-run.
        voucherPhase === "checking" ||
        voucherPhase === "dispensing",
    );
  }, [phase, holdFault, consoBusy, voucherPhase, onBusyChange]);

  // Card-error beacon: report each hold fault to the parent exactly once, by
  // instance — a re-render (or the parent closing the beacon) must not re-raise
  // it, but a NEW fault after this one resolves must. The ref tracks which
  // fault object has already been reported; null-fault resets it.
  const reportedFaultRef = useRef<HoldFault | null>(null);
  useEffect(() => {
    if (!holdFault) {
      reportedFaultRef.current = null;
      return;
    }
    if (reportedFaultRef.current !== holdFault) {
      reportedFaultRef.current = holdFault;
      onCardFault?.();
    }
  }, [holdFault, onCardFault]);

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
  /** Pay / Add-to-visit may arm: a dispenser kiosk needs the CRT connected with
   *  stock; a swipe kiosk needs EVERY row to hold a verified blank. */
  const newReady =
    capability === "swipe"
      ? newCards.length > 0 && newCards.every((c) => !!c.account && c.blankStatus === "blank")
      : readerReady && dispenser.stacker !== "empty";
  /** Purchase lines for the new-card cart. On a swipe kiosk each carries the
   *  account the guest swiped, so the ledger row is persisted WITH it before
   *  any money moves (persist-first: a browser death after the charge leaves a
   *  row the reconcile cron can still credit). */
  const newCardItems = () =>
    newCards.map((c) => ({
      packageId: c.packageId,
      ...(capability === "swipe" && c.account ? { accountNumber: c.account } : {}),
    }));
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
        // A CONFIRMED no-such-account is a blank (swipe kiosks offer to set it
        // up as a new card); anything else is a failed lookup — try again.
        setCard(i, { status: confirmedNotFound(res.ok, data) ? "notfound" : "bad" });
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

  // Return a held card to the guest — but ONLY when one is actually in the
  // machine. The read screens auto-arm the gate hands-free (no tap); when nobody
  // inserts a card, acceptAndRead times out and an UNCONDITIONAL present() then
  // issues a MOVE with nothing to hand back — which on this unit can push a card
  // out the front with no user action (the "randomly spits out a blank card
  // after sitting" report). Gate present() on real card presence. Fail SAFE: if
  // the status read is unavailable we present anyway, so a genuinely-inserted
  // (but unreadable) card is NEVER stranded inside — returning the guest's card
  // always wins over avoiding a spurious eject.
  const presentIfCardPresent = async () => {
    const s = await dispenser.getStatusNow();
    if (!s || s.card !== "none") await dispenser.present();
  };

  // RELOAD read: insert a card → the reader reads its account and returns it
  // (always — never captures a guest's card), then we verify to show balance.
  // acceptAndRead closes the entry gate before we present, so the unit can't
  // auto-swallow the returned card (the "it takes it" bug).
  const readReloadCard = async (i: number) => {
    const r = await dispenser.acceptAndRead({ timeoutMs: 30_000 });
    await presentIfCardPresent(); // hand back a real card; never eject on a no-card timeout
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
        setBalCard({
          accountNumber: acct,
          status: confirmedNotFound(res.ok, data) ? "notfound" : "bad",
        });
      }
    } catch {
      setBalCard({ accountNumber: acct, status: "bad" });
    }
  };
  // A card scanned on an entry screen: land it exactly where an MSR swipe
  // would (balance check, lookup already running). Ref-guarded so a StrictMode
  // double-mount doesn't fire two lookups; `balTyped` mirrors the swipe path so
  // the account shows in the field.
  const seededCardRef = useRef(false);
  useEffect(() => {
    if (seededCardRef.current || !initialCardAccount) return;
    seededCardRef.current = true;
    // The `mode` initializer above covers a card that is present at MOUNT (the
    // attract screen, which routes here). Scanning on the CHOOSER opens this
    // screen and delivers the card in the same batch, so that path is covered
    // too — but the mode must not depend on the host getting that ordering
    // right, because a card arriving one render late would leave the guest
    // staring at the Game Zone menu with their balance loaded behind it (owner
    // 2026-08-28). A seeded card means the balance screen, whenever it lands.
    if (!initialVoucherCodes?.length) setMode("balance");
    // RESOLVE FIRST. The entry classifier cannot decode an Intercard shortlink
    // (`icardinc.net/<code>` carries no number), so it hands the whole URL
    // through as the "account". Feeding that to /verify fails its digits-only
    // schema, and the guest was told "we couldn't check that card" for a
    // perfectly good scan (owner 2026-08-28). accountFromScan returns a bare
    // number untouched and follows the shortlink only when it has to.
    setBalCard({ accountNumber: "", status: "checking" });
    void (async () => {
      const acct = await accountFromScan(initialCardAccount);
      if (!acct) {
        setBalCard({ accountNumber: initialCardAccount, status: "bad" });
        return;
      }
      setBalTyped(acct);
      await fetchBalance(acct);
    })();
    // fetchBalance is redefined every render; the ref guard is the real gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCardAccount]);

  const readBalanceCard = async () => {
    setBalCard({ accountNumber: "", status: "reading" });
    const r = await dispenser.acceptAndRead({ timeoutMs: 30_000 });
    await presentIfCardPresent(); // give a real card straight back; never eject on a no-card timeout
    if (!r.ok) {
      if (++autoReadFailsRef.current >= MAX_AUTO_READ_FAILS) setAutoReadBlocked(true);
      setBalCard(null); // dispenser.error banner explains what happened
      return;
    }
    autoReadFailsRef.current = 0;
    setAutoReadBlocked(false);
    await fetchBalance(r.value);
  };

  // ── Swipe kiosks: is a swiped card a BLANK we may sell as new? ──────────────
  // The lookup + verdict live in service/swiped-card.ts (shared with the
  // confirmation screen), so both screens read the same card the same way.

  /** Look up the swiped account for new-card row `i` and record the verdict. */
  const verifySwipedRow = async (i: number, acct: string) => {
    setNewCardAt(i, { account: acct, blankStatus: "checking", existingTokens: undefined });
    const r = await classifySwipedAccount(acct, locationCode);
    setNewCardAt(
      i,
      r.cls === "active"
        ? { blankStatus: "active", existingTokens: r.tokens }
        : { blankStatus: r.cls },
    );
  };

  /** A swipe while the NEW-CARD cart is up. Target: the expanded row IF it is
   *  still waiting for its card (no account yet, or its last swipe was refused);
   *  else the first such row; else (every row already holds a verified blank) a
   *  NEW row — swiping the next blank is how a family adds the next card. A
   *  verified row is never silently replaced by a later swipe (Remove + re-swipe
   *  swaps one). One lookup in flight at a time, so a double swipe can't report
   *  card B's verdict against card A's number. */
  const swipeNewCard = async (acct: string) => {
    if (newCards.some((c) => c.blankStatus === "checking")) return;
    const waiting = (c: NewCard) => c.blankStatus !== "blank";
    const expanded =
      newEditIdx != null && newEditIdx < newCards.length ? newCards[newEditIdx] : undefined;
    let target = expanded && waiting(expanded) ? (newEditIdx as number) : -1;
    if (target < 0) target = newCards.findIndex(waiting);
    const duplicate = newCards.some((c, idx) => idx !== target && c.account === acct);
    if (target < 0) {
      if (duplicate || newCards.length >= 10) return; // already in the order / cart full
      target = newCards.length;
      setNewCards((cs) => [...cs, { packageId: TOKEN_PACKAGES[1].id }]);
      setNewEditIdx(target);
    }
    if (duplicate) {
      setNewCardAt(target, { blankStatus: "duplicate" });
      return;
    }
    await verifySwipedRow(target, acct);
  };

  /**
   * "Set up this card": a card presented ON the reload or balance screen that
   * Intercard has never seen is a BLANK — carry it into the new-card cart and
   * RE-VERIFY it there under the cart's own rule (the balance lookup's verdict
   * is not trusted twice). An untouched default cart is replaced; a cart
   * already holding swiped cards gains a row, or, if full, is simply shown.
   *
   * Reachable only from a card the guest PRESENTS here. A scan on the attract
   * screen can no longer land an unknown card on these screens at all (the
   * router verifies before it navigates) and the voucher page refuses cards —
   * which is what "don't set a new card up off a scan" actually needed, not
   * removing this (owner 2026-08-29: "on the reload page, if we scan a new card
   * we should recognize as a new card and move them to the new card flow").
   */
  const setUpSwipedCard = (acct: string, fromReloadIdx?: number) => {
    // The card LEAVES the cart it came from — the exact mirror of "Reload this
    // card instead", which empties the new-card row it moves. Skipping this
    // leaves the same blank sitting in the reload cart as a permanent "not
    // found" row for the guest to find on the way back.
    if (fromReloadIdx != null) {
      removeCard(fromReloadIdx);
      setReloadEditIdx(null);
    }
    setBalCard(null);
    setBalTyped("");
    setMode("newcard");
    const keep = newCards.some((c) => c.account);
    if (keep && newCards.length >= 10) {
      setNewEditIdx(null);
      return;
    }
    const fresh: NewCard = {
      packageId: TOKEN_PACKAGES[1].id,
      account: acct,
      blankStatus: "checking",
    };
    const next = keep ? [...newCards, fresh] : [fresh];
    const idx = next.length - 1;
    setNewCards(next);
    setNewEditIdx(idx);
    void verifySwipedRow(idx, acct);
  };

  /**
   * Send a card the balance/reload lookup could not find to the RELOAD cart,
   * pre-filled. The dispenser counterpart of "Set up this card": on a kiosk
   * whose new cards come out of the STACKER, offering to "set up" the card in
   * the guest's hand is meaningless — a fresh blank is dispensed, not adopted.
   * Reload is where that card belongs, and inserting it there re-reads it
   * properly (owner 2026-08-28: "shouldn't happen on a card dispenser
   * connected — should go to reload").
   */
  const reloadFoundCard = (acct: string) => {
    setCards([{ accountNumber: acct, packageId: TOKEN_PACKAGES[1].id, status: "unverified" }]);
    setReloadEditIdx(0);
    setBalCard(null);
    setBalTyped("");
    setMode("reload");
    void verify(0, acct);
  };

  /** "Reload this card instead": the card swiped as NEW already carries value
   *  — hand it to the reload cart pre-filled and verify it there. */
  const reloadSwipedInstead = (i: number) => {
    const c = newCards[i];
    if (!c?.account) return;
    const acct = c.account;
    setNewCardAt(i, { account: undefined, blankStatus: undefined, existingTokens: undefined });
    setCards([{ accountNumber: acct, packageId: c.packageId, status: "unverified" }]);
    setReloadEditIdx(0);
    setMode("reload");
    void verify(0, acct);
  };

  // Serial-swipe MSR (capability "swipe" — kiosks WITHOUT a dispenser): a raw
  // COM swipe reader instead of the CRT-591 — each swipe streams
  // `;6283=<acct>?` (see useSerialMsr.ts). A valid swipe lands wherever the
  // screen is waiting for a card: an imperative run awaiting one (the voucher
  // basket), the expanded reload row, the balance check, or the new-card cart
  // (swipe kiosks sell new cards by having the guest swipe a blank BEFORE
  // paying — owner 2026-08-28). A kiosk has a dispenser OR an MSR, never both
  // (dispenser wins in gameZoneCapability).
  const msrActive = capability === "swipe" && !!config?.msrEnabled;
  const [msrBadSwipe, setMsrBadSwipe] = useState(false);
  // ONE waiter for the component's life (lazy state, never re-created; a
  // StrictMode remount reuses it). `feed` runs FIRST so a run awaiting a
  // swipe is never starved by the reactive routing below.
  const [swipeWaiter] = useState(createSwipeWaiter);
  /**
   * A card number has arrived — SWIPED on the MSR or SCANNED off the card's QR
   * / barcode. Both are the same act ("here is my card"), so they land in the
   * same place: an imperative run awaiting one (the voucher basket), the
   * expanded reload row, the balance check, or the new-card cart.
   */
  const routeCardNumber = (acct: string) => {
    if (swipeWaiter.feed(acct)) return;
    if (phase !== "cart") return; // never mid-payment/loading
    setMsrBadSwipe(false);
    if (mode === "balance") {
      setBalTyped(acct);
      void fetchBalance(acct);
    } else if (mode === "reload" && reloadEditIdx != null) {
      setCard(reloadEditIdx, { accountNumber: acct, status: "unverified" });
      void verify(reloadEditIdx, acct);
    } else if (mode === "newcard") {
      void swipeNewCard(acct);
    }
  };
  const onMsrSwipe = routeCardNumber;
  const msr = useSerialMsr({
    // Hold the port ONLY while a card can matter here. The pay screen's
    // gift-card capture (msrUse "both") needs the same reader, and one COM
    // port opens once — a hook that is done listening must let go.
    enabled: msrActive && phase === "cart",
    portInfo: config?.msrPortInfo ?? null,
    baud: config?.msrBaud ?? null,
    onSwipe: onMsrSwipe,
    onBadSwipe: () => setMsrBadSwipe(true),
  });
  const msrListening = msrActive && msr.connection.state === "listening";
  /** This kiosk can put a NEW card in the guest's hand right now — the
   *  dispenser is connected, or the swipe reader is listening. */
  const canIssue = readerReady || msrListening;
  // A pending swipe wait belongs to the voucher run: leaving voucher mode, or
  // the whole screen, ends it (the awaiting code treats that as a cancel).
  useEffect(() => {
    if (mode !== "voucher") swipeWaiter.cancel();
  }, [mode, swipeWaiter]);
  useEffect(() => () => swipeWaiter.cancel(), [swipeWaiter]);

  // AUTO-ARM the card slot (owner 2026-07-18: "guest should never have to push
  // a button to insert a card"): whenever a screen is WAITING on a card — the
  // balance screen with none read yet, or the expanded reload row with no
  // account — open the gate ourselves. acceptAndRead times out after 30s (and
  // the gate closes after every read), so this re-arms on a 400ms debounce;
  // dispenser.busy guards double-arming and the cleanup cancels stale arms.
  // Placed AFTER the read handlers so the closure never references them
  // before declaration; still above every early return (hooks order safe).
  useEffect(() => {
    if (!readerReady || dispenser.busy || phase !== "cart") return;
    const armBalance = mode === "balance" && !balCard && !autoReadBlocked;
    const reloadRow = mode === "reload" && reloadEditIdx != null ? cards[reloadEditIdx] : undefined;
    const armReload =
      !!reloadRow &&
      !reloadRow.accountNumber.trim() &&
      reloadRow.status === "unverified" &&
      !autoReadBlocked;
    // Consolidate auto-accepts cards continuously (owner: don't make the guest
    // press a button for every card — keep accepting until they press Done). The
    // target is a single read; then each source is read + moved and the effect
    // re-arms. Timeouts are EXPECTED here (the guest is choosing cards), so this
    // is NOT bounded by autoReadBlocked — it re-arms until Done (consoStep→done)
    // or the bin fills. consoBusy guards the server round-trip between reads;
    // consoHalted stops the loop dead after a service failure (Try again resumes).
    const armConsoTarget =
      mode === "consolidate" &&
      consoStep === "target" &&
      !consoTarget &&
      !consoBusy &&
      !consoHalted;
    const armConsoSource =
      mode === "consolidate" &&
      consoStep === "sources" &&
      !!consoTarget &&
      !consoBusy &&
      !consoHalted;
    if (!armBalance && !armReload && !armConsoTarget && !armConsoSource) return;
    const t = setTimeout(() => {
      if (armBalance) void readBalanceCard();
      else if (armReload && reloadEditIdx != null) void readReloadCard(reloadEditIdx);
      else if (armConsoTarget) void consoReadTarget();
      else if (armConsoSource) void readConsoSource();
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    readerReady,
    dispenser.busy,
    phase,
    mode,
    balCard,
    reloadEditIdx,
    cards,
    autoReadBlocked,
    consoStep,
    consoTarget,
    consoBusy,
    consoSources,
    consoHalted,
  ]);

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
    // it before we charge (bail → stay on the cart, nothing charged). Swipe
    // kiosks have no bin.
    if (capability === "full" && !(await holdIfBinFull())) return;
    setPhase("loading");
    setError(null);
    setDispenseMsg(t("gamezone.processingPayment"));
    try {
      const res = await fetch("/api/game-cards/purchase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "new_card",
          locationCode,
          items: newCardItems(),
          cardNonce,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false || !Array.isArray(data.rows)) {
        setError(errText(data) || t("gamezone.err.paymentFailedDesk"));
        setPhase("error");
        return;
      }
      // Seed each card with its charged ledger row, then dispense sequentially.
      setNewCards((cs) =>
        cs.map((c, i) => ({ ...c, txnId: data.rows[i]?.txnId, cardStatus: "pending" as const })),
      );
      await fulfillNewCards(data.groupId, data.rows);
    } catch {
      setError(t("gamezone.err.paymentFailedRetry"));
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

  // ── Comp-voucher redemption (no money leg) ─────────────────────────────────
  // Reuses the SAME rail as a paid new card — holdIfBinFull, dispenseAndRead,
  // captureSafely, the bridge-then-SOAP credit, and the reconcile cron behind it
  // — so there is exactly one dispense implementation to trust. The only
  // difference is what authorises the load: a held voucher claim instead of a
  // Square charge.

  /** Give the code back. ONLY legal while NO card has left the stacker. */
  const releaseVoucherClaim = async (reason: string) => {
    const claim = voucherClaimRef.current;
    if (claim) console.warn(`[kiosk] gz voucher claim RELEASED: ${claim.code} — ${reason}`);
    if (!claim) return;
    voucherClaimRef.current = null;
    try {
      await fetch("/api/game-cards/voucher-redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "release",
          code: claim.code,
          txnId: claim.txnId,
          reason,
        }),
      });
    } catch {
      // Best-effort: an unreleased claim strands ONE voucher (recoverable by
      // staff), whereas a released-but-dispensed one gives away a second card.
      // Failing to release is the safe direction.
    }
  };

  /**
   * Dispense + credit ONE comped card. Pre-dispense bails RELEASE that voucher
   * so the guest can try again; once a blank has physically moved, the claim
   * STANDS even on failure (the ledger row is pending and the cron drives it
   * forward — releasing there would hand out a second card for one voucher).
   *
   * Returns whether THIS card made it. A failure is per-row: the run continues
   * with the next voucher rather than abandoning cards the guest is owed.
   */
  const dispenseVoucherCard = async (claim: {
    code: string;
    txnId: string;
    groupId: string;
    grant: RedeemedGrant;
  }): Promise<boolean> => {
    let blanksBad = 0;

    for (;;) {
      // Nowhere to reject a bad blank → hold before feeding one.
      if (!(await holdIfBinFull())) {
        await releaseVoucherClaim("bin full, nothing dispensed");
        return failRow(claim.code, t("gamezone.seeAttendantSafe"));
      }
      const r = await dispenser.dispenseAndRead();
      if (r.ok) {
        // A card is OUT. Past this line the voucher stays spent.
        return await creditVoucherCard(claim, r.value);
      }
      const f = r.fault;
      if (f.kind === "hold") {
        const resumed = await holdUntilResolved(f);
        if (!resumed) {
          await releaseVoucherClaim("dispenser hold, nothing dispensed");
          return failRow(claim.code, t("gamezone.seeAttendantSafe"));
        }
        continue; // staff cleared it — same voucher, try again
      }
      if (f.kind === "card-retry") {
        // Unreadable blank: bin it and take the next one. Bounded so wrong-way
        // stock can't feed the whole stacker through one card at a time.
        if (!(await captureSafely())) {
          await releaseVoucherClaim("could not bin an unreadable blank");
          return failRow(claim.code, t("gamezone.seeAttendantSafe"));
        }
        if (++blanksBad >= MAX_BAD_BLANKS) {
          const resumed = await holdUntilResolved(BAD_READ_HOLD);
          if (!resumed) {
            await releaseVoucherClaim("card stock unreadable");
            return failRow(claim.code, t("gamezone.seeAttendantSafe"));
          }
          blanksBad = 0;
        }
        continue;
      }
      await releaseVoucherClaim("dispenser fault, nothing dispensed");
      return failRow(
        claim.code,
        f.kind === "abort" ? f.message : `${r.info.message}. ${t("gamezone.seeAttendantSafe")}`,
      );
    }
  };

  /** Mark one basket row failed and keep the run going. */
  const failRow = (code: string, message: string): boolean => {
    setBasketRow(code, { status: "failed", error: message });
    return false;
  };

  /** Credit the dispensed blank, then present it. Never releases the claim. */
  const creditVoucherCard = async (
    claim: { code: string; txnId: string; groupId: string; grant: RedeemedGrant },
    account: string,
    /** `swiped`: the blank is a guest-swiped card (swipe kiosk) — already in
     *  their hand, never cleared server-side, nothing to present or retain. */
    opts: { swiped?: boolean } = {},
  ): Promise<boolean> => {
    setDispenseMsg(t("gamezone.voucher.loading"));
    // The server credits through the Intercard router (onsite first, cloud SOAP
    // fallback). The on-prem EIS bridge that used to pre-load here is retired:
    // the onsite proxy reaches the same site card system and, unlike the EIS
    // socket, also handles bonus cash / clear / consolidate.
    let loaded = false;
    try {
      const res = await fetch("/api/game-cards/load-card", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          groupId: claim.groupId,
          txnId: claim.txnId,
          accountNumber: account,
          locationCode,

          swiped: !!opts.swiped,
        }),
      });
      const data = await res.json().catch(() => ({}));
      loaded = res.ok && data.loaded === true;
    } catch {
      loaded = false;
    }

    if (!loaded) {
      if (opts.swiped) {
        // The card is already in the guest's hand — nothing to retain. The row
        // is pending WITH its account, so the reconcile cron finishes the
        // credit; the voucher stays spent. Tell them to keep the card.
        return failRow(claim.code, t("gamezone.swipe.voucher.loadPending"));
      }
      // Don't hand over an empty card — bin it. The row stays pending and the
      // reconcile cron recovers the credit; the voucher stays spent, so staff
      // (not the guest) resolve it.
      await captureSafely();
      return failRow(
        claim.code,
        `${t("gamezone.err.cardRetained")} ${t("gamezone.seeAttendantSafe")}`,
      );
    }

    console.log(
      `[kiosk] gz voucher fulfilled: ${claim.code} → card #${displayCardNumber(account)}${opts.swiped ? " (swiped)" : ""}`,
    );
    setBasketRow(claim.code, { status: "loaded", cardNumber: displayCardNumber(account) });
    if (!opts.swiped) {
      setDispenseMsg(t("gamezone.voucher.takeCard"));
      await dispenser.present();
      await dispenser.waitTaken({ timeoutMs: 30_000 });
    }
    voucherClaimRef.current = null; // fulfilled
    return true;
  };

  /**
   * SWIPE kiosk, voucher run: wait for the guest to swipe a BLANK for card `n`
   * of `total` — the shared loop (service/swiped-card.ts): bounded and
   * Cancel-able, nothing is claimed while it waits, so ending it costs nobody
   * anything; a card with value, one already used this run, or one we couldn't
   * check re-prompts with a note. Its state drives the swipe panel below.
   */
  const waitForBlank = (n: number, total: number, used: ReadonlySet<string>) =>
    acquireBlankBySwipe({
      waiter: swipeWaiter,
      locationCode,
      used,
      t,
      onState: (s) =>
        setSwipeWait(
          s.phase === "idle"
            ? null
            : {
                n,
                total,
                checking: s.phase === "checking",
                note: s.phase === "waiting" ? s.note : null,
              },
        ),
    });

  /**
   * SCAN → add to the basket. Validates only (see validateNativeVoucher): a
   * guest still deciding must never have a code burned, and two kiosks can both
   * validate the same voucher — the atomic claim at dispense time picks the
   * winner, not whoever scanned first. Returns the added row (the seed effect
   * auto-redeems only when every handed-over code validated), null otherwise.
   */
  const addVoucherToBasket = async (raw: string): Promise<VoucherBasketRow | null> => {
    if (voucherBusyRef.current || voucherPhase !== "entry") return null;
    const code = classifyKioskCode(raw).value;
    if (!code) return null;
    // Guards read the REF, not the render snapshot: the seed loop adds several
    // codes inside one closure, where `voucherBasket` is frozen at [] and the
    // duplicate/cap checks would never trip.
    if (voucherBasketRef.current.some((r) => r.code === code)) {
      setVoucherMsg(t("gamezone.voucher.err.alreadyAdded"));
      return null;
    }
    if (voucherBasketRef.current.length >= MAX_VOUCHERS_PER_RUN) {
      setVoucherMsg(t("gamezone.voucher.err.tooMany", { n: MAX_VOUCHERS_PER_RUN }));
      return null;
    }
    voucherBusyRef.current = true;
    setVoucherMsg(null);
    try {
      const res = await fetch("/api/game-cards/voucher-redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // locationCode + center ride along so a BMI comp can be peeked against
        // the right tenant; native validation ignores them.
        body: JSON.stringify({ action: "validate", code, locationCode, center: config?.center }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
        label?: string;
        items?: { redeemVia?: string }[];
      };
      if (!res.ok || data.ok !== true) {
        console.warn(
          `[kiosk] gz voucher refused at validate: ${code} — ${data.reason ?? `http-${res.status}`}`,
        );
        setVoucherMsg(t(VOUCHER_REFUSAL_KEY[data.reason ?? ""] ?? "gamezone.voucher.err.generic"));
        return null;
      }
      // How many cards this code is owed: native validate lists every unspent
      // leg; a BMI comp (no items array) is always exactly one card. Floor of 1
      // keeps a cart-only voucher on today's path (the claim refuses it with
      // the right message).
      const gzCount = Math.max(
        1,
        (data.items ?? []).filter((i) => i.redeemVia === "gamezone").length,
      );
      console.log(
        `[kiosk] gz voucher validated: ${code} (${data.label ?? "?"}) — ${gzCount} card leg(s)`,
      );
      const row = { code, label: data.label ?? "", gzCount, issued: 0, status: "ready" as const };
      updateBasket((rows) => [...rows, row]);
      return row;
    } catch {
      setVoucherMsg(t("gamezone.voucher.err.generic"));
      return null;
    } finally {
      voucherBusyRef.current = false;
    }
  };

  const removeFromBasket = (code: string) =>
    updateBasket((rows) => rows.filter((r) => r.code !== code));

  /**
   * "Get my cards" — claim + dispense + credit every card leg of every voucher
   * in turn. A code carrying several game-card legs (the VIP combo voucher:
   * one leg per guest) gets ONE claim PER LEG in the SAME run — the server
   * spends a single leg per claim, and making the guest re-enter the flow for
   * each remaining card was the 2026-08-01 "keeps asking me to continue" bug.
   *
   * STRICTLY SEQUENTIAL: the reader holds one card at a time, so the next
   * claim is never taken until the current card is in the guest's hand or
   * safely binned. A failure is PER ROW — the run keeps going, because a guest
   * with three vouchers is owed three cards and abandoning the rest over one bad
   * blank is the wrong call. Each claim is taken immediately before its
   * dispense, so an abandoned basket leaves nothing spent.
   */
  const redeemBasket = async (queueOverride?: VoucherBasketRow[]) => {
    // `queueOverride` = rows the seed effect JUST added; otherwise read the
    // ref so a click closure can't act on a stale snapshot.
    const source = queueOverride ?? voucherBasketRef.current;
    if (voucherBusyRef.current || source.length === 0) return;
    voucherBusyRef.current = true;
    setVoucherMsg(null);
    setVoucherPhase("dispensing");
    // Outcomes for THIS run only, one entry per attempted card leg — the flow
    // clears one pending leg per loaded entry, so re-reporting a prior run's
    // rows would over-clear the guest's remaining cards.
    const runOutcomes: { code: string; loaded: boolean }[] = [];
    // Swipe kiosk: accounts loaded THIS run (a re-swipe of the same blank must
    // not credit it twice) and why the run stopped early, if it did.
    const runAccounts = new Set<string>();
    let stopped: "cancelled" | "timeout" | null = null;
    try {
      const queue = source.filter((r) => r.status === "ready" || r.status === "failed");
      const totalCards = queue.reduce((s, r) => s + Math.max(1, r.gzCount) - r.issued, 0);
      let cardNo = 0;
      run: for (const row of queue) {
        const legsOwed = Math.max(1, row.gzCount) - row.issued;
        if (legsOwed <= 0) continue;
        setBasketRow(row.code, { status: "dispensing", error: undefined });
        let issued = row.issued;
        for (let leg = 0; leg < legsOwed; leg++) {
          cardNo++;
          setDispenseMsg(
            capability === "swipe"
              ? t("gamezone.voucher.checking")
              : totalCards > 1
                ? t("gamezone.voucher.dispensingN", { n: cardNo, total: totalCards })
                : t("gamezone.voucher.dispensing"),
          );

          // SWIPE kiosk: the blank comes FIRST. Nothing is claimed until a
          // verified blank is in the guest's hand, so a Cancel or a timeout
          // costs nothing and leaves every code intact for a retry.
          let swipedAccount: string | null = null;
          if (capability === "swipe") {
            const got = await waitForBlank(cardNo, totalCards, runAccounts);
            if (!got.ok) {
              stopped = got.why;
              setBasketRow(row.code, { status: "ready", error: undefined });
              break run;
            }
            swipedAccount = got.account;
          }

          // Claim HERE, not at scan time — one claim per CARD.
          let claimed: { txnId: string; groupId: string; grant: RedeemedGrant } | null = null;
          let refusedUsed = false;
          try {
            const res = await fetch("/api/game-cards/voucher-redeem", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "claim",
                code: row.code,
                locationCode,
                center: config?.center,
                kioskId: config ? kioskDeviceKey(config) : undefined,
                // Swipe kiosk: the blank already in hand rides the claim, so
                // the comped row is persisted WITH its card (persist-first) —
                // a load that never reaches the server still leaves a row
                // the reconcile cron can credit.
                accountNumber: swipedAccount ?? undefined,
              }),
            });
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean;
              reason?: string;
              txnId?: string;
              groupId?: string;
              grant?: RedeemedGrant;
              label?: string;
            };
            if (res.ok && data.ok === true && data.txnId && data.groupId && data.grant) {
              claimed = {
                txnId: data.txnId,
                groupId: data.groupId,
                grant: { ...data.grant, label: data.label ?? data.grant.label ?? row.label },
              };
            } else {
              console.warn(
                `[kiosk] gz voucher CLAIM refused: ${row.code} — ${data.reason ?? `http-${res.status}`}`,
              );
              refusedUsed = data.reason === "used";
              failRow(
                row.code,
                t(VOUCHER_REFUSAL_KEY[data.reason ?? ""] ?? "gamezone.voucher.err.generic"),
              );
            }
          } catch (err) {
            console.warn(`[kiosk] gz voucher claim network failure: ${row.code}`, err);
            failRow(row.code, t("gamezone.voucher.err.generic"));
          }
          if (!claimed) {
            // "used" AFTER cards already came out = server truth says the code
            // is exhausted (our scan-time count raced another redemption) —
            // the dispensed cards stand, so the row is done, not failed.
            if (refusedUsed && issued > 0) {
              setBasketRow(row.code, { status: "loaded", error: undefined });
            } else {
              runOutcomes.push({ code: row.code, loaded: false });
            }
            break; // a refused claim repeats for every remaining leg — next row
          }

          voucherClaimRef.current = {
            code: row.code,
            txnId: claimed.txnId,
            groupId: claimed.groupId,
          };
          const ok = swipedAccount
            ? await creditVoucherCard({ code: row.code, ...claimed }, swipedAccount, {
                swiped: true,
              })
            : await dispenseVoucherCard({ code: row.code, ...claimed });
          voucherClaimRef.current = null;
          // A claim was taken against this blank — loaded OR pending (the cron
          // finishes a pending credit onto it) — so it is spoken for: the next
          // leg must not accept the same card again.
          if (swipedAccount) runAccounts.add(swipedAccount);
          runOutcomes.push({ code: row.code, loaded: ok });
          if (!ok) break; // dispenseVoucherCard already failed the row — next row
          issued++;
          // creditVoucherCard flipped the row to `loaded` — keep it "dispensing"
          // while this code still owes cards so the list never reads finished
          // mid-run.
          setBasketRow(
            row.code,
            issued < Math.max(1, row.gzCount) ? { issued, status: "dispensing" } : { issued },
          );
        }
      }
    } finally {
      voucherBusyRef.current = false;
      setDispenseMsg(null);
      // The screen reports per row, so land on `done` whenever anything worked
      // and only on `error` when NOTHING did. The outcome callback lets the
      // flow drop DISPENSED legs from its pending list (failed ones stay —
      // their claims were released, so the way back must stay open). Read the
      // REF — calling the parent inside a state updater ran it during render
      // (and twice under StrictMode).
      const rows = voucherBasketRef.current;
      const anyLoaded = rows.some((r) => r.status === "loaded");
      if (stopped) {
        // The swipe wait ended (Cancel / timeout). Nothing issued → back to the
        // basket, codes intact; some cards issued → the done screen, but SAY
        // the run stopped early so a half-issued code isn't read as finished.
        setVoucherMsg(
          t(stopped === "timeout" ? "gamezone.swipe.timedOut" : "gamezone.swipe.cancelled"),
        );
        setVoucherPhase(anyLoaded ? "done" : "entry");
      } else {
        setVoucherPhase(anyLoaded ? "done" : "error");
      }
      onVoucherOutcome?.(runOutcomes);
    }
  };

  /**
   * Scanner inputs. ONE reader instance for the whole screen, dispatched by
   * mode — not one per surface: `useQrScanner` connects on first enable and
   * only releases the COM port on unmount, so a second instance would find the
   * port taken and silently never listen.
   *
   * Voucher mode feeds the basket. Every other card surface (balance, reload,
   * new card) feeds `routeCardNumber` — the SAME place a swipe lands, because
   * scanning the card and swiping it are the same act (owner 2026-08-28: "both
   * the QR and the barcode on the card should work"). The card's 1D barcode is
   * the bare account number and decodes locally; its QR is an Intercard
   * shortlink that reveals nothing until followed, so `accountFromScan` hands
   * that one to /api/game-cards/resolve-scan. A payload that resolves to no
   * account is left alone — it was not a card.
   */
  const voucherScanArmed = mode === "voucher" && voucherPhase === "entry";
  const cardScanArmed =
    phase === "cart" && (mode === "balance" || mode === "reload" || mode === "newcard");
  const scanArmed = voucherScanArmed || cardScanArmed;
  const onScanPayload = (payload: string) => {
    if (mode === "voucher") {
      if (voucherScanArmed) void addVoucherToBasket(payload);
      return;
    }
    if (!cardScanArmed) return;
    void (async () => {
      const acct = await accountFromScan(payload);
      if (acct) routeCardNumber(acct);
    })();
  };
  useQrScanner({
    enabled: scanArmed && !!config?.qrScannerEnabled,
    modelId: config?.qrScannerModel,
    baudRate: config?.qrScannerBaud ?? null,
    portInfo: config?.qrScannerPortInfo ?? null,
    allowLoneGrantFallback: false,
    // Held in a ref by the hook, so this inline closure always sees live state.
    onScan: (scan) => onScanPayload(scan.payload),
  });
  const scanWedge = useWedgeScan(onScanPayload);
  const scanWedgeArm = scanWedge.arm;
  useEffect(() => {
    if (!scanArmed || !config?.scannerEnabled) return;
    scanWedgeArm();
    const id = setInterval(scanWedgeArm, 8_000);
    return () => clearInterval(id);
  }, [scanArmed, config?.scannerEnabled, scanWedgeArm]);

  // Codes handed over from the coupon screen join the basket on arrival — the
  // guest already scanned them once. When EVERY handed-over code validates,
  // dispense immediately: the guest already tapped "Get my cards & continue"
  // over there, and making them read a second basket screen with a second
  // identical button was the 2026-07-30 "total mess" complaint. Any code that
  // fails to validate keeps the basket screen up instead (the message says
  // which and why; nothing is claimed). Runs once per seeded set.
  const seededVoucherRef = useRef<string | null>(null);
  useEffect(() => {
    const seed = initialVoucherCodes ?? [];
    if (seed.length === 0 || !canIssue) return;
    const key = seed.join(",");
    if (seededVoucherRef.current === key) return;
    seededVoucherRef.current = key;
    console.log(`[kiosk] gz voucher seed from coupon receipt: ${seed.length} code(s)`);
    void (async () => {
      const rows: VoucherBasketRow[] = [];
      for (const c of seed) {
        const row = await addVoucherToBasket(c);
        if (row) rows.push(row);
      }
      if (rows.length === seed.length && rows.length > 0) {
        console.log(`[kiosk] gz voucher seed all valid → dispensing ${rows.length} card(s)`);
        await redeemBasket(rows);
      } else {
        console.warn(
          `[kiosk] gz voucher seed: only ${rows.length}/${seed.length} validated — staying on basket screen`,
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialVoucherCodes, canIssue]);

  // A claim still held when the guest walks away (mode change or the whole Game
  // Zone closing) is given back rather than burned — `voucherClaimRef` is
  // cleared the moment a card is fulfilled or deliberately kept, so anything
  // still here means no card reached anyone.
  useEffect(() => {
    if (mode === "voucher") return;
    if (voucherClaimRef.current) void releaseVoucherClaim("left voucher mode");
  }, [mode]);
  useEffect(() => {
    return () => {
      if (voucherClaimRef.current) void releaseVoucherClaim("game zone closed");
    };
  }, []);

  // ── Consolidation (cloud-only) ──────────────────────────────────────────────
  // Read the TARGET card and hand it straight back (it's the survivor). Balance
  // is read via /verify for display; the move happens per-source below.
  const consoReadTarget = async () => {
    if (consoBusy || !readerReady) return;
    const run = consoRunRef.current;
    setConsoBusy(true);
    setConsoMsg(null);
    try {
      const r = await dispenser.acceptAndRead({ timeoutMs: 30_000 });
      await presentIfCardPresent(); // return a real card; never eject on a no-card timeout
      // Guest tapped Back while we waited — bail without touching state.
      if (consoRunRef.current !== run) return;
      if (!r.ok) {
        // No card inserted (auto-arm timeout) or unreadable — stay on the insert
        // prompt and re-arm; no scary message while the guest is still deciding.
        return;
      }
      const account = r.value;
      setConsoCombining(true); // brief: the balance lookup for the display
      let tokens = 0;
      let bonusTokens = 0;
      let eTickets = 0;
      let timeMinutes = 0;
      try {
        const res = await fetch("/api/game-cards/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountNumber: account, locationCode }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json();
        const bal = data.balance ?? data;
        tokens = bal.tokens ?? 0;
        bonusTokens = bal.bonusTokens ?? 0;
        eTickets = bal.eTickets ?? 0;
        timeMinutes = bal.timeMinutes ?? 0;
      } catch {
        /* balance is display-only; the move re-reads server-side */
      }
      if (consoRunRef.current !== run) return;
      setConsoTarget({ account, tokens, bonusTokens, eTickets, timeMinutes });
      setConsoSources([]);
      setConsoStep("sources");
    } finally {
      setConsoCombining(false);
      setConsoBusy(false);
    }
  };

  // Auto-armed SOURCE read (owner: keep accepting cards until Done — no button
  // per card). Read the next inserted card and move ALL its value onto the
  // target (atomic, server-side, cloud). Bin the source ONLY on a confirmed
  // move; return it on a decline/ambiguous outcome (never bin unconfirmed); a
  // no-card timeout just re-arms silently so the guest can keep feeding cards.
  const readConsoSource = async () => {
    if (consoBusy || !consoTarget) return;
    const run = consoRunRef.current;
    // Set busy FIRST so the auto-arm effect can't re-enter this (and stack bin
    // holds) while holdIfBinFull is awaiting a staff resume.
    setConsoBusy(true);
    try {
      // Need bin room before we consume a source into it.
      if (!(await holdIfBinFull())) {
        if (consoRunRef.current === run) setConsoMsg(t("gamezone.seeAttendant"));
        return;
      }
      if (consoRunRef.current !== run) return; // Done/Back tapped while holding
      const r = await dispenser.acceptAndRead({ timeoutMs: 30_000 });
      // Done/Back tapped while we waited for an insert — hand back anything
      // that was read and bail without touching state (the guest moved on).
      if (consoRunRef.current !== run) {
        if (r.ok) await presentIfCardPresent();
        return;
      }
      if (!r.ok) {
        // No card inserted (timeout) or unreadable — return any real card and
        // wait for the next one. No message on an idle timeout (expected).
        await presentIfCardPresent();
        return;
      }
      const source = r.value;
      // A card is in hand — NOW we're combining (loader + Done/Back briefly
      // disabled; this section is seconds, not the 30s insert wait).
      setConsoCombining(true);
      if (source === consoTarget.account || consoSources.some((s) => s.account === source)) {
        await dispenser.present();
        setConsoMsg(t("gamezone.conso.sameCard"));
        return;
      }
      // The guest's card is HELD during this call — the timeout must be tight
      // (server-side SOAP attempts are 8s ×2 + verify reads; 20s covers them).
      const res = await fetch("/api/game-cards/consolidate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          locationCode,
          targetAccount: consoTarget.account,
          sourceAccount: source,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json().catch(() => ({}));
      // Done/Back tapped mid-move: if the value DID move, the source is drained —
      // bin it (best-effort) so an empty card isn't handed back as if loaded;
      // otherwise return the untouched card. Either way, no stale state writes.
      if (consoRunRef.current !== run) {
        if (res.ok && data.ok) await captureSafely();
        else await presentIfCardPresent();
        return;
      }
      if (res.ok && data.ok) {
        // Value is on the target → safe to bin the emptied source.
        if (!(await captureSafely())) {
          setConsoMsg(t("gamezone.seeAttendant"));
          return;
        }
        const movedTokens = data.moved?.tokens ?? 0;
        const movedBonus = data.moved?.bonusTokens ?? 0;
        setConsoSources((prev) => [
          ...prev,
          { account: source, tokens: movedTokens, bonusTokens: movedBonus },
        ]);
        if (data.targetBalance) {
          setConsoTarget((t) =>
            t
              ? {
                  ...t,
                  tokens: data.targetBalance.tokens ?? t.tokens,
                  bonusTokens: data.targetBalance.bonusTokens ?? t.bonusTokens,
                  eTickets: data.targetBalance.eTickets ?? t.eTickets,
                  timeMinutes: data.targetBalance.timeMinutes ?? t.timeMinutes,
                }
              : t,
          );
        }
        setConsoMsg(null);
        // Bin full now → the run is over (owner: "until the bin is full").
        if ((await dispenser.getBinState()) === "full") setConsoStep("done");
      } else if (data.outcome === "declined") {
        // Clean decline for THIS card — return it, show why, keep accepting
        // other cards (the guest may just try a different one).
        await presentIfCardPresent();
        setConsoMsg(
          `${data.message || t("gamezone.conso.declined")}${data.detail ? `\n${data.detail}` : ""}`,
        );
      } else {
        // Service failure (unknown outcome / HTTP error / unconfigured): HALT
        // the auto-accept loop and show the REAL reason — retrying into the
        // same failure just eats the guest's card for 15s at a time.
        await presentIfCardPresent();
        const reason =
          data.detail ||
          data.message ||
          errText(data) ||
          t("gamezone.conso.serviceError", { status: res.status });
        setConsoHalted(reason);
      }
    } catch (err) {
      await presentIfCardPresent();
      // Guest already exited via Done/Back — don't halt a screen they left.
      if (consoRunRef.current === run) {
        setConsoHalted(
          err instanceof Error && err.name === "TimeoutError"
            ? t("gamezone.conso.timeout")
            : t("gamezone.conso.unreachable"),
        );
      }
    } finally {
      setConsoCombining(false);
      setConsoBusy(false);
    }
  };

  /** Guest exits the combine (Done / Back): cancel any in-flight wait/read and
   *  close the gate so the reader stops accepting — the exit is INSTANT even if
   *  a 30s insert wait is pending (it bails via the run generation). */
  const consoExit = () => {
    consoRunRef.current += 1;
    void dispenser.stopAccepting();
  };

  const consoReset = () => {
    consoRunRef.current += 1;
    setConsoStep("target");
    setConsoTarget(null);
    setConsoSources([]);
    setConsoMsg(null);
    setConsoHalted(null);
    setConsoCombining(false);
  };

  // SWIPE kiosk, after the charge: every card's account was swiped and verified
  // BEFORE payment, so this is a pure credit loop — no dispense, no bin, no
  // present, nothing to retain. A credit that doesn't confirm leaves the row
  // pending WITH its account (persist-first at prepare), so the reconcile cron
  // finishes it and the guest KEEPS the card; the run continues with the next
  // card rather than aborting a basket the guest has already paid for.
  const loadSwipedNewCards = async (
    groupId: string,
    rows: Array<{ txnId: string; accountNumber?: string }>,
  ) => {
    for (let i = 0; i < newCards.length; i++) {
      const txnId = rows[i]?.txnId;
      if (!txnId) break;
      // The account came back on the charged row (persisted at prepare from the
      // swipe); the cart copy is the same value.
      const account = rows[i]?.accountNumber || newCards[i]?.account;
      if (!account) {
        // Can't happen (Pay arms only on verified blanks) — never credit blind,
        // and make the impossible loud rather than a quiet failed row.
        console.error(`[kiosk] swipe new-card row ${i + 1} has no account (txn ${txnId})`);
        setNewCardAt(i, { cardStatus: "failed" });
        continue;
      }
      setNewCardAt(i, { account, cardStatus: "pending" });
      setDispenseMsg(t("gamezone.loadingOntoCard", { n: i + 1 }));
      // The server credits through the Intercard router (onsite first, cloud
      // SOAP fallback). `swiped` tells the server this card is the guest's
      // choice: never clear-on-encode it.
      let loaded = false;
      let balanceTokens: number | undefined;
      try {
        const res = await fetch("/api/game-cards/load-card", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            groupId,
            txnId,
            accountNumber: account,
            locationCode,

            swiped: true,
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
      } else {
        setNewCardAt(i, { account, loaded: false, cardStatus: "failed" });
      }
    }
    setDispenseMsg(null);
    setPhase("done");
  };

  // Fulfil the charged rows on this kiosk's rail. DISPENSER: dispense → read →
  // load → present, ONE card at a time. Faults are handled by category: a
  // recoverable "hold" (out of cards, jam, bin) pauses on the hold overlay and,
  // on staff resume, retries the SAME card; a bad blank is captured and
  // re-dispensed, but only up to MAX_BAD_BLANKS in a row — then it holds for
  // staff too (wrong-way stock); a dead-end aborts (money safe, rows pending).
  const fulfillNewCards = async (
    groupId: string,
    rows: Array<{ txnId: string; accountNumber?: string }>,
  ) => {
    if (capability === "swipe") return loadSwipedNewCards(groupId, rows);
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
      if (!(await holdIfBinFull())) return abort(i, t("gamezone.seeAttendantSafe"));
      setNewCardAt(i, { cardStatus: "dispensing" });
      setDispenseMsg(t("gamezone.dispensingCardN", { n: i + 1, total: newCards.length }));

      const r = await dispenser.dispenseAndRead();
      if (!r.ok) {
        const f = r.fault;
        if (f.kind === "hold") {
          const resumed = await holdUntilResolved(f);
          if (!resumed) return abort(i, t("gamezone.seeAttendantSafe"));
          i--; // retry the same paid card once the fault is cleared
          continue;
        }
        if (f.kind === "card-retry") {
          // Unreadable blank (e.g. loaded facing the wrong way) — bin it to the
          // error bin. A lone misfeed clears on the next card; too many in a row
          // means the stock is wrong-way, so HOLD for staff instead of feeding
          // the whole stacker through one card at a time.
          if (!(await captureSafely())) return abort(i, t("gamezone.seeAttendantSafe"));
          if (++blanksBad >= MAX_BAD_BLANKS) {
            const resumed = await holdUntilResolved(BAD_READ_HOLD);
            if (!resumed) return abort(i, t("gamezone.seeAttendantSafe"));
            blanksBad = 0; // staff fixed the stock — start the count fresh
          }
          i--;
          continue;
        }
        return abort(
          i,
          f.kind === "abort" ? f.message : `${r.info.message}. ${t("gamezone.seeAttendantSafe")}`,
        );
      }
      const account = r.value;

      // Stale/duplicate read guard — bin this blank and re-dispense rather than
      // credit an account we already loaded this session. Same bounded-then-hold
      // guard so a run of bad reads can't drain the stacker.
      if (usedAccounts.has(account)) {
        if (!(await captureSafely())) return abort(i, t("gamezone.seeAttendantSafe"));
        if (++blanksBad >= MAX_BAD_BLANKS) {
          const resumed = await holdUntilResolved(BAD_READ_HOLD);
          if (!resumed) {
            return abort(i, `${t("gamezone.err.cleanRead")} ${t("gamezone.seeAttendantSafe")}`);
          }
          blanksBad = 0;
        }
        i--;
        continue;
      }
      blanksBad = 0;
      usedAccounts.add(account);

      setDispenseMsg(t("gamezone.loadingOntoCard", { n: i + 1 }));
      let loaded = false;
      let balanceTokens: number | undefined;
      // The server credits through the Intercard router (onsite first, cloud
      // SOAP fallback) — the on-prem EIS bridge is retired.
      try {
        const res = await fetch("/api/game-cards/load-card", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            groupId,
            txnId,
            accountNumber: account,
            locationCode,
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
        setDispenseMsg(t("gamezone.takeCardN", { n: i + 1 }));
        await dispenser.present();
        await dispenser.waitTaken({ timeoutMs: 30_000 });
      } else {
        // Don't hand over an unloaded blank — bin it; row recovers forward.
        // captureSafely holds for staff if the bin is full (never binned into a
        // full bin); either way the guest gets the money-safe attendant message.
        setNewCardAt(i, { account, loaded: false, cardStatus: "failed" });
        await captureSafely();
        setError(`${t("gamezone.err.cardRetained")} ${t("gamezone.seeAttendantSafe")}`);
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
        setError(errText(data) || t("gamezone.err.reloadFailedDesk"));
        setPhase("error");
        return;
      }
      setPhase("done");
    } catch {
      setError(t("gamezone.err.reloadFailedRetry"));
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
    if (kind === "new_card" && capability === "full" && !(await holdIfBinFull())) {
      throw new Error(t("gamezone.seeAttendantSafe"));
    }
    const items =
      kind === "new_card"
        ? newCardItems()
        : cards.map((c) => ({ accountNumber: c.accountNumber.trim(), packageId: c.packageId }));
    const res = await fetch("/api/game-cards/terminal-prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, locationCode, items }),
    });
    const data = await res.json();
    if (!res.ok || !data.orderId || !(data.totalCents > 0)) {
      throw new Error(errText(data) || t("gamezone.err.startReader"));
    }
    readerPrep.current = data;
    return {
      seed: data.groupId,
      depositOrderId: data.orderId,
      depositCents: data.totalCents,
      // The session secret the gift-card routes require; `ambient` switches
      // the shared pay screen to scan/swipe-anything mode, same as every cart.
      ...(data.splitToken ? { splitToken: data.splitToken } : {}),
      ...(data.ambient ? { ambient: true } : {}),
    };
  };

  // reload via the reader: after the charge, credit each already-charged card
  // through /load-card, which routes to Intercard (onsite first, cloud SOAP
  // fallback). A failed report leaves the row pending for the reconcile cron —
  // never a double-credit.
  const loadReloadViaBridge = async (
    groupId: string,
    rows: Array<{ txnId: string; accountNumber: string; tokens: number; bonusTokens: number }>,
  ) => {
    let anyPending = false;
    for (const r of rows) {
      try {
        const res = await fetch("/api/game-cards/load-card", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            groupId,
            txnId: r.txnId,
            accountNumber: r.accountNumber,
            locationCode,
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
    ep: { paymentId: string; paymentIds?: string[]; depositOrderId: string; amountCents: number },
  ) => {
    const prep = readerPrep.current;
    if (!prep) {
      setError(t("gamezone.err.sessionExpired"));
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
            // Split checkout (gift card + tap): finalize verifies the SUM.
            ...(ep.paymentIds && ep.paymentIds.length > 0 ? { paymentIds: ep.paymentIds } : {}),
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        // Money is ALREADY captured on the reader — never imply "pay again".
        setError(errText(data) || t("gamezone.err.paidNotFinished"));
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
        await fulfillNewCards(data.groupId, data.rows ?? []);
      } else {
        // reload: cards are already in the guest's hand — load each on the on-prem
        // bridge, then report through /load-card (owner: kiosk reload uses the
        // bridge, not SOAP).
        await loadReloadViaBridge(data.groupId, data.rows ?? []);
      }
    } catch {
      setError(t("gamezone.err.paidNotFinished"));
      setPhase("error");
    }
  };

  // ── Dispenser offline & couldn't reconnect: disable Game Zone entirely ──
  // No dispenser → can't dispense → don't sell or offer it. Highest priority.
  if (dispenser.unavailable) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center kiosk-zoom">
        <div className="font-heading text-5xl font-extrabold italic text-amber-300">
          {t("gamezone.unavailable.title")}
        </div>
        <p className="mt-5 text-lg text-white/65">{t("gamezone.unavailable.body")}</p>
        <button
          type="button"
          onClick={onExit}
          className="font-heading mt-10 h-16 w-full rounded-full bg-[#00e2e5] text-xl font-extrabold uppercase italic text-[#04252b]"
        >
          {t("gamezone.back")}
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
          label={t("gamezone.connecting.label")}
          sublabel={t("gamezone.connecting.sub")}
        />
      </div>
    );
  }

  // ── Mode chooser: New card vs Reload vs Balance ──
  if (mode === "choose") {
    // New cards need a way to put a card in the guest's hand — the dispenser
    // connected, or the swipe reader listening (canIssue). Until then the tile
    // stays visible but greyed, saying which device it is waiting on.
    return (
      // Center the chooser vertically in the flow body — min-h-full keeps it
      // centered when it fits and lets it scroll if it ever overflows (owner
      // 2026-07-21: chooser sat too high).
      <div className="flex min-h-full w-full flex-col justify-center">
        <div className="mb-[32px] flex items-center justify-between">
          <h1 className="k-display text-[74px]">{t("gamezone.chooser.title")}</h1>
          <button
            type="button"
            onClick={onExit}
            className="rounded-full border border-white/15 px-[28px] py-[12px] text-[24px] text-white/60"
          >
            {t("gamezone.cancel")}
          </button>
        </div>
        <div className="grid gap-[24px]">
          <button
            type="button"
            disabled={!canIssue}
            onClick={() => setMode("newcard")}
            className="k-glass k-tap p-[40px] text-left disabled:opacity-40"
            style={{ borderLeft: "8px solid #f800c6" }}
          >
            <div className="k-display text-[48px]">{t("gamezone.chooser.new.title")}</div>
            <div className="mt-[10px] text-[28px] text-white/55">
              {capability === "swipe"
                ? msrListening
                  ? t("gamezone.swipe.chooser.new.ready")
                  : msr.connection.state === "error"
                    ? t("gamezone.swipe.readerOffline")
                    : t("gamezone.connectingReader")
                : readerReady
                  ? t("gamezone.chooser.new.ready")
                  : dispenser.reconnecting
                    ? t("gamezone.connecting.label")
                    : t("gamezone.chooser.new.offline")}
            </div>
          </button>
          <button
            type="button"
            onClick={() => setMode("reload")}
            className="k-glass k-tap p-[40px] text-left"
            style={{ borderLeft: "8px solid #00e2e5" }}
          >
            <div className="k-display text-[48px]">{t("gamezone.chooser.reload.title")}</div>
            <div className="mt-[10px] text-[28px] text-white/55">
              {t("gamezone.chooser.reload.sub")}
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
            <div className="k-display text-[48px]">{t("gamezone.chooser.balance.title")}</div>
            <div className="mt-[10px] text-[28px] text-white/55">
              {/* MSR kiosks swipe; dispenser kiosks insert. */}
              {capability === "swipe"
                ? t("gamezone.chooser.balance.subSwipe")
                : t("gamezone.chooser.balance.subInsert")}
            </div>
          </button>
          {/* Redeem a comp voucher — needs a way to hand over a card (the
              dispenser, or a swiped blank) but NOT a cart, a booking or a
              payment: a guest can walk up holding only the voucher (owner
              2026-07-29). Flag defaults ON. */}
          {kioskVoucherGzEnabled() && canIssue && (
            <button
              type="button"
              onClick={() => {
                // A basket abandoned MID-ENTRY (guest tapped Back) comes back
                // intact — wiping it forced a full re-scan (owner 2026-07-30:
                // "back out … then no way to return"). Only a finished or
                // never-started run starts clean.
                if (voucherPhase !== "entry" || voucherBasket.length === 0) {
                  setVoucherPhase("entry");
                  updateBasket(() => []);
                }
                setVoucherTyped("");
                setVoucherMsg(null);
                setMode("voucher");
              }}
              className="k-glass k-tap p-[40px] text-left"
              style={{ borderLeft: "8px solid #e8b14c" }}
            >
              <div className="k-display text-[48px]">{t("gamezone.chooser.voucher.title")}</div>
              <div className="mt-[10px] text-[28px] text-white/55">
                {t("gamezone.chooser.voucher.sub")}
              </div>
            </button>
          )}
          {/* Combine cards — ANY TRANSPORT. Was cloud-only while consolidate
              existed solely as a cloud SOAP op; the onsite proxy has
              `consolidatecards`, so the bridgeUp===false gate is gone (owner
              2026-08-31) and the button shows on every kiosk. Still needs the
              reader (it accepts + bins the source cards) and a configured
              backend for this center.
              Re-enabled (owner 2026-07-23): the old NEXT_PUBLIC_GC_CONSOLIDATE_DISABLED
              env kill-switch was dropped so a stale Vercel var can't keep the
              button dark — GC_CONSOLIDATE_LIVE (top of file) is the one switch. */}
          {GC_CONSOLIDATE_LIVE && readerReady && consoAvailable === true && (
            <button
              type="button"
              onClick={() => {
                consoReset();
                setMode("consolidate");
              }}
              className="k-glass k-tap p-[40px] text-left"
              style={{ borderLeft: "8px solid #b39dff" }}
            >
              <div className="k-display text-[48px]">{t("gamezone.combineCards")}</div>
              <div className="mt-[10px] text-[28px] text-white/55">
                {t("gamezone.chooser.combine.sub")}
              </div>
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Redeem a comp voucher: scan → claim → dispense → credit → present ──
  if (mode === "voucher") {
    return (
      <div className="mx-auto flex h-full max-w-2xl flex-col px-2 py-6 kiosk-zoom">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="font-heading text-4xl font-extrabold italic">
            {t("gamezone.voucher.title")}
          </h1>
          {/* Never offer Back mid-dispense — a card is in motion. */}
          {voucherPhase !== "dispensing" && voucherPhase !== "checking" && (
            <button
              type="button"
              onClick={() => setMode("choose")}
              className="k-tap rounded-full border border-white/15 px-5 py-2 text-sm text-white/60"
            >
              {t("gamezone.back")}
            </button>
          )}
        </div>

        {voucherPhase === "entry" && (
          <div className="flex min-h-0 flex-1 flex-col items-center text-center">
            <h2 className="font-heading text-4xl font-extrabold italic leading-tight">
              {voucherBasket.length === 0
                ? t("gamezone.voucher.scanTitle")
                : t("gamezone.voucher.scanMoreTitle")}
            </h2>
            <p className="mt-2 max-w-xl text-xl text-white/60">
              {capability === "swipe"
                ? t("gamezone.swipe.voucher.scanBody")
                : t("gamezone.voucher.scanBody")}
            </p>

            {/* The basket. Scan as many as they're holding, then one tap. */}
            {voucherBasket.length > 0 && (
              <ul className="mt-5 w-full space-y-2 text-left">
                {voucherBasket.map((row) => (
                  <li
                    key={row.code}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-white/15 bg-white/[0.04] px-5 py-3"
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-lg tracking-[0.08em] text-white/90">
                        {row.code}
                      </div>
                      <div className="text-sm text-[#46d68c]">
                        {row.gzCount > 1
                          ? `${row.label} · ${t("gamezone.voucher.cardsOnCode", { n: row.gzCount })}`
                          : row.label}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFromBasket(row.code)}
                      aria-label={t("gamezone.remove")}
                      className="k-tap shrink-0 rounded-full border border-white/20 px-4 py-2 text-sm text-white/60"
                    >
                      {t("gamezone.remove")}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-5">
              <CardSlotGuide
                label={t("gamezone.voucher.scanLabel")}
                sublabel={t("gamezone.voucher.scanSub")}
              />
            </div>

            <div
              className="mt-4 min-h-[36px] text-lg text-[#ff8c7a]"
              role="alert"
              aria-live="polite"
            >
              {voucherMsg ?? ""}
            </div>

            {/* Typed fallback — the OnScreenKeyboardHost attaches to this. */}
            <input
              type="text"
              value={voucherTyped}
              onChange={(e) => {
                setVoucherMsg(null);
                setVoucherTyped(e.target.value.toUpperCase());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && voucherTyped.trim()) {
                  void addVoucherToBasket(voucherTyped);
                  setVoucherTyped("");
                }
              }}
              aria-label={t("gamezone.voucher.inputLabel")}
              placeholder={t("gamezone.voucher.placeholder")}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="k-num h-[80px] w-full rounded-[20px] border-2 border-[rgba(232,177,76,0.55)] bg-[#040d24] px-6 font-mono text-[30px] uppercase tracking-[0.08em] text-white placeholder:text-white/30 focus:outline-none"
            />
            <div className="mt-3 flex w-full gap-3">
              <button
                type="button"
                onClick={() => {
                  void addVoucherToBasket(voucherTyped);
                  setVoucherTyped("");
                }}
                disabled={!voucherTyped.trim()}
                className="k-tap flex-1 rounded-full border border-white/20 px-5 py-4 text-lg text-white/80 disabled:opacity-40"
              >
                {t("gamezone.voucher.add")}
              </button>
              {/* Everything in the basket is a CARD voucher, so one tap
                  dispenses them all. When cart-bound items (race, laser) become
                  redeemable this is where the copy splits — see
                  tasks/gamezone-voucher-plan.md. */}
              <button
                type="button"
                onClick={() => void redeemBasket()}
                disabled={voucherBasket.length === 0}
                className="k-tap flex-1 rounded-full bg-[#e8b14c] px-5 py-4 text-lg font-extrabold text-[#231703] disabled:opacity-40"
              >
                {(() => {
                  // Count CARDS, not codes — one VIP voucher can owe a whole
                  // family's cards.
                  const n = voucherBasket.reduce(
                    (s, r) => s + Math.max(1, r.gzCount) - r.issued,
                    0,
                  );
                  return n > 1
                    ? t("gamezone.voucher.getCards", { n })
                    : t("gamezone.voucher.getCard");
                })()}
              </button>
            </div>
          </div>
        )}

        {(voucherPhase === "checking" || voucherPhase === "dispensing") && (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {swipeWait ? (
              // Swipe kiosk: this leg is waiting for the guest to swipe a blank.
              // Nothing is claimed yet, so Cancel is free; the wait is bounded.
              <SwipeBlankGuide
                step={swipeWait.checking ? "checking" : "wait"}
                label={
                  swipeWait.total > 1
                    ? t("gamezone.swipe.legN", { n: swipeWait.n, total: swipeWait.total })
                    : t("gamezone.swipe.voucher.swipeTitle")
                }
                sublabel={swipeWait.total > 1 ? t("gamezone.swipe.voucher.swipeTitle") : undefined}
                listening={msrListening}
                note={swipeWait.note}
                onCancel={swipeWait.checking ? undefined : () => swipeWaiter.cancel()}
              />
            ) : (
              <BrandedLoader
                brand={brand}
                label={
                  voucherPhase === "checking"
                    ? t("gamezone.voucher.checking")
                    : (dispenseMsg ?? t("gamezone.voucher.dispensing"))
                }
                sublabel={t("gamezone.voucher.checkingSub")}
              />
            )}
          </div>
        )}

        {(voucherPhase === "done" || voucherPhase === "error") && (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-center">
            {voucherBasket.some((r) => r.status === "loaded") ? (
              <>
                <div className="font-heading text-5xl font-extrabold italic text-[#46d68c]">
                  {t("gamezone.voucher.done.title")}
                </div>
                <p className="mt-3 text-2xl text-white/75">
                  {t("gamezone.voucher.done.bodyN", {
                    // CARDS handed over, not codes — a VIP voucher is several.
                    n: voucherBasket.reduce((s, r) => s + r.issued, 0),
                  })}
                </p>
              </>
            ) : (
              <div className="font-heading text-4xl font-extrabold italic text-amber-300">
                {t("gamezone.voucher.error.title")}
              </div>
            )}

            {/* A run that stopped early (swipe Cancel / timeout) says so here —
                the rows below would otherwise read as a finished basket. */}
            {voucherMsg && (
              <p className="mt-3 text-lg text-amber-200" role="alert">
                {voucherMsg}
              </p>
            )}

            {/* Per-row outcome. A partial run must show WHICH card is missing —
                "something went wrong" would leave the guest guessing. */}
            <ul className="mt-6 w-full space-y-2 text-left">
              {voucherBasket.map((row) => (
                <li
                  key={row.code}
                  className="rounded-2xl border border-white/15 bg-white/[0.04] px-5 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-base text-white/70">{row.code}</span>
                    <span className={row.status === "loaded" ? "text-[#46d68c]" : "text-[#ff8c7a]"}>
                      {row.status === "loaded"
                        ? row.gzCount > 1
                          ? t("gamezone.voucher.cardsIssued", { n: row.issued })
                          : row.cardNumber
                            ? t("gamezone.cardHash", { num: row.cardNumber })
                            : t("gamezone.voucher.loadedOk")
                        : row.issued > 0
                          ? t("gamezone.voucher.cardsIssued", { n: row.issued })
                          : t("gamezone.voucher.notIssued")}
                    </span>
                  </div>
                  {row.error && <div className="mt-1 text-sm text-white/55">{row.error}</div>}
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={onExit}
              className="font-heading k-tap mt-8 h-16 w-full rounded-full bg-[#00e2e5] text-xl font-extrabold uppercase italic text-[#04252b]"
            >
              {t("gamezone.done")}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Combine cards (CLOUD ONLY): move several cards' tokens onto one ──
  if (mode === "consolidate") {
    const combinedTokens = consoTarget?.tokens ?? 0;
    const combinedBonus = consoTarget?.bonusTokens ?? 0;
    const combinedETickets = consoTarget?.eTickets ?? 0;
    const combinedMinutes = consoTarget?.timeMinutes ?? 0;
    const last4 = (a: string) => `···${a.slice(-4)}`;
    return (
      <div className="mx-auto max-w-2xl px-2 py-6 kiosk-zoom">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="font-heading text-4xl font-extrabold italic">
            {t("gamezone.combineCards")}
          </h1>
          {consoStep !== "done" && (
            <button
              type="button"
              // Tappable while waiting for a card — only a live money-move
              // (seconds) disables it. Exit cancels the pending insert wait.
              disabled={consoCombining}
              onClick={() => {
                consoExit();
                setMode("choose");
              }}
              className="k-tap rounded-full border border-white/15 px-5 py-2 text-sm text-white/60 disabled:opacity-40"
            >
              {t("gamezone.back")}
            </button>
          )}
        </div>

        {dispenser.error && (
          <div className="mb-4 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-amber-100">
            {dispenser.error.message}
            {dispenser.error.hint ? ` — ${dispenser.error.hint}` : ""}
          </div>
        )}
        {consoMsg && (
          <div className="mb-4 whitespace-pre-line rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-lg text-white/80">
            {consoMsg}
          </div>
        )}

        {/* STEP 1 — read the survivor card. Hero insert animation, minimal text,
            so it's unmistakable this first card is the one they keep. */}
        {consoStep === "target" && (
          <div className="flex flex-col items-center text-center">
            <div className="mb-2 text-lg font-bold uppercase tracking-[0.2em] text-[#b39dff]">
              {t("gamezone.conso.step1")}
            </div>
            <h2 className="font-heading text-5xl font-extrabold italic leading-tight">
              {t("gamezone.conso.insertKeep.title")}
            </h2>
            <p className="mt-3 max-w-xl text-2xl text-white/60">
              {t("gamezone.conso.insertKeep.body")}
            </p>
            <div className="mt-8 flex justify-center">
              {consoCombining ? (
                <BrandedLoader
                  brand={brand}
                  label={t("gamezone.conso.reading.label")}
                  sublabel={t("gamezone.conso.reading.sub")}
                />
              ) : (
                <CardSlotGuide
                  label={t("gamezone.insertCard")}
                  sublabel={t("gamezone.insertCard.subShort")}
                />
              )}
            </div>
          </div>
        )}

        {/* STEP 2 — feed the others. A compact "keeping" chip pins the survivor
            at the top (clearly the target), then the SAME hero insert animation
            makes it obvious the next cards are being combined in. */}
        {consoStep === "sources" && consoTarget && (
          <div className="flex flex-col items-center text-center">
            <div className="mb-7 flex w-full items-center justify-between rounded-2xl border-2 border-[#b39dff]/60 bg-[#b39dff]/10 px-6 py-4 text-left">
              <div>
                <div className="text-sm font-bold uppercase tracking-[0.2em] text-[#b39dff]">
                  {t("gamezone.conso.keeping")}
                </div>
                <div className="mt-0.5 text-lg text-white/55">
                  {t("gamezone.card", { ref: last4(consoTarget.account) })}
                </div>
              </div>
              <div className="text-right">
                <div className="text-4xl font-extrabold leading-none">
                  {combinedTokens.toLocaleString()}
                </div>
                <div className="mt-1 text-sm text-white/50">
                  {t("gamezone.tokensUnit")}
                  {combinedBonus
                    ? ` + ${combinedBonus.toLocaleString()} ${t("gamezone.bonusUnit")}`
                    : ""}
                </div>
              </div>
            </div>

            <div className="text-lg font-bold uppercase tracking-[0.2em] text-[#46d68c]">
              {t("gamezone.conso.step2")}
            </div>
            <h2 className="mt-1 font-heading text-5xl font-extrabold italic leading-tight">
              {t("gamezone.conso.addTitle")}
            </h2>
            <p className="mt-3 max-w-xl text-2xl text-white/60">{t("gamezone.conso.addBody")}</p>

            <div className="mt-8 flex w-full justify-center">
              {consoHalted ? (
                /* Service failure — the loop is STOPPED. Show the real reason
                   so staff can act on it; Try again resumes accepting cards. */
                <div className="w-full rounded-2xl border border-red-400/40 bg-red-400/10 p-6 text-left">
                  <div className="text-2xl font-bold text-red-200">
                    {t("gamezone.conso.notWorking")}
                  </div>
                  <div className="mt-2 whitespace-pre-line text-lg text-red-100/80">
                    {consoHalted}
                  </div>
                  <button
                    type="button"
                    onClick={() => setConsoHalted(null)}
                    className="k-tap mt-5 w-full rounded-full bg-[#00e2e5] px-6 py-4 text-xl font-extrabold text-[#04252b]"
                  >
                    {t("gamezone.tryAgain")}
                  </button>
                </div>
              ) : consoCombining ? (
                <BrandedLoader
                  brand={brand}
                  label={t("gamezone.conso.combining.label")}
                  sublabel={t("gamezone.conso.combining.sub")}
                />
              ) : (
                <CardSlotGuide
                  label={t("gamezone.conso.insertCombine.label")}
                  sublabel={t("gamezone.conso.insertCombine.sub")}
                />
              )}
            </div>

            {consoSources.length > 0 && (
              <div className="mt-8 w-full space-y-2 text-left">
                <div className="text-sm uppercase tracking-[0.2em] text-white/40">
                  {t("gamezone.conso.combinedIn", { count: consoSources.length })}
                </div>
                {consoSources.map((s, i) => (
                  <div
                    key={s.account}
                    className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3"
                  >
                    <span className="text-lg text-white/70">
                      {t("gamezone.conso.sourceRow", { num: i + 1, ref: last4(s.account) })}
                    </span>
                    <span className="text-lg font-semibold text-white/80">
                      +{s.tokens.toLocaleString()} {t("gamezone.tokensUnit")}
                      {s.bonusTokens
                        ? ` +${s.bonusTokens.toLocaleString()} ${t("gamezone.bonusUnit")}`
                        : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              // Enabled while WAITING for a card (that's most of the time) —
              // only a live money-move (a few seconds) disables it. Exiting
              // cancels the pending insert wait, so the tap works instantly.
              disabled={consoCombining}
              onClick={() => {
                consoExit();
                setConsoStep("done");
              }}
              className="k-tap mt-8 w-full rounded-full bg-[#46d68c] px-6 py-5 text-2xl font-extrabold text-[#04252b] disabled:opacity-40"
            >
              {t("gamezone.conso.done.finished")}
            </button>
          </div>
        )}

        {consoStep === "done" && consoTarget && (
          <div className="space-y-6 text-center">
            <div className="text-6xl">✅</div>
            <p className="text-2xl text-white/70">{t("gamezone.conso.allSet")}</p>
            <div className="rounded-2xl border border-[#46d68c]/40 bg-[#46d68c]/10 p-8">
              <div className="text-sm uppercase tracking-widest text-white/50">
                {t("gamezone.card", { ref: last4(consoTarget.account) })}
              </div>
              <div className="mt-1 text-5xl font-extrabold">
                {combinedTokens.toLocaleString()} {t("gamezone.tokensUnit")}
              </div>
              {/* Everything else now on the kept card (cash / bonus cash are
                  deliberately NOT shown — owner 2026-07-24). Each stat appears
                  only when it carries a value. */}
              {(combinedBonus > 0 || combinedETickets > 0 || combinedMinutes > 0) && (
                <div className="mt-4 flex flex-wrap justify-center gap-3">
                  {combinedBonus > 0 && (
                    <div className="rounded-xl border border-white/10 bg-white/[0.04] px-5 py-3">
                      <div className="font-heading text-2xl font-extrabold tabular-nums text-[#46d68c]">
                        {combinedBonus.toLocaleString()}
                      </div>
                      <div className="mt-0.5 text-[11px] font-bold uppercase tracking-[0.2em] text-white/45">
                        {t("gamezone.stat.bonusTokens")}
                      </div>
                    </div>
                  )}
                  {combinedETickets > 0 && (
                    <div className="rounded-xl border border-white/10 bg-white/[0.04] px-5 py-3">
                      <div className="font-heading text-2xl font-extrabold tabular-nums text-[#e8b14c]">
                        {combinedETickets.toLocaleString()}
                      </div>
                      <div className="mt-0.5 text-[11px] font-bold uppercase tracking-[0.2em] text-white/45">
                        {t("gamezone.stat.eTickets")}
                      </div>
                    </div>
                  )}
                  {combinedMinutes > 0 && (
                    <div className="rounded-xl border border-white/10 bg-white/[0.04] px-5 py-3">
                      <div className="font-heading text-2xl font-extrabold tabular-nums text-white">
                        {combinedMinutes.toLocaleString()}
                      </div>
                      <div className="mt-0.5 text-[11px] font-bold uppercase tracking-[0.2em] text-white/45">
                        {t("gamezone.stat.timePlay")}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="mt-4 text-lg text-white/60">
                {t("gamezone.conso.cardsCombined", { count: consoSources.length })}
              </div>
            </div>
            <button
              type="button"
              onClick={onExit}
              className="k-glass k-tap w-full p-8 text-center text-3xl font-bold"
            >
              {t("gamezone.done")}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Balance check — ONE card at a time (owner 2026-07-18) ──
  if (mode === "balance") {
    const bal = balCard?.balance;
    return (
      <div className="mx-auto max-w-2xl px-2 py-6 kiosk-zoom">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="font-heading text-4xl font-extrabold italic">
            {t("gamezone.balance.title")}
          </h1>
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="rounded-full border border-white/15 px-5 py-2 text-sm text-white/60"
          >
            {t("gamezone.back")}
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
                label={t("gamezone.insertCard")}
                sublabel={t("gamezone.insertCard.subLeft")}
              />
            ) : (
              <BrandedLoader
                brand={brand}
                label={t("gamezone.checkingBalance")}
                sublabel={
                  balCard.accountNumber
                    ? t("gamezone.cardHash", { num: displayCardNumber(balCard.accountNumber) })
                    : undefined
                }
              />
            )}
          </div>
        ) : balCard?.status === "ok" && bal ? (
          <div className="rounded-2xl border border-[#46d68c]/40 bg-white/[0.04] p-6">
            <div className="text-sm uppercase tracking-[0.25em] text-white/45">
              {t("gamezone.cardHash", { num: displayCardNumber(balCard.accountNumber) })}
              {balCard.name ? ` · ${balCard.name}` : ""}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4">
                <div className="font-heading text-4xl font-extrabold tabular-nums text-[#00e2e5]">
                  {bal.tokens}
                </div>
                <div className="mt-1 text-xs font-bold uppercase tracking-[0.2em] text-white/45">
                  {t("gamezone.stat.tokens")}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4">
                <div className="font-heading text-4xl font-extrabold tabular-nums text-[#46d68c]">
                  {bal.bonusTokens}
                </div>
                <div className="mt-1 text-xs font-bold uppercase tracking-[0.2em] text-white/45">
                  {t("gamezone.stat.bonusTokens")}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4">
                <div className="font-heading text-4xl font-extrabold tabular-nums text-[#e8b14c]">
                  {bal.eTickets}
                </div>
                <div className="mt-1 text-xs font-bold uppercase tracking-[0.2em] text-white/45">
                  {t("gamezone.stat.eTickets")}
                </div>
              </div>
              {bal.timeMinutes > 0 && (
                <div className="rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4">
                  <div className="font-heading text-4xl font-extrabold tabular-nums text-white">
                    {bal.timeMinutes}
                  </div>
                  <div className="mt-1 text-xs font-bold uppercase tracking-[0.2em] text-white/45">
                    {t("gamezone.stat.timePlay")}
                  </div>
                </div>
              )}
            </div>
            {/* Recent activity — web /reload parity (owner 2026-07-18). */}
            {balCard.transactions && balCard.transactions.length > 0 && (
              <div className="mt-5 border-t border-white/10 pt-4">
                <div className="text-sm font-bold uppercase tracking-[0.25em] text-white/45">
                  {t("gamezone.balance.recentActivity")}
                </div>
                <ul className="mt-2 max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
                  {balCard.transactions.slice(0, 10).map((tx, i) => {
                    const tok = tx.tokens || tx.bonusTokens || 0;
                    const detail = tok
                      ? `${tok > 0 ? "+" : ""}${tok} ${t("gamezone.tokensUnit")}`
                      : tx.points
                        ? `${tx.points > 0 ? "+" : ""}${tx.points} ${t("gamezone.stat.eTickets")}`
                        : "";
                    const when = tx.timeStamp ? tx.timeStamp.slice(0, 16) : "";
                    return (
                      <li
                        key={i}
                        className="flex items-start justify-between gap-3 rounded-lg bg-white/[0.03] px-4 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-base text-white/80">
                            {tx.transType || t("gamezone.txn.activity")}
                            {tx.device ? ` · ${tx.device}` : ""}
                          </div>
                          <div className="text-sm text-white/40">
                            {tx.location || "—"}
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
                {t("gamezone.balance.checkAnother")}
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
                {t("gamezone.balance.reloadThis")}
              </button>
            </div>
          </div>
        ) : (
          <>
            {balCard?.status === "notfound" ? (
              // A card the guest PRESENTED here that Intercard has never seen.
              // On a swipe kiosk that is a blank out of the holder, so name it
              // and offer the new-card flow; on a dispenser kiosk inserting the
              // card re-reads it properly, so Reload is the one tap offered.
              //
              // Deliberately kept (owner 2026-08-29). The 8/28 rule — "don't
              // set a new card up off a scan" — is enforced where the scan
              // happens: the attract router verifies before it navigates and
              // the voucher page refuses cards outright, so an unknown card can
              // no longer ARRIVE here. Reaching this panel means the guest is
              // standing at Game Zone with a card in their hand.
              <div className="mb-4 rounded-2xl border border-amber-400/50 bg-amber-400/10 px-5 py-4 text-left">
                {msrActive ? (
                  <>
                    <div className="text-lg font-bold text-amber-200">
                      {t("gamezone.swipe.newCard.title")}
                    </div>
                    <div className="mt-1 text-base text-white/80">
                      {t("gamezone.swipe.newCard.body", {
                        num: displayCardNumber(balCard.accountNumber),
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={() => setUpSwipedCard(balCard.accountNumber)}
                      className="k-tap mt-4 w-full rounded-xl bg-[#f800c6] px-5 py-4 text-lg font-extrabold text-white"
                    >
                      {t("gamezone.swipe.newCard.setUp")}
                    </button>
                    <div className="mt-2 text-center text-sm text-white/45">
                      {t("gamezone.swipe.newCard.orSwipeAgain")}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-base text-white/85">
                      {t("gamezone.balance.notRecognised", {
                        num: displayCardNumber(balCard.accountNumber),
                      })}
                    </div>
                    {readerReady && (
                      <button
                        type="button"
                        onClick={() => reloadFoundCard(balCard.accountNumber)}
                        className="k-tap mt-3 w-full rounded-xl bg-[#00e2e5] px-5 py-4 text-lg font-bold text-[#04252b]"
                      >
                        {t("gamezone.balance.reloadThis")}
                      </button>
                    )}
                  </>
                )}
              </div>
            ) : balCard?.status === "bad" ? (
              <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-red-100">
                {msrActive ? t("gamezone.swipe.unknown") : t("gamezone.balance.notFoundInsert")}
              </div>
            ) : null}
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
                {autoReadBlocked ? t("gamezone.blockedFlip") : t("gamezone.balance.insertToCheck")}
              </button>
            ) : msrActive ? (
              // MSR kiosk: the swipe is the ONE way in — no typed entry, no
              // Check button (owner 2026-07-20). A good swipe looks up
              // immediately; the read card number shows on the result.
              <div className="space-y-2">
                <div className="w-full rounded-2xl bg-[#00e2e5] px-6 py-6 text-center text-xl font-extrabold text-[#04252b]">
                  {msrListening
                    ? t("gamezone.balance.swipeToCheck")
                    : t("gamezone.connectingReader")}
                </div>
                {msrBadSwipe && <p className="text-sm text-amber-300">{t("gamezone.badSwipe")}</p>}
              </div>
            ) : (
              // Readerless kiosk fallback only — with a dispenser or MSR, that
              // device is the one way in.
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={balTyped}
                  onChange={(e) => setBalTyped(e.target.value)}
                  placeholder={t("gamezone.cardNumberPlaceholder")}
                  className="flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-lg text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => balTyped.trim() && void fetchBalance(balTyped.trim())}
                  className="rounded-xl bg-[#00e2e5] px-5 py-2.5 text-sm font-bold text-[#04252b]"
                >
                  {t("gamezone.check")}
                </button>
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
        if (c.cardStatus === "loaded") return t("gamezone.status.loaded");
        // Swipe kiosk: a credit that didn't confirm is pending on the row (the
        // cron finishes it) — the guest keeps the card, nobody needs staff yet.
        if (c.cardStatus === "failed") {
          return capability === "swipe"
            ? t("gamezone.status.onTheWay")
            : t("gamezone.status.seeAttendant");
        }
        if (c.cardStatus === "dispensing") return t("gamezone.status.dispensing");
        if (c.account) return t("gamezone.status.loadingTokens");
        return t("gamezone.status.waiting");
      };
      return (
        <div className="mx-auto max-w-md py-10 kiosk-zoom">
          <div className="mb-6 text-center">
            <div className="font-heading text-4xl font-extrabold italic">
              {t("gamezone.settingUp", { count: newCards.length })}
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
                      {t("gamezone.cardN", { n: i + 1 })}
                    </div>
                    <div className="font-heading text-xl font-extrabold tabular-nums">
                      {c.account
                        ? displayCardNumber(c.account)
                        : capability === "swipe"
                          ? t("gamezone.status.waiting")
                          : t("gamezone.status.dispensing")}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-heading text-lg font-extrabold tabular-nums text-[#00e2e5]">
                      {toks} {t("gamezone.tkAbbrev")}
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
          label={t("gamezone.loadingTokens.label")}
          sublabel={t("gamezone.loadingTokens.sub")}
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
            {t("gamezone.cardsReady", { count: newCards.length })}
          </div>
          <p className="mt-4 text-lg text-white/60">
            {t("gamezone.tokensAcross", { tokens: newTokensTotal, count: newCards.length })}
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
                      {t("gamezone.cardN", { n: i + 1 })}
                    </div>
                    <div className="font-heading text-xl font-extrabold tabular-nums">
                      {c.account ? displayCardNumber(c.account) : "—"}
                    </div>
                  </div>
                  <div className="font-heading text-lg font-extrabold tabular-nums text-[#46d68c]">
                    {toks} {t("gamezone.tkAbbrev")}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-sm text-white/50">
            {capability === "swipe"
              ? t("gamezone.cardsReadyBody", { count: newCards.length })
              : t("gamezone.grabCards", { count: newCards.length })}
          </p>
          {/* Swipe kiosk: a credit that didn't confirm is pending on its row
              (the cron finishes it) — the guest keeps the card, say so. */}
          {capability === "swipe" && newCards.some((c) => c.cardStatus === "failed") && (
            <p className="mt-3 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-left text-sm text-amber-100">
              {t("gamezone.swipe.loadPending")}
            </p>
          )}
          <button
            type="button"
            onClick={onExit}
            className="font-heading mt-8 h-16 w-full rounded-full bg-[#00e2e5] text-xl font-extrabold uppercase italic text-[#04252b]"
          >
            {t("gamezone.done")}
          </button>
          {doneAutoCloseIn != null && (
            <p className="mt-3 text-sm text-white/40">
              {t("gamezone.closingIn", { seconds: doneAutoCloseIn })}
            </p>
          )}
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-md py-16 text-center kiosk-zoom">
        <div className="font-heading text-6xl font-extrabold italic">
          {reloadPending ? t("gamezone.paymentReceived") : t("gamezone.tokensLoaded")}
        </div>
        <p className="mt-4 text-lg text-white/60">
          {reloadPending
            ? t("gamezone.reloadPendingBody")
            : t("gamezone.cardsReadyBody", { count: cards.length })}
        </p>
        <button
          type="button"
          onClick={onExit}
          className="font-heading mt-10 h-16 w-full rounded-full bg-[#00e2e5] text-xl font-extrabold uppercase italic text-[#04252b]"
        >
          {t("gamezone.done")}
        </button>
        {doneAutoCloseIn != null && (
          <p className="mt-3 text-sm text-white/40">
            {t("gamezone.closingIn", { seconds: doneAutoCloseIn })}
          </p>
        )}
      </div>
    );
  }

  /** Swipe kiosk — the CARD half of an expanded new-card row: the two-step
   *  guide until a blank is swiped, then the verdict (new / has value / same
   *  card twice / couldn't check). */
  const swipeRowStatus = (c: NewCard, i: number) => {
    if (c.blankStatus === "checking") {
      return <SwipeBlankGuide step="checking" listening={msrListening} />;
    }
    if (c.blankStatus === "blank" && c.account) {
      return (
        <div className="rounded-xl border border-[#46d68c]/40 bg-[#46d68c]/10 px-4 py-3">
          <div className="text-base font-bold text-[#46d68c]">
            {t("gamezone.swipe.blankOk", { num: displayCardNumber(c.account) })}
          </div>
          <div className="mt-0.5 text-sm text-white/50">{t("gamezone.swipe.swipeMoreToAdd")}</div>
        </div>
      );
    }
    if (c.blankStatus === "active" && c.account) {
      return (
        <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3">
          <div className="text-base font-bold text-red-200">{t("gamezone.swipe.active.title")}</div>
          <div className="mt-0.5 text-sm text-red-100/80">
            {c.existingTokens
              ? t("gamezone.swipe.active.body", {
                  num: displayCardNumber(c.account),
                  n: c.existingTokens,
                })
              : t("gamezone.swipe.active.bodyUsed", { num: displayCardNumber(c.account) })}
          </div>
          <button
            type="button"
            onClick={() => reloadSwipedInstead(i)}
            className="k-tap mt-3 w-full rounded-xl bg-[#00e2e5] px-4 py-3 text-base font-bold text-[#04252b]"
          >
            {t("gamezone.swipe.reloadInstead")}
          </button>
          <div className="mt-2 text-center text-sm text-white/50">
            {t("gamezone.swipe.replace")}
          </div>
        </div>
      );
    }
    return (
      <SwipeBlankGuide
        step="wait"
        listening={msrListening}
        note={
          c.blankStatus === "duplicate"
            ? t("gamezone.swipe.duplicate")
            : c.blankStatus === "unknown"
              ? t("gamezone.swipe.unknown")
              : null
        }
      />
    );
  };

  // ── New cards — add 1–10 cards, pick a package each, "pay & dispense" ──
  if (mode === "newcard" && phase === "cart") {
    return (
      <div className="mx-auto max-w-2xl px-2 py-6 kiosk-zoom">
        <div className="mb-5 flex items-center justify-between">
          <span className="flex items-center gap-4">
            <h1 className="font-heading text-4xl font-extrabold italic">
              {t("gamezone.newCards.title")}
            </h1>
            <BridgeChip status={onsiteStatus} />
          </span>
          <button
            type="button"
            onClick={() => setMode("choose")}
            className="rounded-full border border-white/15 px-5 py-2 text-sm text-white/60"
          >
            {t("gamezone.back")}
          </button>
        </div>
        <p className="mb-5 text-white/55">
          {capability === "swipe"
            ? t("gamezone.swipe.newCards.intro")
            : t("gamezone.newCards.intro")}
        </p>

        <div className="space-y-4">
          {newCards.map((c, i) => {
            const expanded = newEditIdx === i;
            return (
              <div key={i} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <div className="flex items-center justify-between">
                  <span className="font-heading text-lg font-extrabold italic">
                    {t("gamezone.cardN", { n: i + 1 })}
                  </span>
                  <div className="flex items-center gap-4">
                    {!expanded && (
                      <button
                        type="button"
                        onClick={() => setNewEditIdx(i)}
                        className="text-sm font-bold text-[#00e2e5]"
                      >
                        {t("gamezone.edit")}
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
                        {t("gamezone.remove")}
                      </button>
                    )}
                  </div>
                </div>
                {expanded ? (
                  <>
                    {/* Swipe kiosk: the card itself comes first — take a blank
                        from the holder and swipe it; the package grid follows. */}
                    {capability === "swipe" && <div className="mt-3">{swipeRowStatus(c, i)}</div>}
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {/* Checkout-upsell specials never show on the standalone grids. */}
                      {TOKEN_PACKAGES.filter((p) => !p.upsell).map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setNewCard(i, { packageId: p.id });
                            // Collapse after picking — unless this row still
                            // needs its swipe (keep it open so the guide shows).
                            if (capability !== "swipe" || c.blankStatus === "blank") {
                              setNewEditIdx(null);
                            }
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
                    {capability === "swipe" && (
                      <>
                        {c.account && c.blankStatus === "blank"
                          ? `#${displayCardNumber(c.account)}`
                          : t("gamezone.noCardNumber")}
                        {" · "}
                      </>
                    )}
                    {pkgLabel(t, c.packageId)}
                    {capability === "swipe" &&
                      (c.blankStatus === "blank" ? (
                        <span className="text-[#46d68c]"> · ✓</span>
                      ) : (
                        <span className="text-[#f0b341]"> · {t("gamezone.swipe.needsSwipe")}</span>
                      ))}
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
            {t("gamezone.addAnotherCard")}
          </button>
        )}

        <div className="mt-6 flex items-center justify-between rounded-2xl border border-[#00e2e5]/35 bg-white/[0.04] px-6 py-4">
          <div>
            <div className="font-heading text-2xl font-extrabold tabular-nums">
              ${(newTotalCents / 100).toFixed(2)}
            </div>
            <div className="text-xs text-white/45">
              {t("gamezone.newCards.activationNote", {
                price: `$${(ACTIVATION_FEE_CENTS / 100).toFixed(0)}`,
              })}
            </div>
          </div>
          {addToVisit ? (
            <button
              type="button"
              disabled={!newReady}
              onClick={() =>
                // Swipe kiosk: the swiped accounts ride the booking, so the
                // confirmation screen loads them with no second swipe.
                addToVisit({ mode: "new_card", cards: newCardItems() })
              }
              className="font-heading h-14 rounded-full bg-[#00e2e5] px-8 text-lg font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
            >
              {t("gamezone.addToVisit")}
            </button>
          ) : (
            <button
              type="button"
              disabled={!newReady}
              onClick={() => setPhase("paying")}
              className="font-heading h-14 rounded-full bg-[#00e2e5] px-8 text-lg font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
            >
              {capability === "swipe" ? t("gamezone.payLoad") : t("gamezone.payDispense")}
            </button>
          )}
        </div>
        {addToVisit && (
          <p className="mt-2 text-center text-sm text-white/45">
            {capability === "swipe"
              ? t("gamezone.swipe.newCards.checkoutNote")
              : t("gamezone.newCards.checkoutNote")}
          </p>
        )}
        {capability === "swipe" ? (
          !msrListening ? (
            <p className="mt-2 text-center text-sm text-amber-300/80">
              {msr.connection.state === "error"
                ? t("gamezone.swipe.readerOffline")
                : t("gamezone.connectingReader")}
            </p>
          ) : !newReady ? (
            <p className="mt-2 text-center text-sm text-white/40">
              {t("gamezone.swipe.eachToContinue")}
            </p>
          ) : (
            <p className="mt-2 text-center text-sm text-white/40">{t("gamezone.swipe.payNote")}</p>
          )
        ) : !readerReady ? (
          <p className="mt-2 text-center text-sm text-amber-300/80">
            {dispenser.reconnecting
              ? t("gamezone.connecting.label")
              : t("gamezone.dispenserOffline.new")}
          </p>
        ) : dispenser.stacker === "empty" ? (
          <p className="mt-2 text-center text-sm text-amber-300/80">
            {t("gamezone.dispenserOutOfCards")}
          </p>
        ) : dispenser.stacker === "few" ? (
          <p className="mt-2 text-center text-sm text-white/40">{t("gamezone.payTakeEach")}</p>
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
    const useReader = !!readerId;
    return (
      <div className="mx-auto max-w-md py-8 kiosk-zoom">
        <div className="mb-6 text-center">
          <div className="font-heading text-3xl font-extrabold italic">
            {t("gamezone.pay", { amount: `$${payAmount.toFixed(2)}` })}
          </div>
          <p className="mt-1 text-sm text-white/50">
            {t("gamezone.payCount", { count: payCount })} ·{" "}
            {isNew
              ? capability === "swipe"
                ? t("gamezone.paySubNewSwipe")
                : t("gamezone.paySubNew")
              : t("gamezone.paySubReload")}
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
          {t("gamezone.back")}
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
              label={t("gamezone.takeYourCard")}
              sublabel={t("gamezone.takeYourCard.sub")}
            />
          ) : (
            <CardSlotGuide
              label={t("gamezone.insertCard")}
              sublabel={t("gamezone.insertCard.subLeftShort")}
            />
          )}
        </div>
      )}
      <div className="mb-5 flex items-center justify-between">
        <span className="flex items-center gap-4">
          <h1 className="font-heading text-4xl font-extrabold italic">
            {t("gamezone.reload.title")}
          </h1>
          <BridgeChip status={onsiteStatus} />
        </span>
        <button
          type="button"
          onClick={() => setMode("choose")}
          className="rounded-full border border-white/15 px-5 py-2 text-sm text-white/60"
        >
          {t("gamezone.back")}
        </button>
      </div>
      <p className="mb-5 text-white/55">
        {readerReady
          ? t("gamezone.reload.intro.insert")
          : msrActive
            ? t("gamezone.reload.intro.swipe")
            : t("gamezone.reload.intro.type")}
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
                <span className="font-heading text-lg font-extrabold italic">
                  {t("gamezone.cardN", { n: i + 1 })}
                </span>
                <div className="flex items-center gap-4">
                  {!expanded && (
                    <button
                      type="button"
                      onClick={() => setReloadEditIdx(i)}
                      className="text-sm font-bold text-[#00e2e5]"
                    >
                      {t("gamezone.edit")}
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
                      {t("gamezone.remove")}
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
                        ? t("gamezone.reload.insertHold")
                        : autoReadBlocked
                          ? t("gamezone.blockedFlip")
                          : c.accountNumber.trim()
                            ? t("gamezone.reload.insertDifferent")
                            : t("gamezone.reload.insertToRead")}
                    </button>
                  )}
                  {/* MSR kiosk: the swipe is the ONE way in — no typed entry, no
                      Check button (owner 2026-07-20, matching the dispenser rule
                      of 2026-07-18: "should not have an option to type in card").
                      The swiped number shows read-only; a new swipe replaces it. */}
                  {!readerReady && msrActive && (
                    <>
                      <div className="mt-3 w-full rounded-xl bg-[#00e2e5] px-5 py-3.5 text-center text-base font-bold text-[#04252b]">
                        {c.status === "verifying"
                          ? t("gamezone.checkingCard")
                          : c.accountNumber.trim()
                            ? t("gamezone.msr.replaceCard", {
                                num: displayCardNumber(c.accountNumber),
                              })
                            : msrListening
                              ? t("gamezone.swipeOnReader")
                              : t("gamezone.connectingReader")}
                      </div>
                      {msrBadSwipe && (
                        <p className="mt-2 text-sm text-amber-300">{t("gamezone.badSwipe")}</p>
                      )}
                    </>
                  )}
                  {/* Typed entry ONLY on a kiosk with no card hardware at all. */}
                  {!readerReady && !msrActive && (
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
                        placeholder={t("gamezone.cardNumberScanType")}
                        className="flex-1 rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-lg text-white placeholder-white/25 focus:border-[#00E2E5] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => verify(i)}
                        className="rounded-xl bg-[#00e2e5] px-5 py-2.5 text-sm font-bold text-[#04252b]"
                      >
                        {c.status === "verifying" ? "…" : t("gamezone.check")}
                      </button>
                    </div>
                  )}
                  {c.status === "ok" && (
                    <div className="mt-2 text-sm text-[#46d68c]">
                      {c.holderName ? `${c.holderName} · ` : ""}
                      {t("gamezone.balanceTokens", { n: c.balance?.tokens ?? 0 })}
                    </div>
                  )}
                  {c.status === "notfound" && msrActive ? (
                    // RELOAD, swipe kiosk: a card presented here that Intercard
                    // has never seen is a blank — recognise it and offer the
                    // new-card flow (re-verified there) rather than dead-ending
                    // on "not found" (owner 2026-08-29).
                    <div className="mt-3 rounded-xl border border-amber-400/50 bg-amber-400/10 px-4 py-3">
                      <div className="text-base font-bold text-amber-200">
                        {t("gamezone.swipe.newCard.title")}
                      </div>
                      <div className="mt-0.5 text-sm text-white/75">
                        {t("gamezone.swipe.newCard.body", {
                          num: displayCardNumber(c.accountNumber),
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={() => setUpSwipedCard(c.accountNumber, i)}
                        className="k-tap mt-3 w-full rounded-xl bg-[#f800c6] px-4 py-3 text-base font-extrabold text-white"
                      >
                        {t("gamezone.swipe.newCard.setUp")}
                      </button>
                      <div className="mt-2 text-center text-xs text-white/45">
                        {t("gamezone.swipe.newCard.orSwipeAgain")}
                      </div>
                    </div>
                  ) : c.status === "notfound" ? (
                    <div className="mt-2 text-sm text-amber-200">
                      {t("gamezone.balance.notRecognised", {
                        num: displayCardNumber(c.accountNumber),
                      })}
                    </div>
                  ) : c.status === "bad" ? (
                    <div className="mt-2 text-sm text-red-300">
                      {msrActive ? t("gamezone.swipe.unknown") : t("gamezone.notFoundNumber")}
                    </div>
                  ) : null}
                  <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {/* Checkout-upsell specials never show on the standalone grids. */}
                    {TOKEN_PACKAGES.filter((p) => !p.upsell).map((p) => (
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
                    : t("gamezone.noCardNumber")}{" "}
                  · {pkgLabel(t, c.packageId)}
                  {c.status === "ok" ? (
                    <span className="text-[#46d68c]"> · ✓</span>
                  ) : (
                    <span className="text-[#f0b341]"> · {t("gamezone.needsCheck")}</span>
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
          {t("gamezone.addAnotherCard")}
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
            {t("gamezone.addToVisit")}
          </button>
        ) : (
          <button
            type="button"
            disabled={!allReady}
            onClick={() => setPhase("paying")}
            className="font-heading h-14 rounded-full bg-[#00e2e5] px-8 text-lg font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
          >
            {t("gamezone.payLoad")}
          </button>
        )}
      </div>
      {addToVisit && (
        <p className="mt-2 text-center text-sm text-white/45">
          {t("gamezone.reload.checkoutNote")}
        </p>
      )}
      {!allReady && (
        <p className="mt-2 text-center text-sm text-white/40">
          {t("gamezone.checkEachToContinue")}
        </p>
      )}
    </div>
  );
}
