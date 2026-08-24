"use client";

/**
 * Kiosk Race Sims time step — "race now" first (KioskSlotStep's semantics on
 * the racesim item). The date is ALWAYS today (walk-up device); a hero card
 * offers the next available session in one tap with an EAGER $0-key hold
 * (bookRaceSimOnAdvance — gel/laser hold semantics), and a native chip grid
 * beneath is the "later today" path. All three track keys share the "Race
 * Sim" resource sessions (capacity 4), so availability is fetched with the
 * CHOSEN track's key and freeSpots gates seats.
 *
 * Until the BMI keys are armed (race-sims/products.ts), raceSimBookingTarget
 * is null and this step shows the no-sessions state — bookable nowhere,
 * consistent with reserve guard 2e.
 */
import { useEffect, useState } from "react";
import type { RaceSimItem, StepDef } from "~/features/booking";
import { bmiAdapter, type BmiBlock, type BmiProposal } from "~/features/booking/data/bmi";
import { releaseItemBmiLines } from "~/features/booking/service/checkout";
import { raceSimBookingTarget } from "~/features/race-sims/products";
import { bookRaceSimOnAdvance } from "~/features/race-sims/service";
import { pickFirstSlot, slotLabel, slotStartMs, todayYmd } from "../service/first-available";
import { BrandedLoader } from "../components/BrandedLoader";
import { useT } from "../i18n";

const ACCENT = "#ff6b6b";

type SlotEntry = { block: BmiBlock; proposal: BmiProposal };

const KioskRaceSimSlotStepComponent: StepDef<RaceSimItem>["Component"] = ({
  item,
  session,
  onChange,
  dispatch,
  setBusy,
}) => {
  const t = useT();
  const target = raceSimBookingTarget(item.trackKey);
  const qty = Math.max(1, item.racerCount);

  const [slots, setSlots] = useState<SlotEntry[]>([]);
  const [firstPick, setFirstPick] = useState<SlotEntry | null>(null);
  const [scanState, setScanState] = useState<"loading" | "done" | "error">("loading");
  const [holding, setHolding] = useState<string | null>(null); // block.start mid-hold
  const [holdError, setHoldError] = useState<string | null>(null);

  // Kiosk = walk-up: the date is always today.
  const today = todayYmd();
  useEffect(() => {
    if (item.date !== today) onChange({ date: today, slot: null, slotProposal: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.date, today]);

  useEffect(() => {
    if (!target || item.date !== today) {
      setScanState("done");
      setSlots([]);
      setFirstPick(null);
      return;
    }
    let cancelled = false;
    setScanState("loading");
    bmiAdapter
      .getAvailability({
        date: today,
        productId: target.productId,
        pageId: target.pageId,
        quantity: qty,
      })
      .then((res) => {
        if (cancelled) return;
        const byStart = new Map<string, SlotEntry>();
        for (const proposal of res.proposals) {
          const block = proposal.blocks[0]?.block;
          if (block && !byStart.has(block.start)) byStart.set(block.start, { block, proposal });
        }
        const entries = Array.from(byStart.values()).sort(
          (a, b) => slotStartMs(a.block.start) - slotStartMs(b.block.start),
        );
        setSlots(entries);
        // Conservative cart-conflict skip for the hero — stay 30 min clear of
        // everything else booked this session (KioskSlotStep convention).
        const otherTimes: number[] = [];
        for (const other of session.items) {
          if (other.id === item.id) continue;
          if (other.kind === "race") {
            for (const h of other.heats) if (h.heatId) otherTimes.push(slotStartMs(h.heatId));
          } else if (other.kind === "attraction" && other.slot) {
            otherTimes.push(slotStartMs(other.slot));
          } else if (other.kind === "racesim" && other.slot) {
            otherTimes.push(slotStartMs(other.slot));
          } else if ((other.kind === "bowling" || other.kind === "kbf") && other.bookedAt) {
            otherTimes.push(slotStartMs(other.bookedAt));
          }
        }
        const conflictsCart = (start: string): boolean => {
          const ms = slotStartMs(start);
          return otherTimes.some((o) => Math.abs(o - ms) < 30 * 60_000);
        };
        const pick = pickFirstSlot(
          entries.map(({ block }) => ({ start: block.start, freeSpots: block.freeSpots })),
          { nowMs: Date.now(), quantity: qty, blocked: conflictsCart },
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
    target?.productId,
    target?.pageId,
    item.date,
    qty,
    today,
    session.items,
    item.id,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- target is derived from trackKey (stable per render)
  ]);

  const bookSlot = async (entry: SlotEntry) => {
    if (holding) return;
    setHolding(entry.block.start);
    setHoldError(null);
    setBusy?.(true);
    try {
      if (item.bmiLineId) await releaseItemBmiLines(session, item);
      onChange({ slot: entry.block.start, slotProposal: entry.proposal, bmiLineId: null });
      await bookRaceSimOnAdvance(
        session,
        { ...item, slot: entry.block.start, slotProposal: entry.proposal, bmiLineId: null },
        dispatch,
      );
    } catch (err) {
      onChange({ slot: null, slotProposal: null, bmiLineId: null });
      // err.message is a raw vendor/technical detail — appended untranslated.
      setHoldError(
        err instanceof Error ? `${t("slot.hold.filled")} (${err.message})` : t("slot.hold.filled"),
      );
    } finally {
      setHolding(null);
      setBusy?.(false);
    }
  };

  const heroSelected = !!firstPick && item.slot === firstPick.block.start;
  const nowMs = Date.now();
  const laterSlots = slots.filter(
    ({ block }) => slotStartMs(block.start) > nowMs && block.start !== firstPick?.block.start,
  );

  return (
    <div className="space-y-[32px]">
      {/* Race-now hero */}
      {scanState === "loading" ? (
        <div className="flex justify-center py-[48px]">
          <BrandedLoader brand={session.entryBrand} size={180} label={t("slot.finding")} />
        </div>
      ) : firstPick ? (
        <button
          type="button"
          onClick={() => void bookSlot(firstPick)}
          disabled={holding != null}
          className="k-glass k-tap relative w-full overflow-hidden p-[40px] text-left"
          style={{ borderLeft: `8px solid ${heroSelected ? ACCENT : "rgba(255,255,255,0.15)"}` }}
        >
          <div className="k-eyebrow" style={{ color: ACCENT }}>
            {t("slot.nextAvailable")}
          </div>
          <div className="k-display mt-[10px] text-[150px] leading-none tabular-nums">
            {slotLabel(firstPick.block.start)}
          </div>
          <div className="mt-[12px] text-[28px] text-white/60">
            {holding === firstPick.block.start
              ? t("slot.holding")
              : heroSelected
                ? t("slot.held")
                : t("slot.spotsOpen", { count: firstPick.block.freeSpots })}
          </div>
          {holding === firstPick.block.start && (
            <div className="absolute right-[40px] top-1/2 h-[40px] w-[40px] -translate-y-1/2 animate-spin rounded-full border-4 border-white/20 border-t-[#ff6b6b]" />
          )}
        </button>
      ) : scanState === "error" ? (
        <div className="k-glass p-[28px] text-center text-[26px] text-red-200">
          {t("slot.error")}
        </div>
      ) : (
        <div className="k-glass p-[32px] text-center text-[28px] text-white/55">
          {t("slot.noneSoon")}
        </div>
      )}

      {holdError && (
        <div className="rounded-[24px] border border-amber-500/40 bg-amber-500/10 px-[28px] py-[20px] text-[26px] text-amber-100">
          {holdError}
        </div>
      )}

      {/* Later-today grid — native chips (freeSpots-gated for the party). */}
      {laterSlots.length > 0 && (
        <div>
          <div className="k-eyebrow mb-[16px] text-white/40">{t("slot.orPickAnother")}</div>
          <div className="grid grid-cols-4 gap-[16px]">
            {laterSlots.map((entry) => {
              const full = entry.block.freeSpots < qty;
              const selected = item.slot === entry.block.start;
              const isHolding = holding === entry.block.start;
              return (
                <button
                  key={entry.block.start}
                  type="button"
                  disabled={full || holding != null}
                  onClick={() => void bookSlot(entry)}
                  className={`k-tap rounded-[16px] border-2 px-[16px] py-[20px] text-center ${
                    selected
                      ? "bg-[#ff6b6b]/10"
                      : full
                        ? "border-white/10 bg-white/[0.02] opacity-40"
                        : "border-white/12 bg-white/[0.04]"
                  }`}
                  style={selected ? { borderColor: ACCENT } : undefined}
                >
                  <div className="text-[28px] font-extrabold tabular-nums">
                    {isHolding ? "…" : slotLabel(entry.block.start)}
                  </div>
                  <div className="mt-[4px] text-[18px] text-white/45">
                    {full
                      ? t("categories.tile.unavailable")
                      : t("slot.spotsOpen", { count: entry.block.freeSpots })}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

// TODO(i18n): title/reason localize via KioskFlow's lookup maps — "Time" →
// stepTitle.time and the reason → stepReason.kioskSlot both already exist.
export const KioskRaceSimSlotStep: StepDef<RaceSimItem> = {
  id: "racesim-slot",
  title: "Time",
  Component: KioskRaceSimSlotStepComponent,
  isVisible: () => true,
  canAdvance: (item) => (item.slot ? true : { reason: "Pick a time to continue." }),
};
