"use client";

/**
 * Kiosk attraction time step — "book now" first.
 *
 * Replaces the web's AttractionDateStep + AttractionSlotStep pair in the
 * kiosk registry: the date is ALWAYS today (walk-up device), a hero card
 * offers the next available time in one tap (eager BMI hold, exactly the
 * web's hold semantics via bookAttractionOnAdvance), and the web's full
 * slot grid renders beneath as the "later today" path — inheriting its
 * conflict buffers, buyout windows, capacity states, and hold-switching.
 */
import { useEffect, useMemo, useState } from "react";
import type { AttractionItem, StepDef } from "~/features/booking";
import { bmiAdapter, type BmiBlock, type BmiProposal } from "~/features/booking/data/bmi";
import {
  resolveAttractionContext,
  bookAttractionOnAdvance,
} from "~/features/booking/service/attractions";
import { releaseItemBmiLines } from "~/features/booking/service/checkout";
import { getPublicReopenMinutes } from "@/lib/group-events";
import { AttractionSlotStep } from "~/components/features/booking/steps/attraction";
import { pickFirstSlot, slotLabel, slotStartMs, todayYmd } from "../service/first-available";
import { BrandedLoader } from "../components/BrandedLoader";

const KioskSlotStepComponent: StepDef<AttractionItem>["Component"] = (props) => {
  const { item, session, onChange, dispatch, setBusy } = props;
  const ctx = useMemo(
    () => (item.slug ? resolveAttractionContext(item.slug, session) : null),
    [item.slug, session],
  );

  const [firstPick, setFirstPick] = useState<{ block: BmiBlock; proposal: BmiProposal } | null>(
    null,
  );
  const [scanState, setScanState] = useState<"loading" | "done" | "error">("loading");
  const [holding, setHolding] = useState(false);
  const [holdError, setHoldError] = useState<string | null>(null);

  // Kiosk = walk-up: the date is always today. Stamp it once so the reused
  // slot grid (and the reserve path) see a concrete date.
  const today = todayYmd();
  useEffect(() => {
    if (item.date !== today) onChange({ date: today, slot: null, slotProposal: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.date, today]);

  // Find the next available slot for the party (no artificial lead time).
  useEffect(() => {
    if (!item.productId || !item.pageId || item.date !== today) return;
    let cancelled = false;
    setScanState("loading");
    bmiAdapter
      .getAvailability({
        date: today,
        productId: item.productId,
        pageId: item.pageId,
        quantity: item.qty,
        clientKey: ctx?.clientKey,
      })
      .then((res) => {
        if (cancelled) return;
        const byStart = new Map<string, { block: BmiBlock; proposal: BmiProposal }>();
        for (const proposal of res.proposals) {
          const block = proposal.blocks[0]?.block;
          if (block && !byStart.has(block.start)) byStart.set(block.start, { block, proposal });
        }
        const reopenMins = getPublicReopenMinutes(today);
        const beforeReopen = (start: string): boolean => {
          if (reopenMins == null) return false;
          const d = new Date(start.replace(/Z$/, ""));
          return d.getHours() * 60 + d.getMinutes() < reopenMins;
        };
        // Conservative cart-conflict skip: stay 30 min clear of anything else
        // booked this session (the grid below applies the exact per-building
        // buffers; a hero-pick landing in a conflict would fail its hold and
        // drop the guest to the grid anyway — this just avoids that bounce).
        const otherTimes: number[] = [];
        for (const other of session.items) {
          if (other.id === item.id) continue;
          if (other.kind === "race") {
            for (const h of other.heats) if (h.heatId) otherTimes.push(slotStartMs(h.heatId));
          } else if (other.kind === "attraction" && other.slot) {
            otherTimes.push(slotStartMs(other.slot));
          } else if ((other.kind === "bowling" || other.kind === "kbf") && other.bookedAt) {
            otherTimes.push(slotStartMs(other.bookedAt));
          }
        }
        const conflictsCart = (start: string): boolean => {
          const ms = slotStartMs(start);
          return otherTimes.some((t) => Math.abs(t - ms) < 30 * 60_000);
        };
        const pick = pickFirstSlot(
          Array.from(byStart.values()).map(({ block }) => ({
            start: block.start,
            freeSpots: block.freeSpots,
          })),
          {
            nowMs: Date.now(),
            quantity: item.qty,
            blocked: (s) => beforeReopen(s) || conflictsCart(s),
          },
        );
        setFirstPick(pick ? (byStart.get(pick.start) ?? null) : null);
        setScanState("done");
      })
      .catch(() => {
        if (!cancelled) setScanState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [
    item.productId,
    item.pageId,
    item.date,
    item.qty,
    ctx?.clientKey,
    today,
    session.items,
    item.id,
  ]);

  const bookFirst = async () => {
    if (!firstPick || holding) return;
    setHolding(true);
    setHoldError(null);
    setBusy?.(true);
    try {
      if (item.bmiLineId) await releaseItemBmiLines(session, item);
      onChange({ slot: firstPick.block.start, slotProposal: firstPick.proposal, bmiLineId: null });
      await bookAttractionOnAdvance(
        session,
        { ...item, slot: firstPick.block.start, slotProposal: firstPick.proposal, bmiLineId: null },
        dispatch,
      );
    } catch (err) {
      onChange({ slot: null, slotProposal: null, bmiLineId: null });
      setHoldError(
        err instanceof Error
          ? `That time just filled — pick another below. (${err.message})`
          : "That time just filled — pick another below.",
      );
      setFirstPick(null);
    } finally {
      setHolding(false);
      setBusy?.(false);
    }
  };

  const accent = ctx?.config.color ?? "#00E2E5";
  const heroSelected = !!firstPick && item.slot === firstPick.block.start;

  return (
    <div className="space-y-8">
      {/* Book-now hero */}
      {scanState === "loading" ? (
        <div className="flex justify-center py-10">
          <BrandedLoader
            brand={session.entryBrand}
            size={180}
            label="Finding your next available time…"
          />
        </div>
      ) : firstPick ? (
        <button
          type="button"
          onClick={() => void bookFirst()}
          disabled={holding}
          className={`relative w-full overflow-hidden rounded-3xl border-2 px-8 py-8 text-left transition-colors ${
            heroSelected ? "bg-white/[0.06]" : "bg-white/[0.03]"
          }`}
          style={{ borderColor: heroSelected ? accent : "rgba(255,255,255,0.15)" }}
        >
          <div
            className="font-heading text-sm font-bold uppercase tracking-[0.28em]"
            style={{ color: accent }}
          >
            Next available · today
          </div>
          <div className="font-heading mt-2 text-7xl font-extrabold italic leading-none tabular-nums">
            {slotLabel(firstPick.block.start)}
          </div>
          <div className="mt-3 text-lg text-white/60">
            {holding
              ? "Holding your spot…"
              : heroSelected
                ? "Held for you — hit Next to keep going"
                : `${firstPick.block.freeSpots} spots open — tap to grab it`}
          </div>
          {holding && (
            <div className="absolute right-8 top-1/2 h-8 w-8 -translate-y-1/2 animate-spin rounded-full border-2 border-white/20 border-t-[#00E2E5]" />
          )}
        </button>
      ) : scanState === "error" ? (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-5 text-center text-red-200">
          Couldn&rsquo;t check today&rsquo;s times — pick from the list below.
        </div>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center text-lg text-white/55">
          Nothing bookable for your group in the next few hours — today&rsquo;s remaining times are
          below, or ask the front desk about walk-ins.
        </div>
      )}

      {holdError && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-5 py-4 text-amber-100">
          {holdError}
        </div>
      )}

      {/* Later-today path — the full web slot grid with all its rules */}
      <div>
        <div className="font-heading mb-3 text-sm font-bold uppercase tracking-[0.24em] text-white/40">
          Or pick another time today
        </div>
        <AttractionSlotStep.Component {...props} />
      </div>
    </div>
  );
};

export const KioskSlotStep: StepDef<AttractionItem> = {
  id: "attraction-slot", // keep the web id: KioskFlow's advance handler books on it
  title: "Time",
  Component: KioskSlotStepComponent,
  isVisible: () => true,
  canAdvance: (item) => {
    if (!item.slot) return { reason: "Pick a time to continue." };
    return true;
  },
};
