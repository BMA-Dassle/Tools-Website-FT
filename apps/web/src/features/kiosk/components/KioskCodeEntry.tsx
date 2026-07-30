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
import { useKioskConfig } from "../KioskConfigContext";
import { kioskDeviceKey } from "../config";
import { useQrScanner } from "../qr-scanner/useQrScanner";
import { useWedgeScan } from "../checkin/wedge-scan";
import { classifyKioskCode, type KioskCodeKind } from "../code-entry/classify";
import { receiptPlan } from "../code-entry/receipt-plan";
import { kioskVoucherGzEnabled } from "../flags";
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
  appliedPromo = null,
  onClearPromo,
  canDispenseCards = true,
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
  appliedCartVouchers?: { code: string; label: string; error?: string | null }[];
  /** Remove an on-order voucher (whole code) — parent unwinds BMI/session. */
  onCartVoucherRemove?: (code: string) => void;
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
}) {
  const t = useT();
  const { config } = useKioskConfig();
  // SCAN is the primary action (owner 2026-07-27) — typing is the fallback.
  const [mode, setMode] = useState<"scan" | "type">("scan");
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
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

  /** One line per rejected code — reason + kind, never silent. */
  const logReject = (kind: string, code: string, reason: string) => {
    console.warn(`[kiosk] code rejected (${kind}): ${code} — ${reason}`);
    clarityTag("kiosk_code_reject", `${kind}:${reason}`.slice(0, 60));
  };

  const routeClassified = useCallback(
    async (kind: KioskCodeKind, code: string) => {
      if (checkingRef.current) return;
      setError(null);
      setInfo(null);
      setLeaveWarn(false);
      clarityEvent(`kiosk:code:${kind}`);
      console.log(`[kiosk] code scanned/typed (${kind}): ${code}`);
      if (kind === "bmi-voucher") {
        if (voucherRedeem && appliedVoucherCodes.includes(code)) {
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
            const data: { ok?: boolean; name?: string; reason?: string; target?: string } =
              await res.json().catch(() => ({}));
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
                setError(t("codeEntry.err.duplicate"));
                return;
              }
              // BMI comp gamecard — token value isn't known at peek, so the
              // receipt shows the card without a "$ in play" figure (tokens:0).
              onGzCardsAdd?.([{ code, tokens: 0 }]);
              setPanel({ kind: "voucher-gamecard" });
              setValue(""); // accepted — a lingering code invites double-taps
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
          } catch {
            onVoucherAccepted(code);
            setPanel({ kind: "voucher-gamecard" });
            setValue("");
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
        // A re-scan of the same code adds nothing (reducer is idempotent; the
        // basket already holds it) — tell the guest rather than double-listing.
        if (processedNativeRef.current.has(code)) {
          setError(t("codeEntry.err.duplicate"));
          return;
        }
        checkingRef.current = true;
        setChecking(true);
        try {
          const res = await fetch("/api/game-cards/voucher-redeem", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "validate", code }),
          });
          const data: { ok?: boolean; reason?: string; items?: NativeValidateItem[] } = await res
            .json()
            .catch(() => ({}));
          if (!res.ok || data.ok !== true) {
            logReject("native-voucher", code, data.reason ?? `http-${res.status}`);
            setError(t(NATIVE_ERR_KEY[data.reason ?? ""] ?? "codeEntry.err.generic"));
            return;
          }
          const items = data.items ?? [];
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
            setPanel({ kind: "voucher-gamecard" });
            setValue("");
          } else {
            // Valid voucher, but nothing on it this kiosk can honour right now
            // (e.g. cart legs with redemption off) — say so, don't show an
            // empty receipt.
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
      onApplied,
      onVoucherAccepted,
      onNativeCartItems,
      onGzCardsAdd,
      pendingGzCards,
      t,
      voucherRedeem,
    ],
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
      void routeClassified(c.kind, c.value);
    },
    [panel, routeClassified],
  );

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
    void routeClassified(c.kind, c.value);
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
      // Removing a row frees the code for a clean re-scan ONLY once it's gone
      // from BOTH lists (a mixed voucher's other half may still be in play).
      const removeGzCard = (code: string) => {
        onGzCardRemove?.(code);
        if (!cartLabels.some((v) => v.code === code)) processedNativeRef.current.delete(code);
      };
      const removeCartVoucher = (code: string) => {
        onCartVoucherRemove?.(code);
        if (!gzCards.some((c) => c.code === code)) processedNativeRef.current.delete(code);
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
      const startPrint = () => {
        console.log(`[kiosk] receipt → print ${codes.length} card(s): ${codes.join(", ")}`);
        clarityEvent("kiosk:receipt:print");
        clarityTag("kiosk_receipt_print_n", String(codes.length));
        onOpenGameZone(codes);
      };
      const leaveTo = (why: "start-picking" | "done") => {
        clarityEvent(`kiosk:receipt:${why}`);
        onBack();
      };
      const finish =
        plan.primary === "print"
          ? { label: t("codeEntry.voucherGz.printNow", { n: codes.length }), onClick: startPrint }
          : plan.primary === "print-continue"
            ? {
                label: t("codeEntry.voucherGz.finishCards", { n: codes.length }),
                onClick: startPrint,
              }
            : plan.primary === "start-picking"
              ? { label: t("codeEntry.applied.cta"), onClick: () => leaveTo("start-picking") }
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

          {/* What they've scanned — capped so the add-another panel below
              stays in the top half of the screen; long lists scroll here. */}
          <div className="kiosk-scroll mt-[28px] max-h-[560px] space-y-[26px] overflow-y-auto text-left">
            {gzCards.length > 0 && (
              <section>
                <div className="k-eyebrow text-[#f800c6]">
                  {t("codeEntry.voucherGz.printingTitle", { n: gzCards.length })}
                </div>
                <div className="mt-[4px] text-[20px] text-white/45">
                  {canDispenseCards
                    ? t("codeEntry.voucherGz.printingSub")
                    : t("codeEntry.voucherGz.printingSubElsewhere")}
                </div>
                <ul className="mt-[14px] space-y-[10px]">
                  {gzCards.map((c, i) => (
                    <li
                      key={`${c.code}-${i}`}
                      className="flex items-center justify-between gap-[16px] rounded-[16px] border border-white/12 bg-white/[0.04] px-[24px] py-[16px]"
                    >
                      <span className="min-w-0 truncate text-[28px] text-white/90">
                        {c.tokens > 0
                          ? t("codeEntry.voucherGz.cardTokens", { tokens: c.tokens })
                          : t("codeEntry.voucherGz.gameCardGeneric")}
                      </span>
                      <span className="flex shrink-0 items-center gap-[16px]">
                        {c.tokens > 0 && (
                          <span className="text-[24px] text-[#46d68c]">
                            {t("codeEntry.voucherGz.inPlay", { amount: tokensInPlay(c.tokens) })}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => removeGzCard(c.code)}
                          aria-label={t("promo.banner.clear")}
                          className="k-tap px-[8px] text-[28px] leading-none text-white/40"
                        >
                          ✕
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {(cartLabels.length > 0 || appliedPromo) && (
              <section>
                <div className="k-eyebrow text-[#46d68c]">
                  {t("codeEntry.voucherGz.appliedSectionTitle")}
                </div>
                <ul className="mt-[14px] space-y-[10px]">
                  {cartLabels.map((v, i) => (
                    <li
                      key={`${v.code}-${i}`}
                      className={`flex items-center justify-between gap-[16px] rounded-[16px] border px-[24px] py-[16px] ${
                        v.error
                          ? "border-[#ff8c7a]/40 bg-[#ff8c7a]/[0.08]"
                          : "border-[#46d68c]/25 bg-[#46d68c]/[0.08]"
                      }`}
                    >
                      <span className="min-w-0 truncate text-[28px] text-white/90">{v.label}</span>
                      <span className="flex shrink-0 items-center gap-[16px]">
                        <span
                          className={`text-[22px] ${v.error ? "text-[#ffb3a6]" : "text-white/50"}`}
                        >
                          {v.error
                            ? t("codeEntry.voucherGz.rowNeedsHelp")
                            : t("codeEntry.voucherGz.comesOff")}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeCartVoucher(v.code)}
                          aria-label={t("promo.banner.clear")}
                          className="k-tap px-[8px] text-[28px] leading-none text-white/40"
                        >
                          ✕
                        </button>
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
          </div>

          {/* Add another — scan and type share ONE box, directly under the
              list (owner: the split dashed-box + floating input read as
              clutter). The scanner stays live the whole time. */}
          <div className="mt-[24px] rounded-[20px] border border-[#00e2e5]/30 bg-[#00e2e5]/[0.05] px-[28px] py-[22px] text-left">
            <div className="text-[28px] font-extrabold text-[#00e2e5]">
              {t("codeEntry.voucherGz.scanNext")}
            </div>
            <div className="mt-[2px] text-[20px] text-white/50">
              {t("codeEntry.voucherGz.scanNextSub")}
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
                {t("codeEntry.voucherGz.leaveWarn", { n: codes.length })}
              </div>
              <div className="mt-[16px] flex gap-[24px]">
                <button
                  type="button"
                  onClick={() => {
                    console.warn(
                      `[kiosk] guest LEFT ${codes.length} unprinted card(s): ${codes.join(", ")}`,
                    );
                    clarityEvent("kiosk:receipt:leave-anyway");
                    onBack();
                  }}
                  className="k-btn-ghost k-tap"
                >
                  {t("codeEntry.voucherGz.leaveAnyway")}
                </button>
                <button type="button" onClick={startPrint} className="k-btn-primary k-tap">
                  {t("codeEntry.voucherGz.printNow", { n: codes.length })}
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

  if (mode === "scan") {
    return (
      <div className="flex h-full flex-col items-center px-[64px] pb-[40px] pt-[96px] text-center">
        <div className="k-eyebrow">{t("codeEntry.eyebrow")}</div>
        <h1 className="k-display mt-[24px] text-[84px]">{t("codeEntry.scanTitle")}</h1>
        <p className="mt-[20px] max-w-[24ch] text-[30px] leading-[1.4] text-white/70">
          {t("codeEntry.scanHint.body")}
        </p>

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
