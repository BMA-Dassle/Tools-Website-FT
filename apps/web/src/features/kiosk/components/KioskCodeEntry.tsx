"use client";

/**
 * Kiosk coupon / voucher code entry — the "Coupon or voucher?" screen reached
 * from the category chooser (owner 2026-07-27; entry point mirrors the
 * website's /book/v2 attraction-selector promo form). Flag-gated by
 * kioskPromoEnabled() (+ /kiosk/flow?kioskPromo=1 preview opt-in).
 *
 * One surface, two inputs:
 *   - TYPE it — a plain input the OnScreenKeyboardHost attaches to.
 *   - SCAN it — the serial QR scanner (when provisioned) and the keyboard-
 *     wedge burst listener both feed the same classifier, so paper coupons,
 *     e-mailed QR codes, vouchers, game cards and gift cards all land here.
 *
 * Everything scanned is routed by shape (code-entry/classify.ts — ground
 * truth is the owner's 2026-07-27 live-scanner capture), never rejected as
 * "unrecognized" when we know what the guest is holding:
 *   promo       → strict server validation (today, this venue) → applyPromo.
 *   bmi-voucher → RECOGNIZED + sent to Guest Services. Redemption (BMI
 *                 order/applyCode) ships in the follow-up PR once the
 *                 bmi-voucher-probe verifies consume semantics — an unverified
 *                 vendor call never joins a money path (H3074 rule).
 *   game-card   → pointed at the Game Zone screen (one tap).
 *   gift-card   → told to pay with it at the card reader.
 *
 * Validation errors show the SPECIFIC reason (expired / wrong day / wrong
 * venue…) — an unattended guest has no cashier to ask. The server keeps the
 * anti-enumeration posture for the web landing; the kiosk opts into reasons.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppliedPromo } from "~/features/discount-codes";
import type { PartyMember } from "~/features/booking";
import { useKioskConfig } from "../KioskConfigContext";
import { kioskDeviceKey } from "../config";
import { useQrScanner } from "../qr-scanner/useQrScanner";
import { useWedgeScan } from "../checkin/wedge-scan";
import { classifyKioskCode, type KioskCodeKind } from "../code-entry/classify";
import { playScanSound } from "../sound";
import { receiptPlan } from "../code-entry/receipt-plan";
import {
  ghostCartGroups,
  ghostGzGroups,
  groupCartLegs,
  groupGzCards,
  groupUsedLegs,
  type CartGroup,
  type GzGroup,
} from "../code-entry/receipt-groups";
import {
  mergeRosters,
  personChipState,
  type VoucherPartyPerson,
} from "../code-entry/voucher-party";
import { fetchBindableParty, lookupByScan } from "../checkin/service";
import { BrandedLoader } from "./BrandedLoader";
import { prefillPartyMembers } from "../checkin/party-prefill";
import type { CheckinPartyMember } from "../checkin/types";
import { kioskVoucherGzEnabled, kioskVoucherPrefillEnabled } from "../flags";
import { clarityEvent, clarityTag } from "~/lib/clarity";
import { useT, type Translate } from "../i18n";

type MessageKey = Parameters<Translate>[0];

/** Server ValidateReason → guest copy key. Anything unmapped reads as a
 *  not-found (wrong_domain/product mean "not usable here" — same guidance). */
const ERR_KEY: Record<string, MessageKey> = {
  unknown: "codeEntry.err.unknown",
  inactive: "codeEntry.err.unknown",
  wrong_domain: "codeEntry.err.unknown",
  wrong_product: "codeEntry.err.unknown",
  unsupported_mechanic: "codeEntry.err.unknown",
  expired: "codeEntry.err.expired",
  not_yet_active: "codeEntry.err.not_yet_active",
  exhausted: "codeEntry.err.exhausted",
  wrong_weekday: "codeEntry.err.wrong_weekday",
  wrong_date: "codeEntry.err.wrong_date",
  wrong_location: "codeEntry.err.wrong_location",
  rate_limited: "codeEntry.err.rate_limited",
};

/** Voucher-route reasons → guest copy (reuses the promo error strings). */
const VOUCHER_ERR_KEY: Record<string, MessageKey> = {
  unknown: "codeEntry.err.unknown",
  expired: "codeEntry.err.expired",
  used: "codeEntry.err.exhausted",
  rate_limited: "codeEntry.err.rate_limited",
  generic: "codeEntry.err.generic",
};

/** Native (HPW) validate reasons → guest copy. */
const NATIVE_ERR_KEY: Record<string, MessageKey> = {
  bad_format: "codeEntry.err.unrecognized",
  unknown: "codeEntry.err.unknown",
  voided: "codeEntry.err.unknown",
  expired: "codeEntry.err.expired",
  used: "codeEntry.err.exhausted",
  not_redeemable: "codeEntry.err.generic",
  storage: "codeEntry.err.generic",
};

/**
 * Groupon refusal reasons → guest copy. Each one sends the guest somewhere
 * different, so they must not collapse into one "invalid code" line: `unmapped`
 * means the voucher is REAL and we are the ones who are not ready, and
 * `unavailable` means try again rather than go and queue at Guest Services.
 */
const GROUPON_ERR_KEY: Record<string, MessageKey> = {
  unknown: "codeEntry.groupon.err.unknown",
  already_redeemed: "codeEntry.groupon.err.alreadyRedeemed",
  unavailable: "codeEntry.groupon.err.unavailable",
  unmapped: "codeEntry.groupon.err.unmapped",
  used: "codeEntry.groupon.err.used",
};

/** One unspent item from the native validate response. */
interface NativeValidateItem {
  index: number;
  redeemVia: "gamezone" | "cart";
  label: string;
  coverageName?: string;
  tokens?: number;
}

/** Tokens → dollars "in play" (10¢/token — matches the token packages). */
function tokensInPlay(tokens: number): string {
  return `$${Math.round(tokens * 0.1)}`;
}

type Panel =
  | { kind: "bmi-voucher"; code: string }
  /**
   * Voucher RECEIPT (owner 2026-07-30). Auto-split: CART items (race / laser)
   * are dispatched into the booking session as scanned ("comes off at
   * checkout"); GAME-ZONE items go to the parent's pending list (code + token
   * value) for the dispense basket. The receipt renders ENTIRELY from parent
   * state (`pendingGzCards` / `appliedCartVouchers` / `appliedPromo`) — nothing
   * lives only in this panel, so Back, a remount, or a promo scan can never
   * lose the guest's cards (the 2026-07-30 "no way back to Get my cards"
   * trap). The panel value is just the marker that the receipt is open; the
   * scanner stays ARMED so a family adds every voucher before finishing.
   */
  | { kind: "voucher-gamecard" }
  | { kind: "game-card" }
  | { kind: "gift-card" };

export function KioskCodeEntry({
  onApplied,
  onBack,
  onOpenGameZone,
  voucherRedeem = false,
  appliedVoucherCodes = [],
  onVoucherAccepted,
  onNativeCartItems,
  pendingGzCards = [],
  onGzCardsAdd,
  onGzCardRemove,
  appliedCartVouchers = [],
  onCartVoucherRemove,
  onNativeCartItemAdd,
  onGzCardAddOne,
  onGzCardRemoveOne,
  appliedPromo = null,
  onClearPromo,
  canDispenseCards = true,
  party = [],
  onPartyAdd,
  onPartyRemove,
  initialScan,
}: {
  /** Valid promo → parent dispatches applyPromo; this screen shows the
   *  success panel and the CTA returns to the categories. */
  onApplied: (promo: AppliedPromo) => void;
  onBack: () => void;
  /** Opens the Game Zone screen. `voucherCodes` seed its redemption basket so
   *  vouchers scanned HERE are never scanned again there. */
  onOpenGameZone: (voucherCodes?: string[]) => void;
  /** Voucher REDEMPTION live (voucherRedeemEnabled / ?kioskVoucher=1) — a
   *  scanned voucher is accepted into the session and auto-applies to the
   *  BMI bill at checkout. Off → the Guest Services guidance panel. */
  voucherRedeem?: boolean;
  /** Codes already on the session — a re-scan gets "already added". */
  appliedVoucherCodes?: string[];
  /** Parent dispatches the pending voucher into the session (name from the
   *  scan-time peek when BMI answered). */
  onVoucherAccepted?: (code: string, name?: string) => void;
  /** Native (HPW) CART items → dispatched into the booking session, one applied
   *  voucher per item (auto-split). The reserve claims them at charge. */
  onNativeCartItems?: (code: string, items: { itemIndex: number; coverageName: string }[]) => void;
  /** Game-card voucher legs waiting to be dispensed — OWNED BY THE PARENT so
   *  the receipt survives Back / unmount / a promo scan. */
  pendingGzCards?: { code: string; tokens: number }[];
  /** Newly-scanned game-card legs → append to the parent's pending list. */
  onGzCardsAdd?: (cards: { code: string; tokens: number }[]) => void;
  /** Remove a scanned game-card voucher (all its legs) from the pending list —
   *  every receipt row is removable (owner 2026-07-30). */
  onGzCardRemove?: (code: string) => void;
  /** Vouchers already on the order (BMI + native cart legs), one row per leg —
   *  the receipt's "On your order" section renders from session truth.
   *  ERRORED vouchers ride along too: with the old voucher sheet gone, this
   *  is where a guest learns a code needs help. */
  appliedCartVouchers?: {
    code: string;
    label: string;
    /** Raw coverage name (native legs) — the qty "+" matches unspent legs of
     *  the same kind in the validate response by this, never by display label. */
    name?: string | null;
    error?: string | null;
    /** Native leg's item index — set = this row's ✕ removes ONE leg. */
    itemIndex?: number | null;
  }[];
  /** Remove an on-order voucher (whole code) — parent unwinds BMI/session. */
  onCartVoucherRemove?: (code: string, itemIndex?: number | null) => void;
  /** Re-apply ONE native leg (the qty "+") — parent dispatches applyVoucher,
   *  which upserts by (code, itemIndex). */
  onNativeCartItemAdd?: (code: string, item: { itemIndex: number; coverageName: string }) => void;
  /** Qty stepper on the game-card rows: append / drop ONE leg of a code. */
  onGzCardAddOne?: (card: { code: string; tokens: number }) => void;
  onGzCardRemoveOne?: (code: string) => void;
  /** The session promo — rendered INLINE on the receipt; a promo scanned while
   *  the receipt is up must never replace it. */
  appliedPromo?: AppliedPromo | null;
  onClearPromo?: () => void;
  /** FALSE on kiosks without a card dispenser (MSR-only / none): the receipt
   *  still accepts card vouchers but says to collect at the front kiosk /
   *  Guest Services, offers no print action and no leave warning — a machine
   *  that cannot print must never promise to (owner 2026-07-30 screenshot:
   *  "GAME ZONE CARDS NOT AVAILABLE ON THIS KIOSK" yet the flow offered
   *  "get my card"). */
  canDispenseCards?: boolean;
  /** The session party — the "Who's here from your booking?" chips derive
   *  selected/disabled state from it (session truth, remount-proof). */
  party?: PartyMember[];
  /** Parent dispatches addPartyMember — a tapped booking-roster chip lands the
   *  person on the session party, so every later people step is prefilled. */
  onPartyAdd?: (member: PartyMember) => void;
  /** Parent dispatches removePartyMember — called ONLY for members this
   *  screen's chips added (removePartyMember cascade-clears assignments). */
  onPartyRemove?: (id: string) => void;
  /** A payload already scanned on an ENTRY screen (attract / the category
   *  chooser) that routed here. Replayed through `handleRaw` exactly once on
   *  mount, so the guest never scans the same thing twice. Undefined on every
   *  normal open. See features/kiosk/entry-scan/handoff.ts. */
  initialScan?: string;
}) {
  const t = useT();
  const { config } = useKioskConfig();
  // SCAN is the primary action (owner 2026-07-27) — typing is the fallback.
  const [mode, setMode] = useState<"scan" | "type">("scan");
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  // code → its already-SPENT legs from the last validate (receipt "used" rows).
  const [spentByCode, setSpentByCode] = useState<
    Record<string, { index: number; label: string }[]>
  >({});
  // code → its UNSPENT items from the last validate — what the qty "+" checks
  // before promising another leg, and what caps the "N of M" display. Primed
  // on mount for restored codes so the stepper knows its max right away.
  const [unspentByCode, setUnspentByCode] = useState<Record<string, NativeValidateItem[]>>({});
  const unspentFetchedRef = useRef<Set<string>>(new Set());
  const fetchUnspentItems = useCallback(async (code: string): Promise<NativeValidateItem[]> => {
    try {
      const res = await fetch("/api/game-cards/voucher-redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "validate", code }),
      });
      const data: {
        ok?: boolean;
        items?: NativeValidateItem[];
        spentItems?: { index: number; label: string }[];
      } = await res.json().catch(() => ({}));
      if (!res.ok || data.ok !== true) return [];
      const items = data.items ?? [];
      setUnspentByCode((prev) => ({ ...prev, [code]: items }));
      setSpentByCode((prev) => ({ ...prev, [code]: data.spentItems ?? [] }));
      return items;
    } catch {
      return [];
    }
  }, []);
  const [error, setError] = useState<string | null>(null);
  // Routed-but-not-a-problem scans (gift card / game card) while the receipt is
  // up read as a calm info line, not the red error line and not a panel swap.
  const [info, setInfo] = useState<string | null>(null);
  // Anything already in play when this screen opens — pending cards, order
  // vouchers, an applied promo — restores the receipt: the module has ONE hub
  // and it always shows what the guest holds (owner 2026-07-30).
  const [panel, setPanel] = useState<Panel | null>(() =>
    pendingGzCards.length > 0 || appliedCartVouchers.length > 0 || appliedPromo
      ? { kind: "voucher-gamecard" }
      : null,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const checkingRef = useRef(false);
  /**
   * Groupon's 8-character code is indistinguishable from an 8-character promo,
   * and its all-digit form (`89895632` is a real production code) from a
   * game-card barcode. The classifier therefore only HINTS
   * (`grouponCandidate`), the primary path runs unchanged, and Groupon is tried
   * only if that path refused — so nothing scanned today changes meaning.
   *
   * These two refs carry that handshake:
   *   rejectedRef — did the primary path refuse? Every rejection funnels
   *     through `logReject`, so watching it beats threading a return value
   *     through ~270 lines of branches.
   *   grouponPendingRef — a Groupon attempt is still to come, so `logReject`
   *     must stay SILENT. Otherwise the guest hears an error tone followed by
   *     a success tone for one scan.
   */
  const rejectedRef = useRef(false);
  const grouponPendingRef = useRef(false);
  /** Mirror of `panel` for the async router — routeClassified must see the
   *  CURRENT panel (is the receipt up?) without re-creating on every change. */
  const panelRef = useRef<Panel | null>(panel);
  useEffect(() => {
    panelRef.current = panel;
  }, [panel]);
  // Apply never steals focus from the input (onPointerDown preventDefault, the
  // OSK-keys trick): the keyboard stays put between typed codes instead of
  // bouncing closed and re-open (owner 2026-07-30), and — because the receipt
  // layout is static, input in the TOP half — nothing on this screen ever
  // moves when the keyboard opens or closes, so every tap lands first time.
  const keepFieldFocus = (e: { preventDefault: () => void }) => e.preventDefault();
  // Back with unprinted cards → inline "they won't print later" warning.
  const [leaveWarn, setLeaveWarn] = useState(false);
  // "Start picking" with a booking party offered but NOBODY selected → ask
  // first (owner 2026-08-02). Print/Done paths are exempt — cards don't care
  // who's playing.
  const [pickWarn, setPickWarn] = useState(false);
  // "Add another" starts as a compact button (owner 2026-08-02: the always-
  // open panel ate the bottom of the screen and clipped the list). Expanding
  // it re-caps the list so the input stays in the TOP half (OSK-safe); the
  // SCANNER works either way — only typing needs the panel open.
  const [addOpen, setAddOpen] = useState(false);

  // Observability (owner 2026-07-30 "build full logging into all this"):
  // console lines carry the [kiosk] prefix staff read in DevTools/remote
  // logs; Clarity events/tags make the funnel visible in session replay.
  useEffect(() => {
    if (panelRef.current?.kind !== "voucher-gamecard") return;
    clarityEvent("kiosk:receipt:restored");
    console.log(
      `[kiosk] receipt restored: ${pendingGzCards.length} card leg(s), ` +
        `${appliedCartVouchers.length} order voucher(s), promo=${appliedPromo?.code ?? "none"}`,
    );
    // Mount-only: "restored" means the screen OPENED holding prior state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const noDispenseReportedRef = useRef(false);
  useEffect(() => {
    if (canDispenseCards || pendingGzCards.length === 0 || noDispenseReportedRef.current) return;
    noDispenseReportedRef.current = true;
    clarityEvent("kiosk:receipt:no-dispenser");
    console.warn(
      `[kiosk] card voucher accepted on a NO-DISPENSER kiosk — guest directed to front kiosk / Guest Services`,
    );
  }, [canDispenseCards, pendingGzCards.length]);
  /** Native codes already handled this session — a re-scan is a no-op. Seeded
   *  with everything the parent already holds so a remount can't re-add it. */
  const processedNativeRef = useRef<Set<string>>(
    new Set([...pendingGzCards, ...appliedCartVouchers].map((c) => c.code)),
  );

  // ── "Who's here from your booking?" — reservation-linked voucher → party ──
  // A booking-minted voucher (vouchers.bill_id) resolves to its party through
  // the check-in lookup rail (possession = proof, same posture as the emailed
  // reservation QR). Rosters are informational fetch results (like
  // spentByCode); the SELECTION itself lives on the session party — only the
  // "this screen added them" distinction is local, and losing it to a remount
  // degrades safe (the chip turns into an un-removable "In your group").
  const [voucherRosters, setVoucherRosters] = useState<Record<string, CheckinPartyMember[]>>({});
  const rosterFetchedRef = useRef<Set<string>>(new Set());
  /** How many roster lookups are in flight. The two-hop rail (scan → proof
   *  token → BMI party) can take the better part of a minute on a cold bill,
   *  and the guest was staring at a receipt with no hint that their people
   *  were on the way (owner 2026-08-02) — the receipt shows the branded loader
   *  while this is > 0. A counter, not a boolean: several scanned vouchers
   *  each fetch their own roster. */
  const [rostersLoading, setRostersLoading] = useState(0);
  /** person.key → the PartyMember.id THIS screen's chips added — the only
   *  members a chip may remove (removePartyMember cascade-clears assignments). */
  const [addedIds, setAddedIds] = useState<Record<string, string>>({});

  const loadVoucherRoster = useCallback(
    async (code: string) => {
      const center = config?.center;
      if (!center || !onPartyAdd || !kioskVoucherPrefillEnabled()) return;
      if (rosterFetchedRef.current.has(code)) return;
      rosterFetchedRef.current.add(code); // before any await — StrictMode-safe
      setRostersLoading((n) => n + 1);
      try {
        // Fire-and-forget: every failure (unlinked comp, voided, cancelled
        // booking, rate limit, network) silently means "no section" — the scan
        // path and the receipt never wait on this.
        const found = await lookupByScan(center, code);
        const proofToken = found.ok ? found.matches?.[0]?.proofToken : undefined;
        if (!proofToken) return;
        const roster = await fetchBindableParty(center, proofToken);
        const members = roster?.members;
        if (!members || members.length === 0) return;
        console.log(
          `[kiosk] receipt party offered: ${members.length} guest(s) from booking voucher ${code}` +
            (roster?.degraded ? " (BMI unavailable — roster may be short)" : ""),
        );
        clarityEvent("kiosk:receipt:party-offered");
        setVoucherRosters((prev) => ({ ...prev, [code]: members }));
      } finally {
        // finally, not after the awaits: every early return above (and any
        // throw) must clear the loader or it spins forever.
        setRostersLoading((n) => n - 1);
      }
    },
    [config?.center, onPartyAdd],
  );

  // Restore the section with the rest of the receipt: the parent's surviving
  // codes re-offer their booking party after Back / a remount — and re-prime
  // the unspent counts so the qty steppers know their max.
  useEffect(() => {
    for (const code of processedNativeRef.current) {
      if (classifyKioskCode(code).kind !== "native-voucher") continue;
      void loadVoucherRoster(code);
      if (!unspentFetchedRef.current.has(code)) {
        unspentFetchedRef.current.add(code);
        void fetchUnspentItems(code);
      }
    }
    // Mount-only: later scans call loadVoucherRoster directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** One line per rejected code — reason + kind, never silent. */
  const logReject = (kind: string, code: string, reason: string) => {
    console.warn(`[kiosk] code rejected (${kind}): ${code} — ${reason}`);
    clarityTag("kiosk_code_reject", `${kind}:${reason}`.slice(0, 60));
    rejectedRef.current = true;
    // Audible reject. A scan has no keypress and no cursor, so without a tone a
    // guest cannot tell a dead code from a beam that missed — and scans again.
    // Held back while a Groupon fallback is still to come: one scan must never
    // produce an error tone and then a success tone.
    if (!grouponPendingRef.current) playScanSound("error");
  };

  /**
   * The Groupon rail. NON-DESTRUCTIVE — validate only; nothing is claimed here.
   *
   * The legs go to the SAME callbacks the native rail uses, because the whole
   * stack underneath is now issuer-aware: `voucherIssuerFor` returns "groupon",
   * `claimAnyVoucher` claims the card leg through `claimGrouponGameZone`, and
   * `claimNativeCartVouchers` claims the laser tag legs at charge time. So a
   * Groupon behaves exactly like a multi-leg native voucher on this screen —
   * same receipt, same struck-through spent legs on a return visit, same EN+ES
   * copy — and Groupon itself is only told once a card physically lands.
   */
  const tryGroupon = useCallback(
    async (code: string): Promise<boolean> => {
      try {
        const res = await fetch("/api/kiosk/groupon/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const data: {
          ok?: boolean;
          reason?: string;
          items?: NativeValidateItem[];
          spentItems?: { index: number; label: string }[];
        } = await res.json().catch(() => ({}));

        if (data.ok !== true) {
          // `bad_format` means "not a Groupon at all" — the fallback's normal
          // answer for a promo code. Let the caller keep its own error.
          if (data.reason === "bad_format") return false;
          logReject("groupon", code, data.reason ?? `http-${res.status}`);
          setError(t(GROUPON_ERR_KEY[data.reason ?? ""] ?? "codeEntry.err.generic"));
          return true;
        }

        // Struck-through "used" rows, so a return visit EXPLAINS where the
        // card went instead of the leg silently missing.
        setSpentByCode((prev) => ({ ...prev, [code]: data.spentItems ?? [] }));
        const items = data.items ?? [];
        setUnspentByCode((prev) => ({ ...prev, [code]: items }));
        const cart = items.filter((i) => i.redeemVia === "cart" && i.coverageName);
        const gz = items.filter((i) => i.redeemVia === "gamezone");

        // CART legs (the laser tag entries) → the booking session, claimed at
        // charge. Only mark applied when we ACTUALLY dispatched.
        const didApplyCart = cart.length > 0 && voucherRedeem && !!onNativeCartItems;
        if (didApplyCart) {
          onNativeCartItems!(
            code,
            cart.map((i) => ({ itemIndex: i.index, coverageName: i.coverageName as string })),
          );
          clarityEvent("kiosk:voucher:groupon-cart");
        }
        processedNativeRef.current.add(code);
        // GAME-ZONE leg → the parent's pending card list, which the receipt
        // renders from, so it survives Back, a remount and further scans.
        const newGzCards =
          gz.length > 0 && kioskVoucherGzEnabled()
            ? gz.map((i) => ({ code, tokens: i.tokens ?? 0 }))
            : [];
        if (newGzCards.length > 0) onGzCardsAdd?.(newGzCards);

        if (newGzCards.length > 0 || didApplyCart) {
          playScanSound("success");
          setPanel({ kind: "voucher-gamecard" });
          setValue("");
          setAddOpen(false);
          return true;
        }
        // Real, live voucher with nothing this kiosk can honour right now (cart
        // legs only, redemption off). Say so rather than show an empty receipt.
        logReject("groupon", code, "nothing-honourable-here");
        setError(t("codeEntry.groupon.seeStaff"));
        return true;
      } catch {
        logReject("groupon", code, "network");
        setError(t("codeEntry.groupon.err.unavailable"));
        return true;
      }
    },
    [onGzCardsAdd, onNativeCartItems, t, voucherRedeem],
  );

  const routeClassified = useCallback(
    async (kind: KioskCodeKind, code: string) => {
      if (checkingRef.current) return;
      setError(null);
      setInfo(null);
      setLeaveWarn(false);
      clarityEvent(`kiosk:code:${kind}`);
      console.log(`[kiosk] code scanned/typed (${kind}): ${code}`);
      if (kind === "groupon") {
        await tryGroupon(code);
        return;
      }
      if (kind === "bmi-voucher") {
        if (voucherRedeem && appliedVoucherCodes.includes(code)) {
          logReject("bmi-voucher", code, "duplicate");
          setError(t("codeEntry.err.duplicate"));
          return;
        }
        if (voucherRedeem && onVoucherAccepted) {
          // PEEK — real feedback at scan time (owner 2026-07-27: "we don't
          // get any feedback on what the voucher is?"): a throwaway BMI order
          // learns the comp name and rejects dead codes right here. A BMI
          // hiccup accepts blind (the checkout apply re-validates for real).
          checkingRef.current = true;
          setChecking(true);
          try {
            const res = await fetch("/api/booking/v2/voucher", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "peek", code, center: config?.center }),
            });
            const data: {
              ok?: boolean;
              name?: string;
              reason?: string;
              target?: string;
            } = await res.json().catch(() => ({}));
            if (data.ok === false) {
              logReject("bmi-voucher", code, data.reason ?? "peek-failed");
              setError(t(VOUCHER_ERR_KEY[data.reason ?? ""] ?? "codeEntry.err.generic"));
              return;
            }
            // A Game Zone card comp has no cart leg — it's fulfilled by
            // dispensing a card. Hand it to the Game Zone screen with the code
            // already in hand instead of parking it in a cart it can't reduce.
            if (data.target === "gamecard" && kioskVoucherGzEnabled()) {
              clarityEvent("kiosk:voucher:gamecard");
              if (pendingGzCards.some((c) => c.code === code)) {
                logReject("bmi-gamecard", code, "duplicate");
                setError(t("codeEntry.err.duplicate"));
                return;
              }
              // ASK before promising: BMI comps are PARKED server-side
              // (GZ_VOUCHER_BMI, owner 2026-07-29) and the dispenser's claim
              // would refuse them — accepting one here used to strand the
              // guest with a "card to pick up" that could never print. The
              // same validate the Game Zone runs decides NOW.
              const vres = await fetch("/api/game-cards/voucher-redeem", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "validate", code }),
              });
              const v: { ok?: boolean; reason?: string } = await vres.json().catch(() => ({}));
              if (v.ok !== true) {
                logReject("bmi-gamecard", code, v.reason ?? `http-${vres.status}`);
                // Real comp, not redeemable at a kiosk (yet) — Guest Services
                // panel; inline note instead if the receipt is already up.
                if (panelRef.current?.kind === "voucher-gamecard") {
                  setInfo(t("codeEntry.voucher.body"));
                } else {
                  setPanel({ kind: "bmi-voucher", code });
                }
                return;
              }
              // BMI comp gamecard — token value isn't known at peek, so the
              // receipt shows the card without a "$ in play" figure (tokens:0).
              onGzCardsAdd?.([{ code, tokens: 0 }]);
              setPanel({ kind: "voucher-gamecard" });
              setValue(""); // accepted — a lingering code invites double-taps
              setAddOpen(false);
              return;
            }
            // One code bundling several products (e.g. game card + laser tag).
            // We can't fulfil a bundle whole yet and must not honour half of
            // it, so route to a human.
            if (data.target === "multi") {
              clarityEvent("kiosk:voucher:multi");
              setError(t("codeEntry.err.multiItem"));
              return;
            }
            clarityEvent("kiosk:voucher:accepted");
            onVoucherAccepted(code, data.name);
            // EVERY accepted voucher lands on the ONE receipt (owner
            // 2026-07-30: "why is it using a different screen?" — the old
            // terminal "Accepted!" panel had no way to scan more). The row
            // itself comes from session truth via appliedCartVouchers.
            setPanel({ kind: "voucher-gamecard" });
            setValue("");
            setAddOpen(false);
          } catch {
            onVoucherAccepted(code);
            setPanel({ kind: "voucher-gamecard" });
            setValue("");
            setAddOpen(false);
          } finally {
            checkingRef.current = false;
            setChecking(false);
          }
        } else {
          setPanel({ kind: "bmi-voucher", code });
        }
        return;
      }
      // OUR OWN voucher (HPW…). Validate (non-destructive), then AUTO-SPLIT:
      // race/laser items are dispatched into the booking session (covered at
      // charge), game-zone items ride to the dispense basket. This branch is
      // REQUIRED — without it the code falls through to the promo validator and
      // the guest is told "we couldn't find that code" for a good voucher.
      if (kind === "native-voucher") {
        clarityEvent("kiosk:voucher:native");
        // A re-scan is a REFRESH, not an error (owner 2026-07-31: a leg
        // redeemed earlier "is still there when I go back and put in voucher
        // again"). Validation returns only UNSPENT items and the flow's
        // onNativeCartItems REPLACES the code's legs, so a stale session
        // reconciles to server truth instead of showing spent legs forever.
        // (pending gz cards dedupe by code, so gz legs never double-list.)
        checkingRef.current = true;
        setChecking(true);
        try {
          const res = await fetch("/api/game-cards/voucher-redeem", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "validate", code }),
          });
          const data: {
            ok?: boolean;
            reason?: string;
            items?: NativeValidateItem[];
            spentItems?: { index: number; label: string }[];
          } = await res.json().catch(() => ({}));
          if (!res.ok || data.ok !== true) {
            logReject("native-voucher", code, data.reason ?? `http-${res.status}`);
            setError(t(NATIVE_ERR_KEY[data.reason ?? ""] ?? "codeEntry.err.generic"));
            return;
          }
          // Booking-linked voucher? Offer its party on the receipt (async,
          // never blocks the legs below — even a fully-spent voucher still
          // tells us who the booking's people are).
          void loadVoucherRoster(code);
          // Already-used legs → struck-through "used" rows on the receipt, so
          // a re-scan EXPLAINS where a leg went instead of it silently missing.
          // Informational only (no action, nothing to lose) — local state is
          // fine; a remount just drops the rows until the next scan.
          setSpentByCode((prev) => ({ ...prev, [code]: data.spentItems ?? [] }));
          const items = data.items ?? [];
          setUnspentByCode((prev) => ({ ...prev, [code]: items }));
          const cart = items.filter((i) => i.redeemVia === "cart" && i.coverageName);
          const gz = items.filter((i) => i.redeemVia === "gamezone");

          // CART items → the booking session (auto-split), claimed at charge.
          // Only mark them "applied" (below) when we ACTUALLY dispatched — a
          // promo-only kiosk with voucher redemption off must not claim a race
          // was added to an order it can't touch.
          const didApplyCart = cart.length > 0 && voucherRedeem && !!onNativeCartItems;
          if (didApplyCart) {
            onNativeCartItems!(
              code,
              cart.map((i) => ({ itemIndex: i.index, coverageName: i.coverageName as string })),
            );
            clarityEvent("kiosk:voucher:native-cart");
          }
          processedNativeRef.current.add(code);
          // Route the legs. GAME-ZONE items (code + token value) go UP to the
          // parent's pending list — the receipt renders from that, so they
          // survive anything. CART items are already in the session (above).
          const newGzCards =
            gz.length > 0 && kioskVoucherGzEnabled()
              ? gz.map((i) => ({ code, tokens: i.tokens ?? 0 }))
              : [];
          if (newGzCards.length > 0) onGzCardsAdd?.(newGzCards);
          if (newGzCards.length > 0 || didApplyCart) {
            playScanSound("success");
            setPanel({ kind: "voucher-gamecard" });
            setValue("");
            setAddOpen(false);
          } else {
            // Valid voucher, but nothing on it this kiosk can honour right now
            // (e.g. cart legs with redemption off) — say so, don't show an
            // empty receipt.
            logReject("native-voucher", code, "nothing-honourable-here");
            setError(t(NATIVE_ERR_KEY.not_redeemable));
          }
        } catch {
          setError(t("codeEntry.err.generic"));
        } finally {
          checkingRef.current = false;
          setChecking(false);
        }
        return;
      }
      if (kind === "game-card") {
        // Receipt up → an existing game card is a pointer, not a result worth
        // replacing the guest's card list for. Inline note instead.
        if (panelRef.current?.kind === "voucher-gamecard") {
          setInfo(t("codeEntry.gamecard.body"));
          return;
        }
        setPanel({ kind: "game-card" });
        return;
      }
      if (kind === "gift-card") {
        if (panelRef.current?.kind === "voucher-gamecard") {
          setInfo(t("codeEntry.giftcard.body"));
          return;
        }
        setPanel({ kind: "gift-card" });
        return;
      }
      if (kind === "unknown") {
        logReject("unknown", code, "unrecognized-shape");
        setError(t("codeEntry.err.unrecognized"));
        return;
      }
      // promo → strict server validation (today + this venue, reasons on).
      checkingRef.current = true;
      setChecking(true);
      try {
        const res = await fetch("/api/booking/v2/promo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            kiosk: {
              brand: config?.brand,
              center: config?.center,
              deviceKey: config ? kioskDeviceKey(config) : undefined,
            },
          }),
        });
        const data: { valid: boolean; promo?: AppliedPromo; reason?: string } = await res
          .json()
          .catch(() => ({ valid: false }));
        if (data.valid && data.promo) {
          clarityEvent("kiosk:code:applied");
          onApplied(data.promo);
          // The promo shows as a line ON the receipt (session truth) — one
          // hub for every value code; the old terminal "Code applied!" panel
          // had no way to scan the next code.
          setPanel({ kind: "voucher-gamecard" });
          setValue("");
          setAddOpen(false);
        } else {
          logReject("promo", code, data.reason ?? "invalid");
          const key = ERR_KEY[data.reason ?? ""] ?? ("codeEntry.err.unknown" as const);
          setError(t(key));
        }
      } catch {
        setError(t("codeEntry.err.generic"));
      } finally {
        checkingRef.current = false;
        setChecking(false);
      }
    },
    [
      appliedVoucherCodes,
      config,
      loadVoucherRoster,
      onApplied,
      onVoucherAccepted,
      onNativeCartItems,
      onGzCardsAdd,
      pendingGzCards,
      t,
      tryGroupon,
      voucherRedeem,
    ],
  );

  /**
   * Run the primary path, then Groupon only if it refused.
   *
   * This order is the whole reason nothing scanned today changes meaning: an
   * 8-character promo and an 8-digit game card keep their existing rail and
   * only a code that rail REJECTS is offered to Groupon. `rejectedRef` reads
   * that outcome off `logReject`, which every refusal already funnels through.
   */
  const routeWithGrouponFallback = useCallback(
    async (c: ReturnType<typeof classifyKioskCode>) => {
      if (c.kind === "groupon" || !c.grouponCandidate) {
        await routeClassified(c.kind, c.value);
        return;
      }
      rejectedRef.current = false;
      // Suppress the reject tone: the fallback may yet accept, and one scan
      // must not produce an error tone followed by a success tone.
      grouponPendingRef.current = true;
      try {
        await routeClassified(c.kind, c.value);
      } finally {
        grouponPendingRef.current = false;
      }
      if (!rejectedRef.current) return;
      // The primary path refused. If Groupon does not claim the code either,
      // restore the tone the reject would have played.
      const handled = await tryGroupon(c.value);
      if (!handled) playScanSound("error");
    },
    [routeClassified, tryGroupon],
  );

  const handleRaw = useCallback(
    (raw: string) => {
      // A terminal panel swallows scans; the voucher list welcomes them.
      if (!raw.trim() || (panel && panel.kind !== "voucher-gamecard")) return;
      const c = classifyKioskCode(raw);
      // Keep the normalized code on screen for the shapes the guest can retype;
      // clear it for payloads (card/gift-card URLs) that aren't codes.
      setValue(
        c.kind === "promo" || c.kind === "bmi-voucher" || c.kind === "native-voucher"
          ? c.value
          : "",
      );
      void routeWithGrouponFallback(c);
    },
    [panel, routeWithGrouponFallback],
  );

  /** Replay a scan that happened on an entry screen before we existed. Ref-
   *  guarded rather than keyed on `initialScan` so a StrictMode double-mount
   *  (or any re-render with the same prop) can't validate the code twice. */
  const replayedRef = useRef(false);
  useEffect(() => {
    if (replayedRef.current || !initialScan) return;
    replayedRef.current = true;
    handleRaw(initialScan);
  }, [initialScan, handleRaw]);

  /** The voucher list is the one panel that KEEPS LISTENING; every other result
   *  panel is terminal, so scanning into it would be noise. */
  const panelAcceptsScans = panel?.kind === "voucher-gamecard";

  // Serial QR scanner — same provisioning knobs as the license scan.
  useQrScanner({
    enabled: !!config?.qrScannerEnabled && (!panel || panelAcceptsScans),
    modelId: config?.qrScannerModel,
    baudRate: config?.qrScannerBaud ?? null,
    portInfo: config?.qrScannerPortInfo ?? null,
    allowLoneGrantFallback: false,
    onScan: (scan) => handleRaw(scan.payload),
  });

  // Keyboard-wedge scanner: the burst capture disarms itself after 15s (it
  // shares the keyboard with the OSK + IdleWatcher), so keep re-arming while
  // this screen is up and no result panel is showing.
  const wedge = useWedgeScan(handleRaw);
  const wedgeArm = wedge.arm;
  useEffect(() => {
    if ((panel && !panelAcceptsScans) || !config?.scannerEnabled) return;
    wedgeArm();
    const id = setInterval(wedgeArm, 8_000);
    return () => clearInterval(id);
  }, [panel, panelAcceptsScans, config?.scannerEnabled, wedgeArm]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || checking) return;
    const c = classifyKioskCode(trimmed);
    void routeWithGrouponFallback(c);
  };

  // ── Result panels ──
  if (panel) {
    // Native voucher RECEIPT — its own render (the generic panel can't do a
    // running total + two valued sections + scan-primary/finish-secondary).
    if (panel.kind === "voucher-gamecard") {
      // EVERYTHING here renders from parent/session state — see the Panel
      // comment. Local state on this screen can't lose the guest's cards.
      //
      // LAYOUT (owner 2026-07-30 "rethink this, it's terrible"): the screen
      // reads top-down with no dead middle — what you scanned, then ONE
      // "add another" panel (scan or type in the same box), then status.
      // Only the Back / primary row is pinned to the bottom. The input lives
      // in the TOP half, so the OSK never covers it and NOTHING moves when
      // the keyboard opens or closes — which is also what makes every tap
      // land the first time.
      const gzCards = pendingGzCards;
      const cartLabels = appliedCartVouchers;
      const codes = [...new Set(gzCards.map((c) => c.code))];
      // ANY removal frees the code for a re-scan — safe on a mixed voucher's
      // surviving half because a re-scan is idempotent end to end: the session
      // reducer UPSERTS by (code, itemIndex) and the pending-card add dedups
      // by code, so re-validating restores only what was removed. (Keeping the
      // guard until both halves were gone left a mis-tapped ✕ unrecoverable:
      // "already added" with no way to get the card back.)
      const removeGzCard = (code: string) => {
        onGzCardRemove?.(code);
        processedNativeRef.current.delete(code);
      };
      const removeCartVoucher = (code: string, itemIndex?: number | null) => {
        onCartVoucherRemove?.(code, itemIndex);
        processedNativeRef.current.delete(code);
      };
      // Identical legs collapse to one qty row with a −/+ stepper (owner
      // 2026-08-02: a 7-guest VIP voucher rendered 14 rows). Grouping rules
      // live in receipt-groups.ts (tested); "+" is honest — it re-checks the
      // voucher's unspent legs before promising another one.
      // Ghost rows: a group stepped down to zero stays visible as "0 of M"
      // (owner 2026-08-02) — synthesized from the validate results, so they
      // only appear for kinds this kiosk could actually re-add (the same
      // flag gates the original dispatch).
      const gzGroups = [
        ...groupGzCards(gzCards),
        ...(kioskVoucherGzEnabled() && onGzCardAddOne ? ghostGzGroups(unspentByCode, gzCards) : []),
      ];
      const cartGroups = [
        ...groupCartLegs(cartLabels),
        ...(voucherRedeem && onNativeCartItemAdd ? ghostCartGroups(unspentByCode, cartLabels) : []),
      ];
      const usedGroups = groupUsedLegs(spentByCode);
      const ensureUnspent = async (code: string): Promise<NativeValidateItem[]> =>
        unspentByCode[code] ?? (await fetchUnspentItems(code));
      // The voucher's TOTAL of a kind — caps the "N of M" display and disables
      // "+" at the max, so a full row never invites another tap (owner
      // 2026-08-02: "4 is already selected and it feels like it lets you go
      // more"). Null until the validate lands (then "+" checks live).
      const cartMax = (g: CartGroup): number | null => {
        const items = unspentByCode[g.code];
        if (!items) return null;
        return items.filter((i) => i.redeemVia === "cart" && (i.coverageName ?? null) === g.name)
          .length;
      };
      const gzMax = (code: string): number | null => {
        const items = unspentByCode[code];
        if (!items) return null;
        return items.filter((i) => i.redeemVia === "gamezone").length;
      };
      const stepCartDown = (g: CartGroup) => {
        if (g.qty === 0) return; // ghost row — nothing to remove
        // Highest leg first, so the surviving indexes stay contiguous-ish and
        // a later "+" re-adds what was just dropped.
        const last = g.itemIndexes[g.itemIndexes.length - 1];
        clarityEvent("kiosk:receipt:qty-remove");
        removeCartVoucher(g.code, last);
      };
      const stepCartUp = async (g: CartGroup) => {
        const items = await ensureUnspent(g.code);
        const applied = new Set(g.itemIndexes);
        const next = items.find(
          (i) =>
            i.redeemVia === "cart" &&
            !!i.coverageName &&
            (i.coverageName ?? null) === g.name &&
            !applied.has(i.index),
        );
        if (!next?.coverageName) {
          setInfo(t("codeEntry.voucherGz.noMoreLegs"));
          return;
        }
        console.log(`[kiosk] receipt qty +1: cart leg#${next.index} on ${g.code}`);
        clarityEvent("kiosk:receipt:qty-add");
        onNativeCartItemAdd?.(g.code, { itemIndex: next.index, coverageName: next.coverageName });
      };
      const stepGzDown = (g: GzGroup) => {
        if (g.qty === 0) return; // ghost row — nothing to remove
        // Last leg → whole-code removal (the ghost row keeps it visible as
        // "0 of M"); otherwise drop one leg. Mixed token values on one code
        // would make "one leg of this code" ambiguous, but no mint does that.
        if (g.qty === 1) {
          removeGzCard(g.code);
          return;
        }
        clarityEvent("kiosk:receipt:qty-remove");
        onGzCardRemoveOne?.(g.code);
      };
      const stepGzUp = async (g: GzGroup) => {
        const items = await ensureUnspent(g.code);
        const gzAvail = items.filter((i) => i.redeemVia === "gamezone").length;
        const pendingForCode = gzCards.filter((c) => c.code === g.code).length;
        if (pendingForCode >= gzAvail) {
          setInfo(t("codeEntry.voucherGz.noMoreLegs"));
          return;
        }
        console.log(`[kiosk] receipt qty +1: gz leg on ${g.code}`);
        clarityEvent("kiosk:receipt:qty-add");
        onGzCardAddOne?.({ code: g.code, tokens: g.tokens });
      };
      const stepBtn =
        "k-tap h-[56px] w-[56px] rounded-full border border-white/20 text-[30px] leading-none text-white/70 disabled:opacity-30";
      /** "4 of 4" when the voucher's total is known, "×4" until it is. */
      const qtyLabel = (qty: number, max: number | null): string =>
        max != null && max > 0
          ? t("codeEntry.voucherGz.qtyOf", { n: qty, m: max })
          : qty > 1
            ? `×${qty}`
            : "";
      // Booking party chips — the decisions live in voucher-party.ts (tested);
      // this only maps chip verdicts to copy and dispatches.
      const partyPeople = onPartyAdd ? mergeRosters(voucherRosters) : [];
      // A roster lookup still running: the section renders NOW with the loader
      // so the wait is visible, and the chips fill in underneath it.
      const partyLoading = !!onPartyAdd && rostersLoading > 0;
      const togglePerson = (person: VoucherPartyPerson) => {
        setPickWarn(false);
        const chip = personChipState(person, party, addedIds);
        if (chip.state === "in-group") return; // not ours to remove
        if (chip.state === "added" && chip.memberId) {
          console.log(`[kiosk] receipt party: removed ${person.firstName}`);
          clarityEvent("kiosk:receipt:party-remove");
          onPartyRemove?.(chip.memberId);
          setAddedIds((prev) => {
            const next = { ...prev };
            delete next[person.key];
            return next;
          });
          return;
        }
        const [member] = prefillPartyMembers(party, [person]);
        if (!member) return; // session truth says they're already on — no-op
        console.log(`[kiosk] receipt party: added ${person.firstName}`);
        clarityEvent("kiosk:receipt:party-add");
        onPartyAdd?.(member);
        setAddedIds((prev) => ({ ...prev, [person.key]: member.id }));
      };
      const totalTokens = gzCards.reduce((sum, c) => sum + c.tokens, 0);
      const totalBits = [
        totalTokens > 0
          ? t("codeEntry.voucherGz.inPlay", { amount: tokensInPlay(totalTokens) })
          : null,
        cartLabels.length > 0 ? t("codeEntry.voucherGz.onOrder", { n: cartLabels.length }) : null,
      ].filter(Boolean) as string[];
      // The footer decision lives in receiptPlan (tested) — this only maps
      // its verdict to copy and callbacks.
      const plan = receiptPlan({
        cardCodes: codes.length,
        canDispense: canDispenseCards,
        cartVouchers: cartLabels.length,
        promoApplied: !!appliedPromo,
      });
      // Counts shown to the guest are LEGS (cards owed) — same number the
      // section header and the categories tile use. A dispense run covers
      // EVERY leg (one claim per card), so normally nothing stays pending;
      // only legs that fail mid-run keep the way-back tile alive.
      const cardCount = gzCards.length;
      const startPrint = () => {
        console.log(`[kiosk] receipt → print ${cardCount} card(s) via: ${codes.join(", ")}`);
        clarityEvent("kiosk:receipt:print");
        clarityTag("kiosk_receipt_print_n", String(cardCount));
        onOpenGameZone(codes);
      };
      const leaveTo = (why: "start-picking" | "done") => {
        clarityEvent(`kiosk:receipt:${why}`);
        onBack();
      };
      // Booking party offered but nobody tapped — "Start picking" asks first
      // (print/done don't care who's playing).
      const partyUnpicked =
        partyPeople.length > 0 &&
        partyPeople.every((p) => personChipState(p, party, addedIds).state === "idle");
      const startPicking = () => {
        if (partyUnpicked) {
          clarityEvent("kiosk:receipt:pick-warn");
          setPickWarn(true);
          return;
        }
        leaveTo("start-picking");
      };
      const finish =
        plan.primary === "print"
          ? { label: t("codeEntry.voucherGz.printNow", { n: cardCount }), onClick: startPrint }
          : plan.primary === "print-continue"
            ? {
                label: t("codeEntry.voucherGz.finishCards", { n: cardCount }),
                onClick: startPrint,
              }
            : plan.primary === "start-picking"
              ? { label: t("codeEntry.applied.cta"), onClick: startPicking }
              : { label: t("codeEntry.voucherGz.done"), onClick: () => leaveTo("done") };
      const warnOnBack = plan.warnOnBack;
      return (
        <div className="flex h-full flex-col px-[64px] pb-[40px] pt-[80px]">
          <div className="k-eyebrow">{t("codeEntry.eyebrow")}</div>
          <h1 className="k-display mt-[14px] text-[68px] text-[#f800c6]">
            {t("codeEntry.voucherGz.receiptTitle")}
          </h1>
          {totalBits.length > 0 && (
            <div className="mt-[8px] text-[30px] text-white/70">{totalBits.join("  ·  ")}</div>
          )}

          {/* What they've scanned. With the add-another panel COLLAPSED the
              list takes the freed space; expanding the panel re-caps the list
              so the input lands in the top half (OSK never covers it). */}
          <div
            className={`kiosk-scroll mt-[28px] space-y-[26px] overflow-y-auto text-left ${
              addOpen ? "max-h-[560px]" : "min-h-0 flex-1"
            }`}
          >
            {gzGroups.length > 0 && (
              <section>
                <div className="k-eyebrow text-[#f800c6]">
                  {t("codeEntry.voucherGz.printingTitle", { n: Math.max(gzCards.length, 1) })}
                </div>
                <div className="mt-[4px] text-[20px] text-white/45">
                  {canDispenseCards
                    ? t("codeEntry.voucherGz.printingSub")
                    : t("codeEntry.voucherGz.printingSubElsewhere")}
                </div>
                <ul className="mt-[14px] space-y-[10px]">
                  {gzGroups.map((g) => {
                    const max = gzMax(g.code);
                    const pendingForCode = gzCards.filter((c) => c.code === g.code).length;
                    const atMax = max != null && pendingForCode >= max;
                    return (
                      <li
                        key={`${g.code}-${g.tokens}`}
                        className={`flex items-center justify-between gap-[16px] rounded-[16px] border px-[24px] py-[12px] ${
                          g.qty === 0
                            ? "border-white/8 bg-white/[0.02]"
                            : "border-white/12 bg-white/[0.04]"
                        }`}
                      >
                        <span
                          className={`min-w-0 truncate text-[28px] ${g.qty === 0 ? "text-white/40" : "text-white/90"}`}
                        >
                          {g.tokens > 0
                            ? t("codeEntry.voucherGz.cardTokens", { tokens: g.tokens })
                            : t("codeEntry.voucherGz.gameCardGeneric")}
                          {qtyLabel(g.qty, max) && (
                            <span className="text-white/50">{`  ${qtyLabel(g.qty, max)}`}</span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center gap-[14px]">
                          {g.tokens > 0 && g.qty > 0 && (
                            <span className="text-[24px] text-[#46d68c]">
                              {t("codeEntry.voucherGz.inPlay", {
                                amount: tokensInPlay(g.tokens * g.qty),
                              })}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => stepGzDown(g)}
                            disabled={g.qty === 0}
                            aria-label={t("codeEntry.voucherGz.removeOne")}
                            className={stepBtn}
                          >
                            −
                          </button>
                          <button
                            type="button"
                            onClick={() => void stepGzUp(g)}
                            disabled={atMax}
                            aria-label={t("codeEntry.voucherGz.addOne")}
                            className={stepBtn}
                          >
                            ＋
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {(cartGroups.length > 0 || appliedPromo || usedGroups.length > 0) && (
              <section>
                <div className="k-eyebrow text-[#46d68c]">
                  {t("codeEntry.voucherGz.appliedSectionTitle")}
                </div>
                <ul className="mt-[14px] space-y-[10px]">
                  {cartGroups.map((g) => (
                    <li
                      key={`${g.code}-${g.label}-${g.itemIndexes[0] ?? "bmi"}${g.error ? "-err" : ""}`}
                      className={`flex items-center justify-between gap-[16px] rounded-[16px] border px-[24px] py-[12px] ${
                        g.error
                          ? "border-[#ff8c7a]/40 bg-[#ff8c7a]/[0.08]"
                          : g.qty === 0
                            ? "border-white/8 bg-white/[0.02]"
                            : "border-[#46d68c]/25 bg-[#46d68c]/[0.08]"
                      }`}
                    >
                      <span
                        className={`min-w-0 truncate text-[28px] ${g.qty === 0 ? "text-white/40" : "text-white/90"}`}
                      >
                        {g.label}
                        {g.native && !g.error && qtyLabel(g.qty, cartMax(g)) && (
                          <span className="text-white/50">{`  ${qtyLabel(g.qty, cartMax(g))}`}</span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-[14px]">
                        {g.qty > 0 && (
                          <span
                            className={`text-[22px] ${g.error ? "text-[#ffb3a6]" : "text-white/50"}`}
                          >
                            {g.error
                              ? t("codeEntry.voucherGz.rowNeedsHelp")
                              : t("codeEntry.voucherGz.comesOff")}
                          </span>
                        )}
                        {g.native && !g.error ? (
                          <>
                            <button
                              type="button"
                              onClick={() => stepCartDown(g)}
                              disabled={g.qty === 0}
                              aria-label={t("codeEntry.voucherGz.removeOne")}
                              className={stepBtn}
                            >
                              −
                            </button>
                            <button
                              type="button"
                              onClick={() => void stepCartUp(g)}
                              disabled={(() => {
                                const max = cartMax(g);
                                return max != null && g.qty >= max;
                              })()}
                              aria-label={t("codeEntry.voucherGz.addOne")}
                              className={stepBtn}
                            >
                              ＋
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => removeCartVoucher(g.code, g.itemIndexes[0] ?? null)}
                            aria-label={t("promo.banner.clear")}
                            className="k-tap px-[8px] text-[28px] leading-none text-white/40"
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                  {/* Already-used legs — struck through, no ✕ (nothing to
                      remove; the claim lives in the ledger). */}
                  {usedGroups.map((g) => (
                    <li
                      key={`used-${g.code}-${g.label}`}
                      className="flex items-center justify-between gap-[16px] rounded-[16px] border border-white/10 bg-white/[0.03] px-[24px] py-[12px]"
                    >
                      <span className="min-w-0 truncate text-[28px] text-white/35 line-through">
                        {g.label}
                        {g.qty > 1 && <span>{`  ×${g.qty}`}</span>}
                      </span>
                      <span className="shrink-0 text-[22px] text-white/35">
                        {t("codeEntry.voucherGz.rowUsed")}
                      </span>
                    </li>
                  ))}
                  {/* The session promo, INLINE — scanning a coupon mid-receipt
                      lands here instead of replacing the card list. */}
                  {appliedPromo && (
                    <li className="flex items-center justify-between gap-[16px] rounded-[16px] border border-[#e8b14c]/30 bg-[#e8b14c]/[0.08] px-[24px] py-[16px]">
                      <span className="min-w-0 truncate text-[28px] text-[#e8b14c]">
                        {appliedSummary(t, appliedPromo)}
                      </span>
                      <span className="flex shrink-0 items-center gap-[16px]">
                        <span className="text-[22px] text-white/50">
                          {t("codeEntry.voucherGz.promoRow")}
                        </span>
                        {onClearPromo && (
                          <button
                            type="button"
                            onClick={onClearPromo}
                            aria-label={t("promo.banner.clear")}
                            className="k-tap px-[8px] text-[28px] leading-none text-white/40"
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    </li>
                  )}
                </ul>
              </section>
            )}
            {/* Who's here from your booking? — the voucher's reservation
                offers its people as tap-to-include chips. Selection lands on
                the SESSION party (prefills every later people step); waiver
                signing still happens where it always has. */}
            {(partyPeople.length > 0 || partyLoading) && (
              <section>
                {/* Until a roster actually lands, the header stays
                    non-committal: plenty of vouchers have no booking behind
                    them, and this section disappears again when the lookup
                    comes back empty. Promising "your booking" and then
                    yanking it would read as a bug. */}
                <div className="k-eyebrow text-[#00e2e5]">
                  {partyPeople.length > 0
                    ? t("codeEntry.voucherGz.partyTitle")
                    : t("codeEntry.voucherGz.partyLoadingTitle")}
                </div>
                <div className="mt-[4px] text-[20px] text-white/45">
                  {partyPeople.length > 0
                    ? t("codeEntry.voucherGz.partySub")
                    : t("codeEntry.voucherGz.partyLoadingSub")}
                </div>
                {partyLoading && (
                  <div className="mt-[14px] flex items-center gap-[22px]" role="status">
                    <BrandedLoader brand={config?.brand ?? "fasttrax"} size={120} />
                    <span className="text-[26px] text-white/60">
                      {t("codeEntry.voucherGz.partyLoading")}
                    </span>
                  </div>
                )}
                <div className="mt-[14px] flex flex-wrap gap-[14px]">
                  {partyPeople.map((person) => {
                    const chip = personChipState(person, party, addedIds);
                    const name = [person.firstName, person.lastName].filter(Boolean).join(" ");
                    return (
                      <button
                        key={person.key}
                        type="button"
                        disabled={chip.state === "in-group"}
                        aria-pressed={chip.state !== "idle"}
                        onClick={() => togglePerson(person)}
                        className={`k-tap rounded-[18px] border px-[24px] py-[12px] text-left ${
                          chip.state === "added"
                            ? "border-[#46d68c] bg-[#46d68c]/[0.08]"
                            : chip.state === "in-group"
                              ? "border-[#46d68c]/40 bg-[#46d68c]/[0.05] opacity-60"
                              : "border-white/20 bg-white/[0.04]"
                        }`}
                      >
                        <span className="block text-[26px] leading-[1.2] text-white/90">
                          {chip.state !== "idle" ? "✓ " : ""}
                          {name}
                        </span>
                        <span
                          className={`block text-[18px] leading-[1.3] ${
                            chip.state === "in-group"
                              ? "text-white/40"
                              : person.waiverValid
                                ? "text-[#46d68c]"
                                : "text-[#e8b14c]"
                          }`}
                        >
                          {chip.state === "in-group"
                            ? t("codeEntry.voucherGz.partyInGroup")
                            : person.waiverValid
                              ? t("codeEntry.voucherGz.partyWaiverOk")
                              : t("codeEntry.voucherGz.partyWaiverNeeded")}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          {/* Add another — a compact BUTTON until the guest wants to type
              (owner 2026-08-02: the always-open panel clipped the list).
              Scan and type still share this one box when open; the scanner
              stays live in both states. */}
          {addOpen ? (
            <div className="mt-[24px] rounded-[20px] border border-[#00e2e5]/30 bg-[#00e2e5]/[0.05] px-[28px] py-[22px] text-left">
              <div className="flex items-start justify-between gap-[16px]">
                <div>
                  <div className="text-[28px] font-extrabold text-[#00e2e5]">
                    {t("codeEntry.voucherGz.scanNext")}
                  </div>
                  <div className="mt-[2px] text-[20px] text-white/50">
                    {t("codeEntry.voucherGz.scanNextSub")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setAddOpen(false);
                    setError(null);
                    setInfo(null);
                  }}
                  aria-label={t("codeEntry.voucherGz.addClose")}
                  className="k-tap px-[8px] text-[28px] leading-none text-white/40"
                >
                  ✕
                </button>
              </div>
              <div className="mt-[14px] flex gap-[14px]">
                <input
                  type="text"
                  value={value}
                  onChange={(e) => {
                    setError(null);
                    setInfo(null);
                    setValue(e.target.value.toUpperCase());
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                  }}
                  aria-label={t("codeEntry.inputLabel")}
                  placeholder={t("codeEntry.placeholder")}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="k-num h-[76px] min-w-0 flex-1 rounded-[16px] border border-white/20 bg-[#040d24] px-[22px] font-mono text-[28px] uppercase tracking-[0.08em] text-white placeholder:text-white/30 focus:border-[#00e2e5]/60 focus:outline-none"
                />
                <button
                  type="button"
                  onPointerDown={keepFieldFocus}
                  onClick={submit}
                  disabled={!value.trim() || checking}
                  className="k-tap shrink-0 rounded-[16px] border border-white/20 px-[30px] text-[24px] text-white/80 disabled:opacity-40"
                >
                  {t("codeEntry.apply")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              aria-expanded={false}
              className="k-tap mt-[24px] w-full rounded-[20px] border border-[#00e2e5]/30 bg-[#00e2e5]/[0.05] px-[28px] py-[20px] text-left"
            >
              <span className="block text-[28px] font-extrabold text-[#00e2e5]">
                ＋ {t("codeEntry.voucherGz.scanNext")}
              </span>
              <span className="mt-[2px] block text-[20px] text-white/50">
                {t("codeEntry.voucherGz.scanNextCollapsedSub")}
              </span>
            </button>
          )}

          <div
            className="mt-[12px] min-h-[40px] text-center text-[24px] text-[#ff8c7a]"
            role="alert"
            aria-live="polite"
          >
            {checking ? (
              <span className="text-white/55">{t("codeEntry.checking")}</span>
            ) : (
              (error ?? (info ? <span className="text-white/70">{info}</span> : ""))
            )}
          </div>

          {leaveWarn && warnOnBack ? (
            /* Back with unprinted cards: cards do NOT print later on their
               own, so say it and offer the right exit both ways. */
            <div className="mt-auto rounded-[20px] border border-[#ff8c7a]/45 bg-[#ff8c7a]/[0.08] px-[28px] py-[20px]">
              <div className="text-center text-[26px] leading-[1.35] text-[#ffb3a6]">
                {t("codeEntry.voucherGz.leaveWarn", { n: cardCount })}
              </div>
              <div className="mt-[16px] flex gap-[24px]">
                <button
                  type="button"
                  onClick={() => {
                    console.warn(
                      `[kiosk] guest LEFT ${cardCount} unprinted card(s): ${codes.join(", ")}`,
                    );
                    clarityEvent("kiosk:receipt:leave-anyway");
                    onBack();
                  }}
                  className="k-btn-ghost k-tap"
                >
                  {t("codeEntry.voucherGz.leaveAnyway")}
                </button>
                <button type="button" onClick={startPrint} className="k-btn-primary k-tap">
                  {t("codeEntry.voucherGz.printNow", { n: cardCount })}
                </button>
              </div>
            </div>
          ) : pickWarn ? (
            /* Nobody from the booking picked — one gentle ask before leaving
               to the activity picker; "Pick people" just returns to the chips. */
            <div className="mt-auto rounded-[20px] border border-[#00e2e5]/40 bg-[#00e2e5]/[0.06] px-[28px] py-[20px]">
              <div className="text-center text-[26px] leading-[1.35] text-white/85">
                {t("codeEntry.voucherGz.pickWarn")}
              </div>
              <div className="mt-[16px] flex gap-[24px]">
                <button
                  type="button"
                  onClick={() => {
                    clarityEvent("kiosk:receipt:pick-warn-skip");
                    leaveTo("start-picking");
                  }}
                  className="k-btn-ghost k-tap"
                >
                  {t("codeEntry.voucherGz.pickWarnGo")}
                </button>
                <button
                  type="button"
                  onClick={() => setPickWarn(false)}
                  className="k-btn-primary k-tap"
                >
                  {t("codeEntry.voucherGz.pickWarnStay")}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-auto flex gap-[24px]">
              <button
                type="button"
                onClick={() => {
                  if (warnOnBack) {
                    clarityEvent("kiosk:receipt:leave-warn");
                    setLeaveWarn(true);
                  } else {
                    onBack();
                  }
                }}
                className="k-btn-ghost k-tap"
              >
                {t("codeEntry.back")}
              </button>
              <button type="button" onClick={finish.onClick} className="k-btn-primary k-tap">
                {finish.label}
              </button>
            </div>
          )}
        </div>
      );
    }

    const p =
      panel.kind === "bmi-voucher"
        ? {
            title: t("codeEntry.voucher.title"),
            body: t("codeEntry.voucher.body"),
            cta: t("codeEntry.voucher.cta"),
            accent: "#e8b14c",
            detail: panel.code,
            onCta: onBack,
          }
        : panel.kind === "game-card"
          ? {
              title: t("codeEntry.gamecard.title"),
              body: t("codeEntry.gamecard.body"),
              cta: t("codeEntry.gamecard.cta"),
              accent: "#f800c6",
              detail: null,
              onCta: onOpenGameZone,
            }
          : {
              title: t("codeEntry.giftcard.title"),
              body: t("codeEntry.giftcard.body"),
              cta: t("codeEntry.giftcard.cta"),
              accent: "#00e2e5",
              detail: null,
              onCta: onBack,
            };
    return (
      <div className="flex h-full flex-col px-[64px] pb-[40px] pt-[120px] text-center">
        <div className="k-eyebrow">{t("codeEntry.eyebrow")}</div>
        <h1 className="k-display mt-[28px] text-[86px]" style={{ color: p.accent }}>
          {p.title}
        </h1>
        {p.detail && (
          <div className="k-num mx-auto mt-[36px] max-w-full break-all rounded-[20px] border border-white/15 bg-white/[0.04] px-[36px] py-[20px] font-mono text-[34px] tracking-[0.08em]">
            {p.detail}
          </div>
        )}
        <p className="mx-auto mt-[32px] max-w-[26ch] text-[32px] leading-[1.4] text-white/70">
          {p.body}
        </p>
        <div className="mt-auto flex gap-[24px]">
          <button type="button" onClick={onBack} className="k-btn-ghost k-tap">
            {t("codeEntry.back")}
          </button>
          {/* Called with no argument on purpose — the panel's own closure
              supplies any voucher code (never the click event). */}
          <button type="button" onClick={() => p.onCta()} className="k-btn-primary k-tap">
            {p.cta}
          </button>
        </div>
      </div>
    );
  }

  // ── Entry ──
  const statusLine = (
    <div
      className="min-h-[44px] text-center text-[28px] leading-[1.35] text-[#ff8c7a]"
      role="alert"
      aria-live="polite"
    >
      {checking ? <span className="text-white/55">{t("codeEntry.checking")}</span> : (error ?? "")}
    </div>
  );

  /**
   * Shown on BOTH entry screens when this kiosk has no dispenser (owner
   * 2026-08-18). Deliberately up front rather than on the receipt: a guest with
   * a multi-item voucher (the Groupon deal is one card + four laser tag
   * entries) needs to know before they start that the card can't come out here
   * — and, just as importantly, that redeeming the rest here is still fine.
   *
   * Informational, not an error: it uses the amber/among-friends treatment and
   * never blocks the input. `canDispenseCards` is
   * `gameZoneCapability(config) === "full"`, so this also covers a kiosk whose
   * CRT is merely toggled off, not just one that never had hardware.
   */
  const noDispenserNotice = canDispenseCards ? null : (
    <div className="mt-[20px] rounded-[18px] border border-[rgba(255,176,32,0.45)] bg-[rgba(255,176,32,0.08)] px-[28px] py-[18px] text-left">
      <div className="text-[28px] font-semibold text-[#ffb020]">
        {t("codeEntry.noDispenser.title")}
      </div>
      <div className="mt-[6px] text-[24px] leading-[1.35] text-white/70">
        {t("codeEntry.noDispenser.body")}
      </div>
    </div>
  );

  if (mode === "scan") {
    return (
      <div className="flex h-full flex-col items-center px-[64px] pb-[40px] pt-[96px] text-center">
        <div className="k-eyebrow">{t("codeEntry.eyebrow")}</div>
        <h1 className="k-display mt-[24px] text-[84px]">{t("codeEntry.scanTitle")}</h1>
        <p className="mt-[20px] max-w-[24ch] text-[30px] leading-[1.4] text-white/70">
          {t("codeEntry.scanHint.body")}
        </p>
        {noDispenserNotice}

        {/* The scan target — dead center. The kiosk's scanner sits below the
            screen; the pulsing frame is the "present it here" affordance. */}
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="relative h-[460px] w-[460px]">
            <span className="absolute left-0 top-0 h-[88px] w-[88px] rounded-tl-[28px] border-l-[10px] border-t-[10px] border-[#00e2e5]" />
            <span className="absolute right-0 top-0 h-[88px] w-[88px] rounded-tr-[28px] border-r-[10px] border-t-[10px] border-[#00e2e5]" />
            <span className="absolute bottom-0 left-0 h-[88px] w-[88px] rounded-bl-[28px] border-b-[10px] border-l-[10px] border-[#00e2e5]" />
            <span className="absolute bottom-0 right-0 h-[88px] w-[88px] rounded-br-[28px] border-b-[10px] border-r-[10px] border-[#00e2e5]" />
            <div className="absolute inset-[28px] flex items-center justify-center rounded-[20px] border border-dashed border-[rgba(0,226,229,0.3)]">
              <ScanGlyph size={200} />
            </div>
            <div className="absolute inset-x-[36px] top-1/2 h-[6px] rounded-full bg-[#00e2e5] shadow-[0_0_30px_rgba(0,226,229,0.9)] motion-safe:animate-pulse" />
          </div>
        </div>

        {statusLine}

        <div className="mt-[20px] flex w-full gap-[24px]">
          <button type="button" onClick={onBack} className="k-btn-ghost k-tap">
            {t("codeEntry.back")}
          </button>
          <button
            type="button"
            onClick={() => setMode("type")}
            className="k-btn-ghost k-tap flex-1 text-white/80"
          >
            {t("codeEntry.typeInstead")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col px-[64px] pb-[40px] pt-[104px]">
      <div className="k-eyebrow">{t("codeEntry.eyebrow")}</div>
      <h1 className="k-display mt-[24px] text-[80px]">{t("codeEntry.title")}</h1>
      {noDispenserNotice}

      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          setError(null);
          setValue(e.target.value.toUpperCase());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        aria-label={t("codeEntry.inputLabel")}
        placeholder={t("codeEntry.placeholder")}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className="k-num mt-[44px] h-[130px] w-full rounded-[24px] border-2 border-[rgba(0,226,229,0.55)] bg-[#040d24] px-[40px] font-mono text-[52px] uppercase tracking-[0.12em] text-white placeholder:text-white/30 focus:outline-none"
      />
      <div className="mt-[20px]">{statusLine}</div>

      <div className="mt-auto flex gap-[24px]">
        <button type="button" onClick={() => setMode("scan")} className="k-btn-ghost k-tap">
          {t("codeEntry.scanInstead")}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim() || checking}
          className="k-btn-primary k-tap"
        >
          {t("codeEntry.apply")}
        </button>
      </div>
    </div>
  );
}

/** "SUMMER26 · 15% off today" line for the success panel. */
function appliedSummary(t: Translate, promo: AppliedPromo): string {
  const deal =
    promo.mechanic === "percent" && promo.amountPct != null
      ? t("promo.banner.percent", { pct: promo.amountPct })
      : promo.amountCents != null
        ? t("promo.banner.fixed", { amount: `$${(promo.amountCents / 100).toFixed(2)}` })
        : "";
  return deal ? `${promo.code} · ${deal}` : promo.code;
}

/** QR-corners glyph pointing at the under-screen scanner. */
function ScanGlyph({ size = 88 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#00e2e5"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M4 7V5a1 1 0 0 1 1-1h2" />
      <path d="M17 4h2a1 1 0 0 1 1 1v2" />
      <path d="M20 17v2a1 1 0 0 1-1 1h-2" />
      <path d="M7 20H5a1 1 0 0 1-1-1v-2" />
      <path d="M5 12h14" />
    </svg>
  );
}
