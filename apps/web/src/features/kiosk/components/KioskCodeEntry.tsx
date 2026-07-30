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

type Panel =
  | { kind: "applied"; promo: AppliedPromo }
  | { kind: "bmi-voucher"; code: string }
  | { kind: "voucher-accepted"; code: string; name?: string }
  /** A Game Zone card comp — fulfilled by dispensing a card, not by the cart. */
  | { kind: "voucher-gamecard"; code: string; name?: string }
  | { kind: "game-card" }
  | { kind: "gift-card" };

export function KioskCodeEntry({
  onApplied,
  onBack,
  onOpenGameZone,
  voucherRedeem = false,
  appliedVoucherCodes = [],
  onVoucherAccepted,
}: {
  /** Valid promo → parent dispatches applyPromo; this screen shows the
   *  success panel and the CTA returns to the categories. */
  onApplied: (promo: AppliedPromo) => void;
  onBack: () => void;
  /** Opens the Game Zone screen. A `voucherCode` seeds its voucher-redemption
   *  mode so a comp scanned HERE doesn't have to be scanned again there. */
  onOpenGameZone: (voucherCode?: string) => void;
  /** Voucher REDEMPTION live (voucherRedeemEnabled / ?kioskVoucher=1) — a
   *  scanned voucher is accepted into the session and auto-applies to the
   *  BMI bill at checkout. Off → the Guest Services guidance panel. */
  voucherRedeem?: boolean;
  /** Codes already on the session — a re-scan gets "already added". */
  appliedVoucherCodes?: string[];
  /** Parent dispatches the pending voucher into the session (name from the
   *  scan-time peek when BMI answered). */
  onVoucherAccepted?: (code: string, name?: string) => void;
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
              setPanel({ kind: "voucher-gamecard", code, name: data.name });
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
      // OUR OWN voucher (HPW…). Fulfilment is a dispensed card, not a cart
      // discount, so it belongs on the Game Zone rail — hand it over with the
      // code already in hand. This branch is REQUIRED: without it the code
      // falls through to the promo validator below and the guest is told
      // "we couldn't find that code" for a perfectly good voucher.
      if (kind === "native-voucher") {
        clarityEvent("kiosk:voucher:native");
        setPanel({ kind: "voucher-gamecard", code });
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
    [appliedVoucherCodes, config, onApplied, onVoucherAccepted, t, voucherRedeem],
  );

  const handleRaw = useCallback(
    (raw: string) => {
      if (!raw.trim() || panel) return;
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

  // Serial QR scanner — same provisioning knobs as the license scan.
  useQrScanner({
    enabled: !!config?.qrScannerEnabled && !panel,
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
    if (panel || !config?.scannerEnabled) return;
    wedgeArm();
    const id = setInterval(wedgeArm, 8_000);
    return () => clearInterval(id);
  }, [panel, config?.scannerEnabled, wedgeArm]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || checking) return;
    const c = classifyKioskCode(trimmed);
    void routeClassified(c.kind, c.value);
  };

  // ── Result panels ──
  if (panel) {
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
          : panel.kind === "voucher-gamecard"
            ? {
                title: panel.name
                  ? t("codeEntry.voucherGz.titleNamed", { name: voucherDisplayName(panel.name) })
                  : t("codeEntry.voucherGz.title"),
                body: t("codeEntry.voucherGz.body"),
                cta: t("codeEntry.voucherGz.cta"),
                accent: "#f800c6",
                detail: panel.code,
                onCta: () => onOpenGameZone(panel.code),
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
