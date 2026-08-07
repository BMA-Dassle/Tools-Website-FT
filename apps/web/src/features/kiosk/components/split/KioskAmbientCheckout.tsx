"use client";

/**
 * The AMBIENT pay screen (2026-08, owner: "scan/swipe a gift card without them
 * having to indicate anything") — one always-visible screen that replaces the
 * legacy reader screen + the amber "Use a gift card" button + the multi-step
 * KioskGiftCardFlow whenever the server says `ambient` at prepare.
 *
 * Layout, top to bottom: total → applied-tenders board (gift-card rows with
 * Remove; card-hold rows without — a tapped hold is only undone by
 * cancel-everything) → big LEFT TO PAY → reader loader → ambient hint →
 * typed-entry affordance → Cancel.
 *
 * Money discipline:
 *  - ONE live Terminal checkout, ever — every dismiss→re-arm runs through a
 *    serialized arm queue (armBusyRef), the ambient successor to the amber
 *    button's dismiss-before-handoff interlock.
 *  - The server owns every amount: arming sends NO amount (the route arms the
 *    anchor's remainder), scans auto-apply min(balance, remaining) server-side,
 *    and the poll's `remainingCents` is the only remainder this screen shows.
 *  - A swiped gift card that can't cover the armed amount partially approves:
 *    the poll reports {captured:false, tender, remainingCents} → the board
 *    grows a row and the reader re-arms automatically for the remainder.
 *  - coversAll (a scan zeroes the remainder): a short "finishing up" beat with
 *    Remove still live (the last chance to back out of the wrong card), then
 *    the idempotent capture — a tap-completed set instead captures inline
 *    server-side, no beat (the tap was the guest's final act).
 *  - Exits with uncaptured holds go through abandon (confirm sheet when money
 *    is applied); the split-session-registry + server sweep cover exits this
 *    component never sees (idle hard-reload, crash).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Brand } from "~/features/booking";
import { BrandedLoader } from "../BrandedLoader";
import { useT } from "../../i18n";
import {
  classifyPoll,
  canAddGiftCard,
  afterCancelSignal,
  afterDeadline,
  errorKeyForCode,
} from "./ambient-checkout-machine";
import { GiftCardScanListener } from "./GiftCardScanListener";
import {
  abandonSplit,
  addGiftCardTender,
  captureSplit,
  getSplitStatus,
  lookupGiftCard,
  removeGiftCardTender,
  type BoardTender,
} from "./client";
import { markSplitCaptured } from "./split-session-registry";

const POLL_MS = 1500;
const ARM_DEADLINE_MS = 180_000;
/** The coversAll beat: Remove stays tappable this long before capture. */
const COVERS_ALL_BEAT_MS = 3_000;

type Phase =
  | { step: "arming" }
  | { step: "armed" }
  | { step: "applying" } // lookup+add in flight — reader dismissed
  | { step: "finishing" } // coversAll beat, then capture
  | { step: "capturing" }
  | { step: "done" }
  | { step: "cancelConfirm" };

const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function KioskAmbientCheckout({
  brand,
  deviceId,
  seed,
  splitToken,
  totalCents,
  onCaptured,
  onCancel,
}: {
  brand: Brand;
  deviceId: string;
  seed: string;
  splitToken: string;
  /** Server-authoritative checkout total (the gate's prepared depositCents). */
  totalCents: number;
  /** Whole set captured → CheckoutStep reserves with it. */
  onCaptured: (result: { paymentId: string; paymentIds: string[] }) => void;
  /** Guest backed out — every hold released; return to the pay screen. */
  onCancel: () => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ step: "arming" });
  const [tenders, setTenders] = useState<BoardTender[]>([]);
  const [remainingCents, setRemainingCents] = useState(totalCents);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualGan, setManualGan] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);

  const checkoutIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beatRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** We dismissed the checkout ourselves — the next CANCELED poll is ours. */
  const suppressCancelRef = useRef(false);
  /** Serialized arm queue — one dismiss→arm cycle at a time, ever. */
  const armBusyRef = useRef(false);
  const capturedRef = useRef(false);
  // Latest-value mirrors for the long-lived poll/timer closures.
  const phaseRef = useRef(phase);
  const tendersRef = useRef(tenders);
  useEffect(() => {
    phaseRef.current = phase;
    tendersRef.current = tenders;
  }, [phase, tenders]);
  /** Breaks the arm ↔ poll mutual reference: the poll loop re-arms through
   *  this ref, which always points at the latest arm(). */
  const armRef = useRef<() => void>(() => {});

  const clearTimers = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (deadlineRef.current) clearTimeout(deadlineRef.current);
    pollRef.current = null;
    deadlineRef.current = null;
  }, []);

  const dismissArmed = useCallback(async () => {
    clearTimers();
    const id = checkoutIdRef.current;
    checkoutIdRef.current = null;
    if (id) {
      suppressCancelRef.current = true;
      await fetch(`/api/kiosk/terminal-checkout?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
  }, [clearTimers]);

  const finishCaptured = useCallback(
    (result: { paymentIds: string[]; primaryPaymentId?: string }) => {
      if (capturedRef.current) return;
      capturedRef.current = true;
      markSplitCaptured();
      clearTimers();
      setPhase({ step: "done" });
      onCaptured({
        paymentId: result.primaryPaymentId ?? result.paymentIds[0],
        paymentIds: result.paymentIds,
      });
    },
    [clearTimers, onCaptured],
  );

  /** The one capture entry point (coversAll beat + converge paths). */
  const capture = useCallback(async () => {
    if (capturedRef.current) return;
    setPhase({ step: "capturing" });
    const res = await captureSplit({ seed, splitToken });
    if (res.ok) {
      finishCaptured(res);
      return;
    }
    // Holds are intact — surface the error, let the guest (or staff) retry.
    setError(t("giftcard.err.capture"));
    setPhase({ step: "armed" });
    armRef.current();
  }, [seed, splitToken, finishCaptured, t]);

  const startPolling = useCallback(() => {
    clearTimers();
    deadlineRef.current = setTimeout(() => {
      // Money applied → the session survives (fresh arm, fresh 180s);
      // an empty board keeps today's walk-away semantics and exits.
      if (afterDeadline(tendersRef.current.length) === "rearm") armRef.current();
      else void dismissArmed().then(onCancel);
    }, ARM_DEADLINE_MS);
    pollRef.current = setInterval(async () => {
      const id = checkoutIdRef.current;
      if (!id) return;
      let pd: Parameters<typeof classifyPoll>[0];
      try {
        const pr = await fetch(
          `/api/kiosk/terminal-checkout?id=${encodeURIComponent(id)}&seed=${encodeURIComponent(seed)}&splitToken=${encodeURIComponent(splitToken)}`,
        );
        pd = await pr.json();
      } catch {
        return; // transient — keep polling to the deadline
      }
      const outcome = classifyPoll(pd);
      if (outcome.kind === "captured") {
        finishCaptured(outcome);
      } else if (outcome.kind === "partial") {
        // A short-approved swipe boarded server-side — show it and re-arm.
        checkoutIdRef.current = null;
        setTenders(outcome.tenders);
        setRemainingCents(outcome.remainingCents);
        setError(null);
        armRef.current();
      } else if (outcome.kind === "canceled") {
        const action = afterCancelSignal({
          selfDismissed: suppressCancelRef.current,
          tenderCount: tendersRef.current.length,
        });
        suppressCancelRef.current = false;
        if (action === "rearm") {
          checkoutIdRef.current = null;
          armRef.current();
        } else if (action === "exit") {
          clearTimers();
          onCancel();
        }
      }
    }, POLL_MS);
  }, [clearTimers, dismissArmed, finishCaptured, onCancel, seed, splitToken]);

  /**
   * Arm (or re-arm) the reader for the server-computed remainder. Serialized:
   * a second call while one is in flight is dropped — the in-flight cycle's
   * poll/partial handling always ends with its own re-arm decision.
   */
  const arm = useCallback(async () => {
    if (armBusyRef.current || capturedRef.current) return;
    armBusyRef.current = true;
    try {
      await dismissArmed();
      if (phaseRef.current.step !== "applying" && phaseRef.current.step !== "finishing") {
        setPhase({ step: "arming" });
      }
      const res = await fetch("/api/kiosk/terminal-checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId, referenceId: seed, seed, splitToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.captured && data.paymentIds?.length) {
        // A harvested tap (or a prior attempt) already covers everything.
        finishCaptured(data);
        return;
      }
      if (!res.ok || !data.checkoutId) {
        setError(data.error || t("pay.err.reachReader"));
        return;
      }
      if (typeof data.remainingCents === "number") setRemainingCents(data.remainingCents);
      checkoutIdRef.current = data.checkoutId;
      suppressCancelRef.current = false;
      setPhase({ step: "armed" });
      startPolling();
    } finally {
      armBusyRef.current = false;
    }
  }, [deviceId, seed, splitToken, dismissArmed, finishCaptured, startPolling, t]);
  useEffect(() => {
    armRef.current = () => void arm();
  }, [arm]);

  /** Scanned or typed GAN → lookup → auto-apply → board + re-arm. */
  const applyGan = useCallback(
    async (gan: string) => {
      const p = phaseRef.current.step;
      if (p !== "armed" && p !== "arming") return; // mid-apply/capture — ignore
      const cap = canAddGiftCard(tendersRef.current);
      if (cap !== "ok") {
        setError(t("giftcard.limitReached"));
        return;
      }
      setError(null);
      setPhase({ step: "applying" });
      // One live checkout at a time: retire the armed one BEFORE the hold.
      await dismissArmed();
      const lookup = await lookupGiftCard({ seed, splitToken, gan });
      if (!lookup.ok) {
        setError(t("giftcard.err.lookup"));
        void arm();
        return;
      }
      const applied = await addGiftCardTender({
        seed,
        splitToken,
        lookupToken: lookup.lookupToken,
      });
      if (!applied.ok) {
        if (applied.code === "already-captured") {
          // A harvested tap covered everything while this scan was in flight —
          // converge on the idempotent capture.
          void capture();
          return;
        }
        setError(t(errorKeyForCode(applied.code)));
        void arm();
        return;
      }
      setManualOpen(false);
      setManualGan("");
      setTenders((prev) => [
        ...prev,
        {
          kind: "gift_card",
          isGiftCard: true,
          paymentId: applied.tender.paymentId,
          last4: applied.tender.ganLast4,
          amountCents: applied.tender.amountCents,
        },
      ]);
      setRemainingCents(applied.remainingCents);
      if (applied.remainingCents === 0) {
        // coversAll — the beat keeps Remove tappable before the capture.
        setPhase({ step: "finishing" });
        beatRef.current = setTimeout(() => void capture(), COVERS_ALL_BEAT_MS);
        return;
      }
      void arm();
    },
    [arm, capture, dismissArmed, seed, splitToken, t],
  );

  const removeTender = useCallback(
    async (paymentId: string) => {
      if (capturedRef.current || removingId) return;
      // Mid-beat Remove aborts the coversAll capture.
      if (beatRef.current) {
        clearTimeout(beatRef.current);
        beatRef.current = null;
      }
      setRemovingId(paymentId);
      setError(null);
      // The server harvests + dismisses the armed checkout itself.
      suppressCancelRef.current = true;
      clearTimers();
      checkoutIdRef.current = null;
      const res = await removeGiftCardTender({ seed, splitToken, paymentId });
      setRemovingId(null);
      if (!res.ok) {
        setError(t("giftcard.err.apply"));
      } else {
        setTenders((prev) => prev.filter((x) => x.paymentId !== paymentId));
        if (typeof res.remainingCents === "number") setRemainingCents(res.remainingCents);
      }
      void arm();
    },
    [arm, clearTimers, removingId, seed, splitToken, t],
  );

  const exitWithUnwind = useCallback(() => {
    abandonSplit({ seed, splitToken });
    clearTimers();
    onCancel();
  }, [clearTimers, onCancel, seed, splitToken]);

  const cancelPressed = useCallback(() => {
    if (tendersRef.current.length > 0) {
      setPhase({ step: "cancelConfirm" });
      return;
    }
    void dismissArmed().then(onCancel);
  }, [dismissArmed, onCancel]);

  // Mount: resume any prior board state (refresh/crash), then arm. Unmount:
  // stop timers only — hold release belongs to the registry + explicit exits
  // (a re-render unmount must never void a guest's applied money).
  useEffect(() => {
    void (async () => {
      const status = await getSplitStatus({ seed, splitToken });
      if (status.ok && status.status.tenders.length > 0) {
        setTenders(status.status.tenders);
        setRemainingCents(status.status.remainingCents);
      }
      void arm();
    })();
    return () => {
      clearTimers();
      if (beatRef.current) clearTimeout(beatRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busyApplying = phase.step === "applying";
  const scanEnabled =
    (phase.step === "armed" || phase.step === "arming") && remainingCents > 0 && !manualOpen;

  // ── cancel confirm sheet ───────────────────────────────────────────────────
  if (phase.step === "cancelConfirm") {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 py-8 text-center">
        <h2 className="k-display text-3xl text-white">{t("giftcard.cancelConfirm.title")}</h2>
        <div className="k-glass p-6 text-lg text-white/80">{t("giftcard.cancelConfirm.body")}</div>
        <button
          type="button"
          onClick={() => {
            setPhase({ step: "armed" });
            void arm();
          }}
          className="font-heading rounded-full bg-[#00e2e5] px-8 py-4 text-xl font-extrabold uppercase italic text-[#04252b]"
        >
          {t("giftcard.cancelConfirm.keep")}
        </button>
        <button
          type="button"
          onClick={exitWithUnwind}
          className="font-heading rounded-full border-2 border-white/15 px-8 py-3 text-lg font-bold uppercase tracking-widest text-white/60"
        >
          {t("giftcard.cancelConfirm.confirm")}
        </button>
      </div>
    );
  }

  // ── capturing / done ───────────────────────────────────────────────────────
  if (phase.step === "capturing" || phase.step === "done") {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-8 py-8 text-center">
        <BrandedLoader
          brand={brand}
          label={t("pay.reader.paymentReceived")}
          sublabel={t("pay.finishingBooking")}
        />
      </div>
    );
  }

  // ── the one pay screen ─────────────────────────────────────────────────────
  return (
    <div className="mx-auto flex max-w-md flex-col gap-5 py-4">
      <GiftCardScanListener
        enabled={scanEnabled}
        onCandidate={(gan) => void applyGan(gan)}
        onReject={(kind) =>
          setError(
            kind === "license" ? t("giftcard.err.notGiftCard") : t("giftcard.err.scanNotUsable"),
          )
        }
      />
      <div className="flex items-baseline justify-between">
        <div className="k-eyebrow text-[#00e2e5]">{t("giftcard.eyebrow")}</div>
        <div className="text-lg text-white/50">
          {t("giftcard.total")} <b className="text-white">{fmt(totalCents)}</b>
        </div>
      </div>

      {tenders.length > 0 && (
        <div className="flex flex-col gap-3">
          {tenders.map((tender) => (
            <div
              key={tender.paymentId ?? `${tender.kind}-${tender.amountCents}`}
              className="k-glass flex items-center gap-3 p-5 text-lg text-white"
            >
              <span className="font-extrabold text-[#46d68c]">✓</span>
              <span>
                {tender.isGiftCard
                  ? t("giftcard.appliedChip", {
                      last4: tender.last4 ?? "????",
                      amount: fmt(tender.amountCents),
                    })
                  : t("giftcard.cardHold", {
                      last4: tender.last4 ?? "????",
                      amount: fmt(tender.amountCents),
                    })}
              </span>
              {tender.isGiftCard && tender.paymentId && (
                <button
                  type="button"
                  disabled={!!removingId || busyApplying}
                  onClick={() => void removeTender(tender.paymentId as string)}
                  className="ml-auto rounded-full border border-white/20 px-4 py-1.5 text-sm text-white/60 disabled:opacity-40"
                >
                  {removingId === tender.paymentId ? "…" : t("giftcard.remove")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {phase.step === "finishing" ? (
        <div className="py-4 text-center">
          <BrandedLoader brand={brand} label={t("giftcard.coversAll")} />
        </div>
      ) : (
        <>
          {tenders.length > 0 && (
            <div className="py-2 text-center">
              <div className="k-eyebrow text-white/40">{t("giftcard.leftToPay")}</div>
              <div className="k-display mt-1 text-6xl text-white">{fmt(remainingCents)}</div>
            </div>
          )}
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            {busyApplying ? (
              <BrandedLoader brand={brand} label={t("giftcard.applying")} />
            ) : (
              <BrandedLoader
                brand={brand}
                label={t("pay.reader.followPrompts")}
                sublabel={t("pay.reader.tapToPay", { amount: fmt(remainingCents) })}
              />
            )}
          </div>
          <div className="rounded-2xl border border-[#e8b14c]/40 bg-[#e8b14c]/10 px-6 py-4 text-lg text-[#f5d896]">
            {t("giftcard.ambientHint")}
          </div>
          {manualOpen ? (
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
                disabled={manualGan.length < 8 || busyApplying}
                onClick={() => void applyGan(manualGan)}
                className="font-heading rounded-full bg-[#00e2e5] px-8 py-3 text-lg font-extrabold uppercase italic text-[#04252b] disabled:opacity-40"
              >
                {t("giftcard.lookupCta")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setManualOpen(true)}
              className="text-base text-white/40 underline underline-offset-4"
            >
              {t("giftcard.enterNumber")}
            </button>
          )}
        </>
      )}

      {error && (
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-6 py-4 text-lg text-red-100">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={cancelPressed}
        disabled={busyApplying || phase.step === "finishing"}
        className="font-heading rounded-full border-2 border-white/15 px-8 py-3 text-lg font-bold uppercase tracking-widest text-white/60 disabled:opacity-40"
      >
        {t("pay.cancel")}
      </button>
    </div>
  );
}
