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

type Panel =
  | { kind: "applied"; promo: AppliedPromo }
  | { kind: "bmi-voucher"; code: string }
  | { kind: "game-card" }
  | { kind: "gift-card" };

export function KioskCodeEntry({
  onApplied,
  onBack,
  onOpenGameZone,
}: {
  /** Valid promo → parent dispatches applyPromo; this screen shows the
   *  success panel and the CTA returns to the categories. */
  onApplied: (promo: AppliedPromo) => void;
  onBack: () => void;
  onOpenGameZone: () => void;
}) {
  const t = useT();
  const { config } = useKioskConfig();
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
        setPanel({ kind: "bmi-voucher", code });
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
    [config, onApplied, t],
  );

  const handleRaw = useCallback(
    (raw: string) => {
      if (!raw.trim() || panel) return;
      const c = classifyKioskCode(raw);
      setValue(c.kind === "promo" || c.kind === "bmi-voucher" ? c.value : "");
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
          <button type="button" onClick={p.onCta} className="k-btn-primary k-tap">
            {p.cta}
          </button>
        </div>
      </div>
    );
  }

  // ── Entry ──
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
      <div
        className="mt-[20px] min-h-[44px] text-[28px] leading-[1.35] text-[#ff8c7a]"
        role="alert"
        aria-live="polite"
      >
        {checking ? (
          <span className="text-white/55">{t("codeEntry.checking")}</span>
        ) : (
          (error ?? "")
        )}
      </div>

      <div className="mt-[28px] flex items-center gap-[28px]">
        <ScanGlyph />
        <p className="text-[28px] leading-[1.4] text-white/70">
          <span className="font-bold text-[#00e2e5]">{t("codeEntry.scanHint.lead")}</span> —{" "}
          {t("codeEntry.scanHint.body")}
        </p>
      </div>

      <div className="mt-auto flex gap-[24px]">
        <button type="button" onClick={onBack} className="k-btn-ghost k-tap">
          {t("codeEntry.back")}
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

/** Small QR-corners glyph pointing at the under-screen scanner. */
function ScanGlyph() {
  return (
    <svg
      width="88"
      height="88"
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
