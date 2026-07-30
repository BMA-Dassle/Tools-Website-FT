"use client";

/**
 * Kiosk gift-card payment flow (split-tender v1 — "match web": ONE gift card
 * + ONE reader tap; guest copy never says "split", owner 2026-07-29, mockup
 * approved 2026-07-29).
 *
 * Screens: capture (scan / swipe / type) → confirm (balance + apply) →
 * applied board (chip + LEFT TO PAY) → reader tap for the remainder →
 * capture → onCaptured (CheckoutStep reserves with the full payment set).
 * A gift card that covers the whole total skips the reader.
 *
 * Money truth lives server-side: the balance/applied amounts come from the
 * lookup + tender routes, the reader arms for the SERVER-computed remainder,
 * and capture verifies the sum before PayOrder. Unmounting without capture
 * fires /abandon (keepalive) so no hold outlives the session.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Brand } from "~/features/booking";
import { useT } from "../../i18n";
import { useKioskConfig } from "../../KioskConfigContext";
import { useSerialMsr } from "../../card-reader/useSerialMsr";
import { KioskReaderCheckout } from "../KioskReaderCheckout";
import { GiftCardScanListener } from "./GiftCardScanListener";
import {
  abandonSplit,
  addGiftCardTender,
  captureSplit,
  lookupGiftCard,
  removeGiftCardTender,
} from "./client";

type Phase =
  | { step: "capture"; manual: boolean; busy?: boolean }
  | { step: "confirm"; lookupToken: string; last4: string; balanceCents: number; busy?: boolean }
  | { step: "board"; last4: string; appliedCents: number; remainingCents: number; busy?: boolean }
  | { step: "tap"; last4: string; appliedCents: number; remainingCents: number }
  | { step: "capturing" };

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function KioskGiftCardFlow({
  brand,
  deviceId,
  seed,
  splitToken,
  totalCents,
  onCaptured,
  onExit,
}: {
  brand: Brand;
  deviceId: string;
  seed: string;
  splitToken: string;
  /** Server-authoritative checkout total (the gate's prepared depositCents). */
  totalCents: number;
  /** Whole set captured → CheckoutStep reserves with it (primary = the tap). */
  onCaptured: (result: { paymentId: string; paymentIds: string[] }) => void;
  /** Guest backed out — every hold has been released; return to the pay screen. */
  onExit: () => void;
}) {
  const t = useT();
  const { config } = useKioskConfig();
  const [phase, setPhase] = useState<Phase>({ step: "capture", manual: false });
  const [error, setError] = useState<string | null>(null);
  const [manualGan, setManualGan] = useState("");
  const capturedRef = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Release every hold if the guest leaves any way other than a completed
  // capture (idle reset unmounts us; back button calls onExit after abandon).
  useEffect(() => {
    return () => {
      if (!capturedRef.current) abandonSplit({ seed, splitToken });
    };
  }, [seed, splitToken]);

  const lookup = useCallback(
    async (gan: string) => {
      const p = phaseRef.current;
      if (p.step !== "capture" || p.busy) return;
      setError(null);
      setPhase({ step: "capture", manual: p.manual, busy: true });
      const res = await lookupGiftCard({ seed, splitToken, gan });
      if (!res.ok) {
        setError(res.error || t("giftcard.err.lookup"));
        setPhase({ step: "capture", manual: p.manual });
        return;
      }
      setPhase({
        step: "confirm",
        lookupToken: res.lookupToken,
        last4: res.last4,
        balanceCents: res.balanceCents,
      });
    },
    [seed, splitToken, t],
  );

  // Physical card swipes — only when this kiosk's MSR is provisioned for
  // gift cards (config.msrUse). The hook discards bank-card tracks internally.
  const msrForGiftCards =
    !!config?.msrEnabled && (config.msrUse === "giftcard" || config.msrUse === "both");
  useSerialMsr({
    enabled: msrForGiftCards && phase.step === "capture",
    portInfo: config?.msrPortInfo ?? null,
    baud: config?.msrBaud ?? null,
    mode: "square-gift",
    onSwipe: (gan) => void lookup(gan),
    onBadSwipe: () => setError(t("giftcard.err.notGiftCard")),
  });

  const apply = useCallback(async () => {
    const p = phaseRef.current;
    if (p.step !== "confirm" || p.busy) return;
    setError(null);
    setPhase({ ...p, busy: true });
    const res = await addGiftCardTender({ seed, splitToken, lookupToken: p.lookupToken });
    if (!res.ok) {
      setError(res.error || t("giftcard.err.apply"));
      setPhase({ step: "capture", manual: false });
      return;
    }
    setPhase({
      step: "board",
      last4: res.tender.ganLast4,
      appliedCents: res.tender.amountCents,
      remainingCents: res.remainingCents,
    });
  }, [seed, splitToken, t]);

  const remove = useCallback(async () => {
    const p = phaseRef.current;
    if (p.step !== "board" || p.busy) return;
    setPhase({ ...p, busy: true });
    await removeGiftCardTender({ seed, splitToken });
    setError(null);
    setPhase({ step: "capture", manual: false });
  }, [seed, splitToken]);

  const finalize = useCallback(async () => {
    setPhase({ step: "capturing" });
    const res = await captureSplit({ seed, splitToken });
    if (!res.ok) {
      setError(res.error || t("giftcard.err.capture"));
      // Holds are intact — back to the board so the guest (or staff) retries.
      const p = phaseRef.current;
      if (p.step === "capturing") setPhase({ step: "capture", manual: false });
      return;
    }
    capturedRef.current = true;
    onCaptured({ paymentId: res.primaryPaymentId, paymentIds: res.paymentIds });
  }, [seed, splitToken, onCaptured, t]);

  const exit = useCallback(() => {
    // Explicit back-out: release holds NOW (unmount also fires it — idempotent).
    abandonSplit({ seed, splitToken });
    onExit();
  }, [seed, splitToken, onExit]);

  // ── capture: scan / swipe / type ─────────────────────────────────────────
  if (phase.step === "capture") {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 py-4">
        <GiftCardScanListener
          onCandidate={(gan) => void lookup(gan)}
          onReject={(kind) =>
            setError(kind === "license" ? t("giftcard.err.notGiftCard") : t("giftcard.err.lookup"))
          }
        />
        <div className="flex items-baseline justify-between">
          <div className="k-eyebrow text-[#00e2e5]">{t("giftcard.eyebrow")}</div>
          <div className="text-lg text-white/50">
            {t("giftcard.leftToPay")} <b className="text-white">{fmt(totalCents)}</b>
          </div>
        </div>
        <h2 className="k-display text-4xl text-white">{t("giftcard.addTitle")}</h2>
        <div className="k-glass flex items-start gap-4 p-5 text-lg text-white">
          <span aria-hidden="true" className="text-2xl">
            📷
          </span>
          <span>{t("giftcard.scanPrompt")}</span>
        </div>
        {msrForGiftCards && (
          <div className="k-glass flex items-start gap-4 p-5 text-lg text-white">
            <span aria-hidden="true" className="text-2xl">
              💳
            </span>
            <span>{t("giftcard.swipePrompt")}</span>
          </div>
        )}
        {phase.busy ? (
          <div className="k-glass p-5 text-center text-lg text-white/70">
            {t("giftcard.checking")}
          </div>
        ) : phase.manual ? (
          <div className="k-glass flex flex-col gap-4 p-5">
            <label className="text-sm uppercase tracking-widest text-white/50">
              {t("giftcard.numberLabel")}
              <input
                type="text"
                inputMode="numeric"
                data-osk-layout="numeric"
                autoComplete="off"
                value={manualGan}
                onChange={(e) => setManualGan(e.target.value.replace(/[^A-Za-z0-9]/g, ""))}
                className="mt-2 w-full rounded-2xl border border-white/15 bg-white/5 px-5 py-4 text-2xl tracking-widest text-white focus:border-[#00E2E5] focus:outline-none"
              />
            </label>
            <button
              type="button"
              disabled={manualGan.length < 8}
              onClick={() => void lookup(manualGan)}
              className="font-heading rounded-full bg-[#00e2e5] px-8 py-3 text-lg font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
            >
              {t("giftcard.lookupCta")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setPhase({ step: "capture", manual: true })}
            className="font-heading rounded-full border-2 border-white/15 px-8 py-3 text-lg font-bold uppercase tracking-widest text-white/60"
          >
            {t("giftcard.typeInstead")}
          </button>
        )}
        {error && (
          <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-6 py-4 text-lg text-red-100">
            {error}
          </div>
        )}
        <button
          type="button"
          onClick={exit}
          className="font-heading rounded-full border-2 border-white/15 px-8 py-3 text-lg font-bold uppercase tracking-widest text-white/60"
        >
          {t("pay.back")}
        </button>
      </div>
    );
  }

  // ── confirm: balance + apply ─────────────────────────────────────────────
  if (phase.step === "confirm") {
    const applyCents = Math.min(phase.balanceCents, totalCents);
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 py-4 text-center">
        <div className="k-eyebrow text-left text-[#00e2e5]">{t("giftcard.eyebrow")}</div>
        <div className="k-glass flex flex-col gap-3 p-8">
          <div className="k-display text-3xl text-white">
            {t("giftcard.found", { last4: phase.last4 })}
          </div>
          <div className="text-2xl font-extrabold text-[#46d68c]">
            {t("giftcard.balance", { amount: fmt(phase.balanceCents) })}
          </div>
          <div className="text-lg text-white/50">
            {t("giftcard.applyQuestion", { amount: fmt(applyCents) })}
          </div>
        </div>
        <button
          type="button"
          disabled={phase.busy}
          onClick={() => void apply()}
          className="font-heading rounded-full bg-[#00e2e5] px-8 py-4 text-xl font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
        >
          {t("giftcard.applyCta", { amount: fmt(applyCents) })}
        </button>
        <button
          type="button"
          onClick={() => setPhase({ step: "capture", manual: false })}
          className="font-heading rounded-full border-2 border-white/15 px-8 py-3 text-lg font-bold uppercase tracking-widest text-white/60"
        >
          {t("pay.back")}
        </button>
      </div>
    );
  }

  // ── applied board ────────────────────────────────────────────────────────
  if (phase.step === "board") {
    const coversAll = phase.remainingCents <= 0;
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 py-4">
        <div className="flex items-baseline justify-between">
          <div className="k-eyebrow text-[#00e2e5]">{t("giftcard.appliedEyebrow")}</div>
          <div className="text-lg text-white/50">
            {t("giftcard.total")} <b className="text-white">{fmt(totalCents)}</b>
          </div>
        </div>
        <div className="k-glass flex items-center gap-3 p-5 text-lg text-white">
          <span className="font-extrabold text-[#46d68c]">✓</span>
          <span>
            {t("giftcard.appliedChip", { last4: phase.last4, amount: fmt(phase.appliedCents) })}
          </span>
          <button
            type="button"
            disabled={phase.busy}
            onClick={() => void remove()}
            className="ml-auto rounded-full border border-white/20 px-4 py-1.5 text-sm text-white/60 disabled:opacity-40"
          >
            {t("giftcard.remove")}
          </button>
        </div>
        {!coversAll && (
          <div className="py-4 text-center">
            <div className="k-eyebrow text-white/40">{t("giftcard.leftToPay")}</div>
            <div className="k-display mt-1 text-6xl text-white">{fmt(phase.remainingCents)}</div>
          </div>
        )}
        {error && (
          <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-6 py-4 text-lg text-red-100">
            {error}
          </div>
        )}
        <button
          type="button"
          disabled={phase.busy}
          onClick={() =>
            coversAll
              ? void finalize()
              : setPhase({
                  step: "tap",
                  last4: phase.last4,
                  appliedCents: phase.appliedCents,
                  remainingCents: phase.remainingCents,
                })
          }
          className="font-heading rounded-full bg-[#00e2e5] px-8 py-4 text-xl font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
        >
          {coversAll
            ? t("giftcard.finishPayment")
            : t("giftcard.payRest", { amount: fmt(phase.remainingCents) })}
        </button>
        <button
          type="button"
          disabled={phase.busy}
          onClick={exit}
          className="font-heading rounded-full border-2 border-white/15 px-8 py-3 text-lg font-bold uppercase tracking-widest text-white/60"
        >
          {t("giftcard.cancelStartOver")}
        </button>
      </div>
    );
  }

  // ── reader tap for the remainder (auth-only; captured atomically after) ──
  if (phase.step === "tap") {
    return (
      <KioskReaderCheckout
        brand={brand}
        deviceId={deviceId}
        seed={seed}
        depositOrderId="" // split mode: the server derives the order from the anchor
        depositCents={phase.remainingCents}
        split={{ splitToken, amountCents: phase.remainingCents }}
        onCaptured={() => void finalize()}
        onCancel={() =>
          setPhase({
            step: "board",
            last4: phase.last4,
            appliedCents: phase.appliedCents,
            remainingCents: phase.remainingCents,
          })
        }
      />
    );
  }

  // ── capturing ────────────────────────────────────────────────────────────
  return <div className="py-8 text-center text-xl text-white/70">{t("pay.finishingBooking")}</div>;
}
