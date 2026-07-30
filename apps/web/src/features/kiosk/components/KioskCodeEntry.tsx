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
import { voucherDisplayName } from "~/features/booking/service/voucher-redeem";
import { kioskVoucherGzEnabled } from "../flags";
import { clarityEvent } from "~/lib/clarity";
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
  | { kind: "applied"; promo: AppliedPromo }
  | { kind: "bmi-voucher"; code: string }
  | { kind: "voucher-accepted"; code: string; name?: string }
  /**
   * Native (HPW) vouchers accepted at the coupon screen — a running RECEIPT
   * (owner 2026-07-30). Auto-split: CART items (race / laser) are dispatched
   * into the booking session as scanned (`cartLabels` acknowledges them, "comes
   * off at checkout"); GAME-ZONE items land in `gzCards` (code + token value)
   * for the dispense basket. The receipt shows a running value total and keeps
   * the scanner ARMED so a family adds every voucher before finishing.
   */
  | {
      kind: "voucher-gamecard";
      gzCards: { code: string; tokens: number }[];
      cartLabels: string[];
      name?: string;
    }
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
}) {
  const t = useT();
  const { config } = useKioskConfig();
  // SCAN is the primary action (owner 2026-07-27) — typing is the fallback.
  const [mode, setMode] = useState<"scan" | "type">("scan");
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const checkingRef = useRef(false);
  /** Native codes already handled this session — a re-scan is a no-op. */
  const processedNativeRef = useRef<Set<string>>(new Set());

  const routeClassified = useCallback(
    async (kind: KioskCodeKind, code: string) => {
      if (checkingRef.current) return;
      setError(null);
      clarityEvent(`kiosk:code:${kind}`);
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
              setError(t(VOUCHER_ERR_KEY[data.reason ?? ""] ?? "codeEntry.err.generic"));
              return;
            }
            // A Game Zone card comp has no cart leg — it's fulfilled by
            // dispensing a card. Hand it to the Game Zone screen with the code
            // already in hand instead of parking it in a cart it can't reduce.
            if (data.target === "gamecard" && kioskVoucherGzEnabled()) {
              clarityEvent("kiosk:voucher:gamecard");
              // BMI comp gamecard — token value isn't known at peek, so the
              // receipt shows the card without a "$ in play" figure (tokens:0).
              setPanel((prev) => {
                const base =
                  prev?.kind === "voucher-gamecard"
                    ? prev
                    : { kind: "voucher-gamecard" as const, gzCards: [], cartLabels: [] };
                if (base.gzCards.some((c) => c.code === code)) return base;
                return { ...base, gzCards: [...base.gzCards, { code, tokens: 0 }], name: data.name };
              });
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
            setPanel({ kind: "voucher-accepted", code, name: data.name });
          } catch {
            onVoucherAccepted(code);
            setPanel({ kind: "voucher-accepted", code });
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
          // Build the receipt rows. GAME-ZONE items carry their token value;
          // CART items show their coverage name (title-cased). Both accumulate
          // across scans; the scanner stays live so the guest adds every one.
          const newGzCards =
            gz.length > 0 && kioskVoucherGzEnabled()
              ? gz.map((i) => ({ code, tokens: i.tokens ?? 0 }))
              : [];
          const newCartLabels = didApplyCart
            ? cart.map((i) => {
                const n = i.coverageName as string;
                return n.charAt(0).toUpperCase() + n.slice(1);
              })
            : [];
          setPanel((prev) => {
            const base =
              prev?.kind === "voucher-gamecard"
                ? prev
                : { kind: "voucher-gamecard" as const, gzCards: [], cartLabels: [] };
            return {
              kind: "voucher-gamecard",
              gzCards: [...base.gzCards, ...newGzCards],
              cartLabels: [...base.cartLabels, ...newCartLabels],
              name: base.name,
            };
          });
        } catch {
          setError(t("codeEntry.err.generic"));
        } finally {
          checkingRef.current = false;
          setChecking(false);
        }
        return;
      }
      if (kind === "game-card") {
        setPanel({ kind: "game-card" });
        return;
      }
      if (kind === "gift-card") {
        setPanel({ kind: "gift-card" });
        return;
      }
      if (kind === "unknown") {
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
          setPanel({ kind: "applied", promo: data.promo });
        } else {
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
    [appliedVoucherCodes, config, onApplied, onVoucherAccepted, onNativeCartItems, t, voucherRedeem],
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
      const { gzCards, cartLabels } = panel;
      const codes = [...new Set(gzCards.map((c) => c.code))];
      const totalTokens = gzCards.reduce((sum, c) => sum + c.tokens, 0);
      const totalBits = [
        totalTokens > 0
          ? t("codeEntry.voucherGz.inPlay", { amount: tokensInPlay(totalTokens) })
          : null,
        cartLabels.length > 0 ? t("codeEntry.voucherGz.onOrder", { n: cartLabels.length }) : null,
      ].filter(Boolean) as string[];
      const finish =
        codes.length > 0
          ? {
              label: t("codeEntry.voucherGz.finishCards", { n: codes.length }),
              onClick: () => onOpenGameZone(codes),
            }
          : { label: t("codeEntry.voucherGz.finishNoCards"), onClick: onBack };
      return (
        <div className="flex h-full flex-col px-[64px] pb-[40px] pt-[80px]">
          <div className="k-eyebrow">{t("codeEntry.eyebrow")}</div>
          <h1 className="k-display mt-[14px] text-[68px] text-[#f800c6]">
            {t("codeEntry.voucherGz.receiptTitle")}
          </h1>
          {totalBits.length > 0 && (
            <div className="mt-[8px] text-[30px] text-white/70">{totalBits.join("  ·  ")}</div>
          )}

          <div className="mt-[32px] min-h-0 flex-1 space-y-[26px] overflow-y-auto text-left">
            {gzCards.length > 0 && (
              <section>
                <div className="k-eyebrow text-[#f800c6]">
                  {t("codeEntry.voucherGz.printingTitle")}
                </div>
                <div className="mt-[4px] text-[20px] text-white/45">
                  {t("codeEntry.voucherGz.printingSub")}
                </div>
                <ul className="mt-[14px] space-y-[10px]">
                  {gzCards.map((c, i) => (
                    <li
                      key={`${c.code}-${i}`}
                      className="flex items-center justify-between rounded-[16px] border border-white/12 bg-white/[0.04] px-[24px] py-[16px]"
                    >
                      <span className="text-[28px] text-white/90">
                        {c.tokens > 0
                          ? t("codeEntry.voucherGz.cardTokens", { tokens: c.tokens })
                          : t("codeEntry.voucherGz.gameCardGeneric")}
                      </span>
                      {c.tokens > 0 && (
                        <span className="text-[24px] text-[#46d68c]">
                          {t("codeEntry.voucherGz.inPlay", { amount: tokensInPlay(c.tokens) })}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {cartLabels.length > 0 && (
              <section>
                <div className="k-eyebrow text-[#46d68c]">
                  {t("codeEntry.voucherGz.appliedSectionTitle")}
                </div>
                <ul className="mt-[14px] space-y-[10px]">
                  {cartLabels.map((label, i) => (
                    <li
                      key={`${label}-${i}`}
                      className="flex items-center justify-between rounded-[16px] border border-[#46d68c]/25 bg-[#46d68c]/[0.08] px-[24px] py-[16px]"
                    >
                      <span className="text-[28px] text-white/90">{label}</span>
                      <span className="text-[22px] text-white/50">
                        {t("codeEntry.voucherGz.comesOff")}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <div
            className="min-h-[40px] text-center text-[24px] text-[#ff8c7a]"
            role="alert"
            aria-live="polite"
          >
            {checking ? (
              <span className="text-white/55">{t("codeEntry.checking")}</span>
            ) : (
              (error ?? "")
            )}
          </div>

          {/* Scanner stays live — "scan another" is the PROMINENT affordance,
              finishing is secondary (owner: don't nudge them off after one). */}
          <div className="rounded-[20px] border-2 border-dashed border-[#00e2e5]/40 bg-[#00e2e5]/[0.06] px-[28px] py-[20px] text-center">
            <div className="text-[30px] font-extrabold text-[#00e2e5]">
              {t("codeEntry.voucherGz.scanNext")}
            </div>
            <div className="mt-[4px] text-[22px] text-white/55">
              {t("codeEntry.voucherGz.scanNextSub")}
            </div>
          </div>

          <div className="mt-[20px] flex gap-[24px]">
            <button type="button" onClick={onBack} className="k-btn-ghost k-tap">
              {t("codeEntry.back")}
            </button>
            <button type="button" onClick={finish.onClick} className="k-btn-primary k-tap">
              {finish.label}
            </button>
          </div>
        </div>
      );
    }

    const p =
      panel.kind === "applied"
        ? {
            title: t("codeEntry.applied.title"),
            body: t("codeEntry.applied.body"),
            cta: t("codeEntry.applied.cta"),
            accent: "#e8b14c",
            detail: appliedSummary(t, panel.promo),
            onCta: onBack,
          }
        : panel.kind === "voucher-accepted"
          ? {
              title: panel.name
                ? t("codeEntry.voucherOk.titleNamed", { name: voucherDisplayName(panel.name) })
                : t("codeEntry.voucherOk.title"),
              body: t("codeEntry.voucherOk.body"),
              cta: t("codeEntry.voucherOk.cta"),
              accent: "#46d68c",
              detail: panel.code,
              onCta: onBack,
            }
          : panel.kind === "bmi-voucher"
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
