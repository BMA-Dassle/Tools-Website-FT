"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";
import type { BowlingReservation, BowlingReservationPlayer, ReservationLine } from "@/lib/bowling-db";

/**
 * Shared bowling confirmation page component.
 *
 * Used by both Kids Bowl Free (kind="kbf") and Open Bowling (kind="open").
 * Reads URL params: neonId, qamfId, centerId, depositPaid, remaining.
 * Fetches full reservation from /api/bowling/v2/reservations/[neonId].
 *
 * Usage:
 *   // In a page.tsx:
 *   import BowlingConfirmation from "@/components/bowling/BowlingConfirmation";
 *   export default function Page() { return <BowlingConfirmation kind="kbf" />; }
 */

export type BowlingConfirmationKind = "kbf" | "open";

const CORAL = "#fd5b56";
const NAVY = "#123075";
const GOLD = "#FFD700";
const BG = "#0a1628";

const CENTER_NAME: Record<string, string> = {
  "9172": "HeadPinz Fort Myers",
  "3148": "HeadPinz Naples",
};
const CENTER_ADDRESS: Record<string, string> = {
  "9172": "14513 Global Pkwy, Fort Myers",
  "3148": "8525 Radio Ln, Naples",
};
const CENTER_PHONE: Record<string, string> = {
  "9172": "(239) 302-2155",
  "3148": "(239) 455-3755",
};

type ReservationWithLines = BowlingReservation & {
  lines: (ReservationLine & { id: number; reservationId: number })[];
};

// ── Shoe size catalog ─────────────────────────────────────────────────────

const KIDS_SIZES  = ["5","6","7","8","9","10","11","12","13"];
const ADULT_SIZES = ["6","7","8","9","10","11","12","13","14","15"];

// ── Helpers ────────────────────────────────────────────────────────────────

function centsToDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatBookedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Row({
  label,
  value,
  mono,
  green,
}: {
  label: string;
  value: string;
  mono?: boolean;
  green?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-white/50 shrink-0">{label}</span>
      <span
        className={`text-right ${mono ? "font-mono" : ""} ${green ? "text-green-400 font-semibold" : "text-white"}`}
        style={mono ? { letterSpacing: "0.4px" } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function DividerLine() {
  return <div className="border-t border-white/10 my-2" />;
}

// ── Kind-specific config ───────────────────────────────────────────────────

interface KindConfig {
  heroLabel: string;
  heroSubtitle: (hasPaidDeposit: boolean) => string;
  fetchFailNote: (centerName: string) => string;
  linesHeader: string;
  arrivalBullets: (displayRemaining: number) => React.ReactNode;
  /** Optional link shown above the cancel section (e.g. reschedule for KBF). */
  changeLink?: { href: string; label: string };
  navLinks: { href: string; label: string }[];
}

const KIND_CONFIG: Record<BowlingConfirmationKind, KindConfig> = {
  kbf: {
    heroLabel: "Kids Bowl Free · Confirmed",
    heroSubtitle: (hasPaidDeposit) =>
      hasPaidDeposit
        ? "Your deposit has been charged and your lane is reserved. Bring this confirmation when you arrive."
        : "Your lane is reserved. Show this confirmation (or your Kids Bowl Free coupon email) at the front desk.",
    fetchFailNote: (centerName) =>
      `Bring your KBF coupon to ${centerName} and the front desk will find it.`,
    linesHeader: "Add-ons",
    arrivalBullets: (displayRemaining) => (
      <>
        <li>Show this confirmation at the front desk.</li>
        <li>Bring your Kids Bowl Free coupon or season pass.</li>
        <li>Your lane is held until 5 minutes after start time.</li>
        {displayRemaining > 0 && (
          <li>
            Your remaining balance of{" "}
            <span className="text-white font-semibold">
              {centsToDollars(displayRemaining)}
            </span>{" "}
            is due at the center.
          </li>
        )}
      </>
    ),
    changeLink: { href: "/hp/book/kids-bowl-free-v2", label: "Change Date & Time" },
    navLinks: [
      { href: "/hp/kids-bowl-free", label: "Kids Bowl Free info" },
      { href: "/hp/book", label: "Book something else" },
    ],
  },

  open: {
    heroLabel: "Open Bowling · Confirmed",
    heroSubtitle: () =>
      "Your deposit has been charged and your lane is reserved. Bring this confirmation when you arrive.",
    fetchFailNote: () => "Please show your booking reference at the front desk.",
    linesHeader: "Order",
    arrivalBullets: (displayRemaining) => (
      <>
        <li>Show this confirmation at the front desk.</li>
        <li>Rental shoes are available at the front counter.</li>
        <li>Your lane is held until 10 minutes after start time.</li>
        {displayRemaining > 0 && (
          <li>
            Your remaining balance of{" "}
            <span className="text-white font-semibold">
              {centsToDollars(displayRemaining)}
            </span>{" "}
            is due at the center.
          </li>
        )}
      </>
    ),
    navLinks: [
      { href: "/hp/book/open-bowling", label: "Book another lane" },
      { href: "/hp/book", label: "Book something else" },
    ],
  },
};

// ── Bowler card sub-component ─────────────────────────────────────────────

function BowlerCard({
  player,
  shoePairsAllowed,
  shoeSizesAssigned,
  onUpdate,
}: {
  player: BowlingReservationPlayer;
  shoePairsAllowed: number;
  shoeSizesAssigned: number;
  onUpdate: (patch: Partial<BowlingReservationPlayer>) => void;
}) {
  // Derive active category from saved shoeSize; persists while user browses sizes
  const savedCat = player.shoeSize?.startsWith("Kids")
    ? ("Kids" as const)
    : player.shoeSize?.startsWith("Adult")
    ? ("Adult" as const)
    : null;
  const [activeCat, setActiveCat] = useState<"Kids" | "Adult" | null>(savedCat);

  const nums = activeCat === "Kids" ? KIDS_SIZES : activeCat === "Adult" ? ADULT_SIZES : [];
  const currentNum = player.shoeSize?.split(" ")[1] ?? null;
  // This bowler already has a size, or there's room for another pair
  const canPickShoes = !!player.shoeSize || shoeSizesAssigned < shoePairsAllowed;

  function selectCat(cat: "Kids" | "Adult" | null) {
    if (cat === null) {
      setActiveCat(null);
      onUpdate({ shoeSize: null });
      return;
    }
    // Switching category clears any saved size for the previous category
    if (activeCat !== cat && player.shoeSize) onUpdate({ shoeSize: null });
    setActiveCat(cat);
  }

  function selectNum(num: string) {
    if (!activeCat) return;
    onUpdate({ shoeSize: `${activeCat} ${num}` });
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
      {/* Name */}
      <input
        type="text"
        value={player.name ?? ""}
        onChange={(e) => onUpdate({ name: e.target.value || null })}
        placeholder={`Bowler ${player.slot}`}
        className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-white text-sm font-body placeholder:text-white/25 focus:outline-none focus:border-white/35"
      />

      {/* Bumpers */}
      <div className="flex items-center gap-3">
        <span className="text-white/50 text-xs font-body w-16 shrink-0">Bumpers</span>
        <div className="flex rounded-lg overflow-hidden border border-white/15">
          {([true, false] as const).map((val) => (
            <button
              key={String(val)}
              type="button"
              onClick={() => onUpdate({ bumpers: val })}
              className="px-3 py-1.5 text-xs font-body font-semibold transition-colors"
              style={{
                backgroundColor:
                  player.bumpers === val
                    ? val
                      ? CORAL
                      : "rgba(255,255,255,0.15)"
                    : "transparent",
                color: player.bumpers === val ? "white" : "rgba(255,255,255,0.35)",
              }}
            >
              {val ? "Yes" : "No"}
            </button>
          ))}
        </div>
      </div>

      {/* Shoes — only rendered when pairs were purchased */}
      {shoePairsAllowed > 0 && (
        <div className="space-y-2">
          {/* Category row */}
          <div className="flex items-center gap-2">
            <span className="text-white/50 text-xs font-body w-16 shrink-0">Shoes</span>
            <div className="flex gap-1.5">
              {(["None", "Kids", "Adult"] as const).map((label) => {
                const cat = label === "None" ? null : label;
                const active = cat === null ? activeCat === null : activeCat === cat;
                const disabled = !active && !canPickShoes && cat !== null;
                return (
                  <button
                    key={label}
                    type="button"
                    disabled={disabled}
                    onClick={() => selectCat(cat)}
                    className="px-3 py-1.5 rounded-lg text-xs font-body font-semibold border transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                    style={{
                      backgroundColor: active
                        ? cat === null
                          ? "rgba(255,255,255,0.12)"
                          : CORAL
                        : "transparent",
                      borderColor: active
                        ? cat === null
                          ? "rgba(255,255,255,0.25)"
                          : CORAL
                        : "rgba(255,255,255,0.12)",
                      color: active ? "white" : "rgba(255,255,255,0.4)",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Size number chips */}
          {activeCat && (
            <div className="flex gap-1.5 flex-wrap pl-[76px]">
              {nums.map((num) => {
                const selected =
                  currentNum === num && player.shoeSize?.startsWith(activeCat);
                return (
                  <button
                    key={num}
                    type="button"
                    onClick={() => selectNum(num)}
                    className="min-w-[36px] px-2 py-1.5 rounded-lg text-xs font-body font-semibold border transition-colors"
                    style={{
                      backgroundColor: selected ? CORAL : "rgba(255,255,255,0.06)",
                      borderColor: selected ? CORAL : "rgba(255,255,255,0.12)",
                      color: selected ? "white" : "rgba(255,255,255,0.55)",
                    }}
                  >
                    {num}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main content (inside Suspense) ─────────────────────────────────────────

function ConfirmationContent({ kind }: { kind: BowlingConfirmationKind }) {
  const sp = useSearchParams();
  const neonIdStr = sp.get("neonId") ?? "0";
  const qamfId = sp.get("qamfId") ?? "";
  const centerId = sp.get("centerId") ?? "";
  const depositPaidCents = parseInt(sp.get("depositPaid") ?? "0", 10);
  const remainingCents = parseInt(sp.get("remaining") ?? "0", 10);

  const neonId = parseInt(neonIdStr, 10);
  const hasNeonRecord = !isNaN(neonId) && neonId > 0;

  const [reservation, setReservation] = useState<ReservationWithLines | null>(null);
  const [fetchError, setFetchError] = useState(false);

  // ── Bowler details state ─────────────────────────────────────────
  const [players, setPlayers] = useState<BowlingReservationPlayer[]>([]);
  const [shoePairsAllowed, setShoePairsAllowed] = useState(0);
  const [laneNumbers, setLaneNumbers] = useState<number[]>([]);
  const [playersSaving, setPlayersSaving] = useState(false);
  const [playersSaved, setPlayersSaved] = useState(false);
  const [playersError, setPlayersError] = useState<string | null>(null);

  // ── Cancel state ─────────────────────────────────────────────────
  type CancelPhase = "idle" | "confirming" | "cancelling" | "cancelled" | "tooLate";
  const [cancelPhase, setCancelPhase] = useState<CancelPhase>("idle");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelRefundCents, setCancelRefundCents] = useState(0);

  const centerName = CENTER_NAME[centerId] ?? "HeadPinz";
  const centerPhone = CENTER_PHONE[centerId] ?? "(239) 302-2155";
  const centerAddress = CENTER_ADDRESS[centerId] ?? "";

  useEffect(() => {
    if (!hasNeonRecord) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/bowling/v2/reservations/${neonId}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setFetchError(true);
          return;
        }
        const json = (await res.json()) as ReservationWithLines;
        if (!cancelled) setReservation(json);
      } catch {
        if (!cancelled) setFetchError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [neonId, hasNeonRecord]);

  // Fetch player rows after the reservation loads
  useEffect(() => {
    if (!hasNeonRecord || !reservation) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/bowling/v2/reservations/${neonId}/players`);
        if (!res.ok || cancelled) return;
        const data = await res.json() as {
          players: BowlingReservationPlayer[];
          shoePairsAllowed: number;
          laneNumbers: number[];
        };
        if (!cancelled) {
          setPlayers(data.players);
          setShoePairsAllowed(data.shoePairsAllowed);
          setLaneNumbers(data.laneNumbers ?? []);
        }
      } catch {
        // Non-fatal — form just won't render
      }
    })();
    return () => { cancelled = true; };
  }, [neonId, reservation, hasNeonRecord]);

  function updatePlayer(slot: number, patch: Partial<BowlingReservationPlayer>) {
    setPlayers((prev) =>
      prev.map((p) => (p.slot === slot ? { ...p, ...patch } : p)),
    );
    setPlayersSaved(false);
  }

  async function handleSavePlayers() {
    const shoeSizeCount = players.filter((p) => p.shoeSize).length;
    if (shoeSizeCount > shoePairsAllowed) {
      setPlayersError(
        `You've assigned shoe sizes for ${shoeSizeCount} bowlers but only purchased ${shoePairsAllowed} pair${shoePairsAllowed !== 1 ? "s" : ""}. Please remove a size first.`,
      );
      return;
    }
    setPlayersSaving(true);
    setPlayersError(null);
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${neonId}/players`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          players: players.map((p) => ({
            slot: p.slot,
            name: p.name,
            shoeSize: p.shoeSize,
            bumpers: p.bumpers,
            laneNumber: p.laneNumber,
          })),
        }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      setPlayersSaved(true);
    } catch (err) {
      setPlayersError(err instanceof Error ? err.message : "Failed to save preferences");
    } finally {
      setPlayersSaving(false);
    }
  }

  function handleRequestCancel() {
    if (!reservation) return;
    // Client-side 1-hour check so we can show the right UI immediately
    const msUntilGame = new Date(reservation.bookedAt).getTime() - Date.now();
    if (msUntilGame < 60 * 60 * 1000) {
      setCancelPhase("tooLate");
      return;
    }
    setCancelPhase("confirming");
    setCancelError(null);
  }

  async function handleConfirmCancel() {
    if (!hasNeonRecord) return;
    setCancelPhase("cancelling");
    setCancelError(null);
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${neonId}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as {
        message?: string;
        refundCents?: number;
        error?: string;
      };
      if (!res.ok) {
        if (res.status === 409) {
          setCancelPhase("tooLate");
        } else {
          setCancelError(data.error ?? "Cancellation failed. Please call the center.");
          setCancelPhase("confirming");
        }
        return;
      }
      setCancelRefundCents(data.refundCents ?? 0);
      setCancelPhase("cancelled");
      // Reflect in local reservation state so deposit display updates
      setReservation((prev) => prev ? { ...prev, status: "cancelled" } : prev);
    } catch {
      setCancelError("Network error — please try again or call the center.");
      setCancelPhase("confirming");
    }
  }

  const displayDepositPaid = reservation ? reservation.depositCents : depositPaidCents;
  const displayTotal = reservation
    ? reservation.totalCents
    : displayDepositPaid + remainingCents;
  const displayRemaining = displayTotal - displayDepositPaid;
  const hasPaidDeposit = displayDepositPaid > 0;

  const dateLabel = reservation?.bookedAt ? formatBookedAt(reservation.bookedAt) : "";
  const playerCount = reservation?.playerCount;
  const guestName = reservation?.guestName ?? "";
  const lines = reservation?.lines ?? [];

  const cfg = KIND_CONFIG[kind];

  return (
    <div style={{ backgroundColor: BG }} className="min-h-screen">
      <HeadPinzNav />

      <main className="pt-28 sm:pt-36 pb-24 px-4">
        <div className="max-w-2xl mx-auto space-y-4">

          {/* ── Hero card ── */}
          <div
            className="rounded-2xl border p-6 sm:p-8"
            style={{
              backgroundColor: "rgba(253,91,86,0.08)",
              borderColor: `${CORAL}55`,
            }}
          >
            <div
              className="uppercase font-bold mb-2"
              style={{ color: CORAL, fontSize: "11px", letterSpacing: "3px" }}
            >
              {cfg.heroLabel}
            </div>
            <h1
              className="font-heading font-black uppercase italic text-white mb-2"
              style={{ fontSize: "clamp(28px, 5vw, 40px)", lineHeight: 1.05 }}
            >
              You&apos;re booked!
            </h1>
            <p className="text-white/70 text-sm leading-relaxed">
              {cfg.heroSubtitle(hasPaidDeposit)}
            </p>

            {/* ── Quick-action row ── */}
            {reservation?.status !== "cancelled" && cancelPhase === "idle" && hasNeonRecord && (
              <div className="flex gap-2 mt-4 pt-4 border-t border-white/10">
                {cfg.changeLink && (
                  <a
                    href={cfg.changeLink.href}
                    className="flex-1 text-center rounded-full px-3 py-2 font-body font-bold text-xs uppercase tracking-wider text-white/70 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
                  >
                    {cfg.changeLink.label}
                  </a>
                )}
                <button
                  type="button"
                  onClick={handleRequestCancel}
                  className="flex-1 rounded-full px-3 py-2 font-body font-bold text-xs uppercase tracking-wider border transition-colors"
                  style={{
                    borderColor: "rgba(253,91,86,0.35)",
                    color: "rgba(253,91,86,0.75)",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = CORAL;
                    (e.currentTarget as HTMLButtonElement).style.color = CORAL;
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(253,91,86,0.35)";
                    (e.currentTarget as HTMLButtonElement).style.color = "rgba(253,91,86,0.75)";
                  }}
                >
                  Cancel booking
                </button>
              </div>
            )}

            {/* ── Inline cancel confirmation (shown inside hero card when triggered) ── */}
            {cancelPhase === "confirming" && (
              <div className="mt-4 pt-4 border-t border-white/10 space-y-3">
                <p className="text-white/80 text-sm">
                  {displayDepositPaid > 0
                    ? `Cancel and get a full ${centsToDollars(displayDepositPaid)} refund to your card?`
                    : "Cancel this booking?"}
                </p>
                {cancelError && <p className="text-xs" style={{ color: CORAL }}>{cancelError}</p>}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setCancelPhase("idle"); setCancelError(null); }}
                    className="flex-1 py-2.5 rounded-full border border-white/20 font-body font-bold text-sm text-white/60 hover:text-white transition-colors uppercase tracking-wider"
                  >
                    Never mind
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleConfirmCancel()}
                    className="flex-1 py-2.5 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] active:scale-[0.99]"
                    style={{ backgroundColor: CORAL }}
                  >
                    Yes, cancel
                  </button>
                </div>
              </div>
            )}

            {cancelPhase === "cancelling" && (
              <p className="mt-4 pt-4 border-t border-white/10 text-white/60 text-sm text-center animate-pulse">
                Cancelling…
              </p>
            )}

            {cancelPhase === "tooLate" && (
              <p className="mt-4 pt-4 border-t border-white/10 text-white/70 text-xs leading-relaxed">
                Cancellations must be made at least 1 hour before your start time. Call{" "}
                <a className="underline hover:text-white transition-colors" href={`tel:${centerPhone.replace(/\D/g, "")}`}>
                  {centerPhone}
                </a>.
              </p>
            )}
          </div>

          {/* ── Fetch-failed warning ── */}
          {(fetchError || !hasNeonRecord) && (
            <div className="rounded-xl border border-yellow-400/40 bg-yellow-400/10 p-4 text-sm text-yellow-100">
              {!hasNeonRecord
                ? "Your booking is confirmed — we couldn't save the detail record, but your lane is held."
                : "We couldn't load your full booking details right now — but your lane is held."}{" "}
              {cfg.fetchFailNote(centerName)}
            </div>
          )}

          {/* ── Booking details card ── */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7 space-y-3">
            {qamfId && <Row label="Booking ref" value={qamfId} mono />}
            <Row label="Center" value={centerName} />
            {centerAddress && <Row label="Address" value={centerAddress} />}
            {dateLabel && <Row label="When" value={dateLabel} />}
            {playerCount != null && <Row label="Bowlers" value={String(playerCount)} />}
            {guestName && <Row label="Guest" value={guestName} />}

            {/* Line items */}
            {lines.length > 0 && (
              <>
                <DividerLine />
                <div>
                  <div
                    className="uppercase font-bold mb-2"
                    style={{
                      color: "rgba(255,255,255,0.35)",
                      fontSize: "10px",
                      letterSpacing: "2.5px",
                    }}
                  >
                    {cfg.linesHeader}
                  </div>
                  <div className="space-y-1.5">
                    {lines.map((line, i) => (
                      <div key={i} className="flex justify-between text-sm">
                        <span className="text-white/75">
                          {line.label}
                          {line.quantity > 1 ? ` ×${line.quantity}` : ""}
                        </span>
                        <span className="text-white">
                          {line.unitPriceCents === 0
                            ? "Free"
                            : centsToDollars(line.unitPriceCents * line.quantity)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Payment summary */}
            {hasPaidDeposit && (
              <>
                <DividerLine />
                <div className="space-y-1.5">
                  {displayTotal > 0 && (
                    <Row label="Order total" value={centsToDollars(displayTotal)} />
                  )}
                  <Row
                    label="Paid at booking"
                    value={centsToDollars(displayDepositPaid)}
                    green
                  />
                  {displayRemaining > 0 && (
                    <Row
                      label="Balance due at center"
                      value={centsToDollars(displayRemaining)}
                    />
                  )}
                  {displayRemaining === 0 && (
                    <Row label="Balance due at center" value="Paid in full" />
                  )}
                </div>
              </>
            )}
          </div>

          {/* ── Bowler details ── */}
          {players.length > 0 && (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7">
              <div
                className="uppercase font-bold mb-1"
                style={{ color: "rgba(255,255,255,0.35)", fontSize: "10px", letterSpacing: "2.5px" }}
              >
                Bowler Details
              </div>
              <p className="text-white/45 text-xs mb-5 leading-relaxed">
                {shoePairsAllowed > 0
                  ? `Help us get your lane ready — bumpers and shoe sizes for up to ${shoePairsAllowed} pair${shoePairsAllowed !== 1 ? "s" : ""}.`
                  : "Let us know who needs bumpers so your lane is set up when you arrive."}
              </p>

              {laneNumbers.length > 1 ? (
                // Multi-lane: group by lane with lane headers + move buttons
                <div className="space-y-5">
                  {laneNumbers.map((laneNum) => (
                    <div key={laneNum}>
                      <div className="text-xs font-bold uppercase tracking-widest mb-2 mt-1" style={{ color: GOLD }}>
                        Lane {laneNum}
                      </div>
                      <div className="space-y-3">
                        {players
                          .filter((p) => (p.laneNumber ?? laneNumbers[0]) === laneNum)
                          .map((player) => (
                            <div key={player.slot}>
                              <BowlerCard
                                player={player}
                                shoePairsAllowed={shoePairsAllowed}
                                shoeSizesAssigned={players.filter((p) => p.shoeSize).length}
                                onUpdate={(patch) => updatePlayer(player.slot, patch)}
                              />
                              {/* Move to other lanes */}
                              <div className="flex gap-1.5 mt-1.5 pl-1">
                                <span className="text-white/30 text-xs self-center">Move to:</span>
                                {laneNumbers.filter((ln) => ln !== laneNum).map((ln) => (
                                  <button
                                    key={ln}
                                    type="button"
                                    onClick={() => updatePlayer(player.slot, { laneNumber: ln })}
                                    className="px-2.5 py-1 rounded-lg text-xs font-body font-semibold border border-white/15 text-white/50 hover:text-white hover:border-white/35 transition-colors"
                                  >
                                    Lane {ln}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                // Single lane or no lane data: flat list (current behavior)
                <div className="space-y-4">
                  {players.map((player) => (
                    <BowlerCard
                      key={player.slot}
                      player={player}
                      shoePairsAllowed={shoePairsAllowed}
                      shoeSizesAssigned={players.filter((p) => p.shoeSize).length}
                      onUpdate={(patch) => updatePlayer(player.slot, patch)}
                    />
                  ))}
                </div>
              )}

              {/* Shoe pair counter */}
              {shoePairsAllowed > 0 && (
                <p className="text-white/35 text-xs mt-3 text-right font-body">
                  {players.filter((p) => p.shoeSize).length} of {shoePairsAllowed} shoe pair{shoePairsAllowed !== 1 ? "s" : ""} assigned
                </p>
              )}

              {/* Error */}
              {playersError && (
                <div
                  className="rounded-xl p-3 text-sm font-body mt-3"
                  style={{
                    backgroundColor: "rgba(253,91,86,0.12)",
                    border: "1.5px solid rgba(253,91,86,0.35)",
                    color: CORAL,
                  }}
                >
                  {playersError}
                </div>
              )}

              {/* Save button */}
              <button
                type="button"
                onClick={() => void handleSavePlayers()}
                disabled={playersSaving || playersSaved}
                className="mt-4 w-full py-3 rounded-full font-body font-bold text-sm uppercase tracking-wider text-white transition-all hover:scale-[1.01] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                style={{ backgroundColor: playersSaved ? "rgba(74,222,128,0.25)" : CORAL }}
              >
                {playersSaving
                  ? "Saving…"
                  : playersSaved
                    ? "✓ Saved"
                    : "Save Preferences"}
              </button>
            </div>
          )}

          {/* ── Arrival instructions ── */}
          <div
            className="rounded-xl border px-5 py-4 space-y-2"
            style={{
              backgroundColor: "rgba(18,48,117,0.35)",
              borderColor: `${NAVY}99`,
            }}
          >
            <div
              className="uppercase font-bold"
              style={{ color: GOLD, fontSize: "10px", letterSpacing: "2.5px" }}
            >
              When you arrive
            </div>
            <ul className="text-white/75 text-sm space-y-1 list-disc list-inside">
              {cfg.arrivalBullets(displayRemaining)}
            </ul>
          </div>


          {/* Cancelled confirmation */}
          {(cancelPhase === "cancelled" || reservation?.status === "cancelled") && (
            <div
              className="rounded-xl border px-4 py-4 space-y-1"
              style={{
                backgroundColor: "rgba(74,222,128,0.06)",
                borderColor: "rgba(74,222,128,0.30)",
              }}
            >
              <div
                className="uppercase font-bold"
                style={{ color: "#4ade80", fontSize: "10px", letterSpacing: "2.5px" }}
              >
                Booking cancelled
              </div>
              {(cancelRefundCents > 0 || (reservation?.refundCents ?? 0) > 0) && (
                <p className="text-white/70 text-sm">
                  {centsToDollars(cancelRefundCents || (reservation?.refundCents ?? 0))} refund will appear on your card in 3–5 business days.
                </p>
              )}
              {(cancelRefundCents === 0 && (reservation?.refundCents ?? 0) === 0) && (
                <p className="text-white/70 text-sm">No charges were made.</p>
              )}
            </div>
          )}

          {/* ── Navigation links ── */}
          <div className="flex flex-col sm:flex-row gap-2 pt-1">
            {cfg.navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="flex-1 text-center rounded-full px-4 py-3 font-body font-bold text-sm uppercase tracking-wider text-white/70 hover:text-white border border-white/15 hover:border-white/30 transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </div>

        </div>
      </main>
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────────

function ConfirmationSkeleton() {
  return (
    <div style={{ backgroundColor: BG }} className="min-h-screen">
      <HeadPinzNav />
      <main className="pt-28 pb-20 px-4">
        <div className="max-w-2xl mx-auto">
          <div className="animate-pulse space-y-4">
            <div className="h-32 rounded-2xl bg-white/5" />
            <div className="h-48 rounded-2xl bg-white/5" />
          </div>
        </div>
      </main>
    </div>
  );
}

// ── Exported component (wraps Suspense for useSearchParams) ───────────────

export default function BowlingConfirmation({ kind }: { kind: BowlingConfirmationKind }) {
  return (
    <Suspense fallback={<ConfirmationSkeleton />}>
      <ConfirmationContent kind={kind} />
    </Suspense>
  );
}
