"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";
import type { BowlingReservation, BowlingReservationPlayer, ReservationLine } from "@/lib/bowling-db";
import { modalBackdropProps } from "@/lib/a11y";

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

// Keyed by Square location / center code (stored on BowlingReservation.centerCode)
const CENTER_NAME: Record<string, string> = {
  TXBSQN0FEKQ11: "HeadPinz Fort Myers",
  PPTR5G2N0QXF7: "HeadPinz Naples",
};
const CENTER_ADDRESS: Record<string, string> = {
  TXBSQN0FEKQ11: "14513 Global Pkwy, Fort Myers",
  PPTR5G2N0QXF7: "8525 Radio Ln, Naples",
};
const CENTER_PHONE: Record<string, string> = {
  TXBSQN0FEKQ11: "(239) 302-2155",
  PPTR5G2N0QXF7: "(239) 455-3755",
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

// ── Check-in modal ─────────────────────────────────────────────────────────

type CheckInPhase =
  | "idle"       // modal closed
  | "checking"   // waiting for GET /checkin
  | "not_ready"  // lane not yet set up
  | "ready"      // lane ready — show Open Lane
  | "opening"    // waiting for POST /checkin
  | "open"       // POST succeeded — show success
  | "running"    // already running (opened externally)
  | "error";     // network / QAMF error

interface CheckInState {
  phase: CheckInPhase;
  laneLabel: string;
  error?: string;
}

/** Maps raw API phase string → the UI CheckInPhase we care about. */
function resolveCheckInPhase(raw: string | undefined): CheckInPhase {
  if (raw === "running" || raw === "completed") return "running";
  if (raw === "ready")     return "ready";
  if (raw === "not_ready") return "not_ready";
  return "not_ready";
}

function CheckInModal({
  neonId,
  onClose,
}: {
  neonId: number;
  onClose: () => void;
}) {
  const [state, setState] = useState<CheckInState>({ phase: "checking", laneLabel: "" });

  async function fetchLaneStatus(): Promise<void> {
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${neonId}/checkin`, {
        cache: "no-store",
      });
      const data = await res.json() as { phase?: string; laneLabel?: string; error?: string };
      if (!res.ok) {
        setState({ phase: "error", laneLabel: "", error: data.error ?? "Unable to reach the system" });
        return;
      }
      setState({ phase: resolveCheckInPhase(data.phase), laneLabel: data.laneLabel ?? "" });
    } catch {
      setState({ phase: "error", laneLabel: "", error: "Connection error — try again" });
    }
  }

  // Poll QAMF for lane status on mount
  useEffect(() => {
    let alive = true;
    void fetchLaneStatus().then(() => { if (!alive) { /* discard */ } });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neonId]);

  async function handleRecheck() {
    setState({ phase: "checking", laneLabel: state.laneLabel });
    await fetchLaneStatus();
  }

  async function handleOpenLane() {
    setState((s) => ({ ...s, phase: "opening" }));
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${neonId}/checkin`, { method: "POST" });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setState((s) => ({ ...s, phase: "error", error: data.error ?? "Could not open lane" }));
        return;
      }
      setState((s) => ({ ...s, phase: "open" }));
    } catch {
      setState((s) => ({ ...s, phase: "error", error: "Connection error — try again" }));
    }
  }

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)" }}
      {...modalBackdropProps(onClose)}
    >
      {/* Modal card */}
      <div
        className="relative w-full max-w-sm rounded-2xl border border-white/15 p-7 flex flex-col items-center text-center space-y-5"
        style={{ backgroundColor: "#0e1d3a" }}
      >
        {/* Close */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-white/30 hover:text-white/70 transition-colors text-xl leading-none"
          aria-label="Close"
        >
          ✕
        </button>

        {/* ── Checking ── */}
        {state.phase === "checking" && (
          <>
            <div className="text-3xl animate-pulse">🎳</div>
            <p className="text-white/70 text-sm">Checking your lane…</p>
          </>
        )}

        {/* ── Not ready ── */}
        {state.phase === "not_ready" && (
          <>
            <div className="text-3xl">⏳</div>
            <div>
              <p className="text-white font-semibold text-base mb-1">Not quite ready</p>
              <p className="text-white/60 text-sm leading-relaxed">
                Your lane is still being prepared. Check back in a few minutes!
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleRecheck()}
              className="w-full py-3 rounded-full text-sm font-body font-bold uppercase tracking-wider text-white transition-all hover:scale-[1.02]"
              style={{ backgroundColor: CORAL }}
            >
              Check Again
            </button>
          </>
        )}

        {/* ── Ready ── */}
        {state.phase === "ready" && (
          <>
            <div className="text-3xl">🟢</div>
            <div>
              <p
                className="font-heading font-black uppercase italic mb-1"
                style={{ fontSize: "clamp(22px, 5vw, 28px)", color: "white" }}
              >
                {state.laneLabel || "Your lane"} is ready!
              </p>
              <p className="text-white/60 text-sm leading-relaxed">
                Your lane is assigned. Tap below to turn it on and start bowling!
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleOpenLane()}
              className="w-full py-3.5 rounded-full font-body font-bold uppercase tracking-wider text-white transition-all hover:scale-[1.02] active:scale-100"
              style={{ backgroundColor: CORAL, fontSize: "15px", letterSpacing: "1.5px" }}
            >
              Let&apos;s Get Started
            </button>
            <p className="text-white/40 text-xs">
              Turns on your lane so you can start bowling.
            </p>
          </>
        )}

        {/* ── Opening ── */}
        {state.phase === "opening" && (
          <>
            <div className="text-3xl animate-spin">⚙️</div>
            <p className="text-white/70 text-sm animate-pulse">Turning on your lane…</p>
          </>
        )}

        {/* ── Open (success) ── */}
        {state.phase === "open" && (
          <>
            <div className="text-4xl">🎳</div>
            <div>
              <p
                className="font-heading font-black uppercase italic mb-1"
                style={{ fontSize: "clamp(22px, 5vw, 28px)", color: GOLD }}
              >
                Let&apos;s bowl!
              </p>
              {state.laneLabel && (
                <p className="text-white font-semibold text-base mb-2">{state.laneLabel}</p>
              )}
              <p className="text-white/70 text-sm leading-relaxed">
                🥿 <span className="text-white font-semibold">Shoes will be delivered directly to you</span> — no need to stop at the desk!
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full py-3 rounded-full text-sm font-body font-bold uppercase tracking-wider border border-white/20 text-white/70 hover:text-white transition-colors"
            >
              Got it!
            </button>
          </>
        )}

        {/* ── Already running ── */}
        {state.phase === "running" && (
          <>
            <div className="text-4xl">🎳</div>
            <div>
              <p
                className="font-heading font-black uppercase italic mb-1"
                style={{ fontSize: "clamp(22px, 5vw, 28px)", color: GOLD }}
              >
                You&apos;re in!
              </p>
              {state.laneLabel && (
                <p className="text-white font-semibold text-base mb-2">{state.laneLabel}</p>
              )}
              <p className="text-white/70 text-sm leading-relaxed">
                🥿 <span className="text-white font-semibold">Shoes will be delivered directly to you</span> — enjoy your game!
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full py-3 rounded-full text-sm font-body font-bold uppercase tracking-wider border border-white/20 text-white/70 hover:text-white transition-colors"
            >
              Got it!
            </button>
          </>
        )}

        {/* ── Error ── */}
        {state.phase === "error" && (
          <>
            <div className="text-3xl">⚠️</div>
            <div>
              <p className="text-white font-semibold text-base mb-1">Something went wrong</p>
              <p className="text-white/60 text-sm">{state.error ?? "Please try again."}</p>
            </div>
            <button
              type="button"
              onClick={() => void handleRecheck()}
              className="w-full py-3 rounded-full text-sm font-body font-bold uppercase tracking-wider text-white transition-all hover:scale-[1.02]"
              style={{ backgroundColor: CORAL }}
            >
              Try Again
            </button>
          </>
        )}
      </div>
    </div>
  );
}

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

  // ── Check-in modal state ─────────────────────────────────────────
  const [checkInOpen, setCheckInOpen] = useState(false);

  // ── Cancel state ─────────────────────────────────────────────────
  const [cancelPhase, setCancelPhase] = useState<"idle" | "confirming" | "busy" | "cancelled">("idle");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelRefundCents, setCancelRefundCents] = useState(0);

  const isCancelled = cancelPhase === "cancelled" || reservation?.status === "cancelled";

  // ── Lane-ready background poll ────────────────────────────────────
  // Polls GET /checkin every 30 s. "ready" → show Check In button.
  // "running" → replace button with open-lane banner. Stops once
  // a terminal state is reached or the reservation is cancelled.
  const [laneReadyPhase, setLaneReadyPhase] = useState<
    "idle" | "not_ready" | "ready" | "running"
  >("idle");
  const [laneReadyLabel, setLaneReadyLabel] = useState("");

  useEffect(() => {
    // Only poll for active reservations once Neon record is loaded.
    // Stop once we've reached a terminal UI state (running).
    if (!hasNeonRecord || isCancelled || laneReadyPhase === "running") return;

    let alive = true;

    async function pollLane() {
      try {
        const res = await fetch(`/api/bowling/v2/reservations/${neonId}/checkin`, {
          cache: "no-store",
        });
        if (!res.ok || !alive) return;
        const data = await res.json() as { phase?: string; laneLabel?: string };
        if (!alive) return;
        const raw = data.phase ?? "";
        if (raw === "ready") {
          setLaneReadyPhase("ready");
          setLaneReadyLabel(data.laneLabel ?? "");
        } else if (raw === "running" || raw === "completed") {
          setLaneReadyPhase("running");
          setLaneReadyLabel(data.laneLabel ?? "");
        } else {
          setLaneReadyPhase("not_ready");
        }
      } catch {
        // Non-fatal — silently skip this tick
      }
    }

    void pollLane();
    const timer = setInterval(() => void pollLane(), 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neonId, hasNeonRecord, isCancelled, laneReadyPhase]);

  // Block self-serve cancellation within 1 hour of the reservation start.
  const isWithin1Hour = reservation
    ? new Date(reservation.bookedAt).getTime() - Date.now() < 60 * 60 * 1000
    : false;

  async function handleCancel() {
    if (!hasNeonRecord) return;
    setCancelPhase("busy");
    setCancelError(null);
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${neonId}/cancel`, { method: "POST" });
      const data = await res.json() as { ok?: boolean; refundCents?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Cancellation failed");
      setCancelRefundCents(data.refundCents ?? 0);
      setCancelPhase("cancelled");
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Cancellation failed");
      setCancelPhase("confirming");
    }
  }

  // Derive center info + QAMF ID from the fetched reservation object.
  // URL carries only neonId; everything else comes from Neon.
  const centerCode = reservation?.centerCode ?? "";
  const centerName = CENTER_NAME[centerCode] ?? "HeadPinz";
  const centerAddress = CENTER_ADDRESS[centerCode] ?? "";
  const qamfId = reservation?.qamfReservationId ?? "";

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

  const displayDepositPaid = reservation?.depositCents ?? 0;
  const displayTotal = reservation?.totalCents ?? 0;
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

      <main className="pt-28 sm:pt-36 pb-24 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto">
        {/* ── Check-in status — mobile top (hidden on lg, shown in right column there) ── */}
        {!isCancelled && hasNeonRecord && laneReadyPhase !== "idle" && (
          <div className="lg:hidden mb-4 space-y-3">
            {laneReadyPhase === "not_ready" && (
              <div
                className="w-full rounded-2xl border px-5 py-3.5 flex items-center gap-3"
                style={{ backgroundColor: "rgba(239,68,68,0.08)", borderColor: "rgba(239,68,68,0.3)" }}
              >
                <span style={{ fontSize: "18px" }}>🔴</span>
                <div>
                  <p className="text-sm font-semibold" style={{ color: "#f87171" }}>Lane Not Ready Yet</p>
                  <p className="text-xs text-white/45 mt-0.5">We&apos;ll let you know as soon as it&apos;s set up.</p>
                </div>
              </div>
            )}
            {laneReadyPhase === "ready" && (
              <button
                type="button"
                onClick={() => setCheckInOpen(true)}
                className="w-full py-4 rounded-2xl font-body font-black uppercase tracking-wider text-white transition-all hover:scale-[1.02] active:scale-100"
                style={{
                  background: "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)",
                  fontSize: "15px",
                  letterSpacing: "1.5px",
                  boxShadow: "0 4px 24px rgba(34,197,94,0.4)",
                }}
              >
                🎳 Your Lane is Ready! Check In Now!
              </button>
            )}
            {laneReadyPhase === "running" && (
              <div
                className="rounded-2xl border p-5 text-center space-y-1"
                style={{ backgroundColor: "rgba(74,222,128,0.07)", borderColor: "rgba(74,222,128,0.3)" }}
              >
                <p className="font-heading font-black uppercase italic" style={{ color: "#4ade80", fontSize: "clamp(18px,4vw,22px)" }}>
                  {laneReadyLabel ? `${laneReadyLabel} is open!` : "Your lane is open!"}
                </p>
                <p className="text-white/60 text-sm">🥿 Shoes will be delivered directly to you.</p>
              </div>
            )}
          </div>
        )}

        {/* ── Two-column on large screens: left = booking info, right = interactive ── */}
        <div className="lg:grid lg:grid-cols-5 lg:gap-6 space-y-4 lg:space-y-0">

        {/* ── LEFT COLUMN ── */}
        <div className="lg:col-span-3 space-y-4">

          {/* ── Hero card ── */}
          <div
            className="rounded-2xl border p-6 sm:p-8"
            style={{
              backgroundColor: isCancelled ? "rgba(253,91,86,0.05)" : "rgba(34,197,94,0.08)",
              borderColor: isCancelled ? `${CORAL}55` : "rgba(34,197,94,0.35)",
            }}
          >
            <div
              className="uppercase font-bold mb-2"
              style={{ color: isCancelled ? CORAL : "#22c55e", fontSize: "11px", letterSpacing: "3px" }}
            >
              {isCancelled ? "Booking cancelled" : cfg.heroLabel}
            </div>
            <h1
              className="font-heading font-black uppercase italic mb-2"
              style={{
                fontSize: "clamp(28px, 5vw, 40px)",
                lineHeight: 1.05,
                color: isCancelled ? "rgba(255,255,255,0.35)" : "white",
                textDecoration: isCancelled ? "line-through" : "none",
              }}
            >
              You&apos;re booked!
            </h1>
            <p className="text-white/70 text-sm leading-relaxed">
              {isCancelled
                ? "This booking has been cancelled."
                : cfg.heroSubtitle(hasPaidDeposit)}
            </p>

            {/* Refund line — shown directly in hero when cancelled */}
            {isCancelled && (() => {
              const refund = cancelRefundCents || (reservation?.refundCents ?? 0);
              return refund > 0 ? (
                <p className="text-white/55 text-sm mt-2">
                  {centsToDollars(refund)} refund will appear on your card in 3–5 business days.
                </p>
              ) : (
                <p className="text-white/55 text-sm mt-2">No charges were made.</p>
              );
            })()}
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
          <div
            className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-7 space-y-3 relative overflow-hidden"
            style={isCancelled ? { opacity: 0.45 } : undefined}
          >
            {/* CANCELED stamp overlay */}
            {isCancelled && (
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                style={{ zIndex: 1 }}
              >
                <div
                  className="font-heading font-black uppercase italic rotate-[-18deg] select-none"
                  style={{
                    fontSize: "clamp(52px, 10vw, 72px)",
                    color: CORAL,
                    opacity: 0.18,
                    letterSpacing: "4px",
                    lineHeight: 1,
                  }}
                >
                  Canceled
                </div>
              </div>
            )}
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

          {/* ── Bowler details ── (hidden when cancelled) */}
          {players.length > 0 && !isCancelled && (
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

        </div>{/* ── END LEFT COLUMN ── */}

        {/* ── RIGHT COLUMN ── */}
        <div className="lg:col-span-2 space-y-4">

          {/* ── Check-in status (desktop only — mobile version sits above grid) ── */}
          {!isCancelled && hasNeonRecord && laneReadyPhase !== "idle" && (
            <div className="hidden lg:block space-y-3">
              {laneReadyPhase === "not_ready" && (
                <div
                  className="w-full rounded-2xl border px-5 py-3.5 flex items-center gap-3"
                  style={{ backgroundColor: "rgba(239,68,68,0.08)", borderColor: "rgba(239,68,68,0.3)" }}
                >
                  <span style={{ fontSize: "18px" }}>🔴</span>
                  <div>
                    <p className="text-sm font-semibold" style={{ color: "#f87171" }}>Lane Not Ready Yet</p>
                    <p className="text-xs text-white/45 mt-0.5">We&apos;ll let you know as soon as it&apos;s set up.</p>
                  </div>
                </div>
              )}
              {laneReadyPhase === "ready" && (
                <button
                  type="button"
                  onClick={() => setCheckInOpen(true)}
                  className="w-full py-4 rounded-2xl font-body font-black uppercase tracking-wider text-white transition-all hover:scale-[1.02] active:scale-100"
                  style={{
                    background: "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)",
                    fontSize: "15px",
                    letterSpacing: "1.5px",
                    boxShadow: "0 4px 24px rgba(34,197,94,0.4)",
                  }}
                >
                  🎳 Your Lane is Ready! Check In Now!
                </button>
              )}
              {laneReadyPhase === "running" && (
                <div
                  className="rounded-2xl border p-5 text-center space-y-1"
                  style={{ backgroundColor: "rgba(74,222,128,0.07)", borderColor: "rgba(74,222,128,0.3)" }}
                >
                  <p className="font-heading font-black uppercase italic" style={{ color: "#4ade80", fontSize: "clamp(18px,4vw,22px)" }}>
                    {laneReadyLabel ? `${laneReadyLabel} is open!` : "Your lane is open!"}
                  </p>
                  <p className="text-white/60 text-sm">🥿 Shoes will be delivered directly to you.</p>
                </div>
              )}
            </div>
          )}

          {/* Check-in modal (portal renders over everything) */}
          {checkInOpen && hasNeonRecord && (
            <CheckInModal neonId={neonId} onClose={() => setCheckInOpen(false)} />
          )}

          {/* ── Arrival instructions (hidden when cancelled) ── */}
          {!isCancelled && (
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
          )}

          {/* ── Cancel section (hidden when already cancelled) ── */}
          {!isCancelled && hasNeonRecord && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5">
              {/* Within 1 hour: self-serve disabled — must call center */}
              {isWithin1Hour && cancelPhase === "idle" && (() => {
                const phone = reservation ? CENTER_PHONE[reservation.centerCode] : null;
                return (
                  <div className="text-center space-y-1">
                    <p className="text-sm text-white/50">
                      Need to cancel? Your reservation starts in less than an hour.
                    </p>
                    <p className="text-sm text-white/70">
                      Please call us
                      {phone ? (
                        <>
                          {" at "}
                          <a
                            href={`tel:${phone.replace(/\D/g, "")}`}
                            className="font-semibold text-white hover:underline"
                          >
                            {phone}
                          </a>
                        </>
                      ) : ""}{" "}
                      to make any changes.
                    </p>
                  </div>
                );
              })()}

              {!isWithin1Hour && cancelPhase === "idle" && (
                <button
                  type="button"
                  onClick={() => setCancelPhase("confirming")}
                  className="w-full text-center text-sm font-body text-white/35 hover:text-white/60 transition-colors underline underline-offset-2"
                >
                  Cancel this booking
                </button>
              )}

              {cancelPhase === "confirming" && (
                <div className="text-center space-y-3">
                  <p className="text-white/70 text-sm">
                    Are you sure you want to cancel?
                    {displayDepositPaid > 0
                      ? ` Your deposit of ${centsToDollars(displayDepositPaid)} will be refunded within 3–5 business days.`
                      : " No charges will be made."}
                  </p>
                  {cancelError && (
                    <p className="text-sm" style={{ color: CORAL }}>{cancelError}</p>
                  )}
                  <div className="flex gap-2 justify-center">
                    <button
                      type="button"
                      onClick={() => { setCancelPhase("idle"); setCancelError(null); }}
                      className="px-5 py-2 rounded-full text-sm font-body font-semibold border border-white/20 text-white/60 hover:text-white transition-colors"
                    >
                      Keep booking
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCancel()}
                      className="px-5 py-2 rounded-full text-sm font-body font-bold text-white transition-colors"
                      style={{ backgroundColor: CORAL }}
                    >
                      Yes, cancel
                    </button>
                  </div>
                </div>
              )}

              {cancelPhase === "busy" && (
                <p className="text-center text-sm text-white/50 animate-pulse">Cancelling…</p>
              )}
            </div>
          )}

          {/* ── Navigation links ── */}
          <div className="flex flex-col sm:flex-row lg:flex-col gap-2 pt-1">
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

        </div>{/* ── END RIGHT COLUMN ── */}
        </div>{/* ── END GRID ── */}
        </div>{/* ── END max-w-5xl ── */}
      </main>
    </div>
  );
}

// ── Loading skeleton ───────────────────────────────────────────────────────

function ConfirmationSkeleton() {
  return (
    <div style={{ backgroundColor: BG }} className="min-h-screen">
      <HeadPinzNav />
      <main className="pt-28 pb-20 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto">
          <div className="lg:grid lg:grid-cols-5 lg:gap-6">
            <div className="lg:col-span-3 animate-pulse space-y-4">
              <div className="h-44 rounded-2xl bg-white/5" />
              <div className="h-64 rounded-2xl bg-white/5" />
            </div>
            <div className="lg:col-span-2 animate-pulse space-y-4 mt-4 lg:mt-0">
              <div className="h-80 rounded-2xl bg-white/5" />
              <div className="h-24 rounded-2xl bg-white/5" />
            </div>
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
