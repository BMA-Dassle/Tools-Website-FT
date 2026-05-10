"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import HeadPinzNav from "@/components/headpinz/Nav";
import type { BowlingReservation, BowlingReservationPlayer, ReservationLine } from "@/lib/bowling-db";

/**
 * Bowling check-in page — `/hp/book/bowling/checkin?neonId=X`
 *
 * Reached from the lane-ready SMS / email or the confirmation page's
 * "Your Lane is Ready" button. Three stages:
 *   1. Choice — Express Check-In vs Guest Services
 *   2. Express — bowler form (names/shoes/bumpers) + "Open Lane" button
 *   3. Success — "Let's Bowl!" with lane number
 */

const BG = "#0a1628";
const CORAL = "#fd5b56";
const GOLD = "#FFD700";

const CENTER_NAME: Record<string, string> = {
  TXBSQN0FEKQ11: "HeadPinz Fort Myers",
  PPTR5G2N0QXF7: "HeadPinz Naples",
};

type ReservationWithLines = BowlingReservation & {
  lines: (ReservationLine & { id: number; reservationId: number })[];
};

// ── Shoe sizes ───────────────────────────────────────────────────────

const TODDLER_SIZES = ["6","7","8","9","10","11","12","13"];
const MALE_SIZES    = ["1","1.5","2","2.5","3","3.5","4","4.5","5","5.5","6","6.5","7","7.5","8","8.5","9","9.5","10","10.5","11","11.5","12","12.5","13","13.5","14","14.5","15"];
const FEMALE_SIZES  = ["1","1.5","2","2.5","3","3.5","4","4.5","5","5.5","6","6.5","7","7.5","8","8.5","9","9.5","10","10.5","11","11.5","12"];

type ShoeCategory = "Toddler" | "Male" | "Female";

// ── Helpers ──────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
  } catch { return ""; }
}

// ── Mobile-optimized bowler card ─────────────────────────────────────

function BowlerCard({
  player,
  index,
  shoePairsAllowed,
  shoeSizesAssigned,
  onUpdate,
}: {
  player: BowlingReservationPlayer;
  index: number;
  shoePairsAllowed: number;
  shoeSizesAssigned: number;
  onUpdate: (patch: Partial<BowlingReservationPlayer>) => void;
}) {
  // Derive category from saved value
  const savedCat: ShoeCategory | null = player.shoeSize?.startsWith("Toddler") || player.shoeSize?.startsWith("Kids")
    ? "Toddler"
    : player.shoeSize?.startsWith("Male") || player.shoeSize?.startsWith("Men") || player.shoeSize?.startsWith("Adult")
    ? "Male"
    : player.shoeSize?.startsWith("Female") || player.shoeSize?.startsWith("Women")
    ? "Female"
    : null;

  const [wantsShoes, setWantsShoes] = useState(!!savedCat);
  const [activeCat, setActiveCat] = useState<ShoeCategory | null>(savedCat);

  const nums = activeCat === "Toddler" ? TODDLER_SIZES
    : activeCat === "Male" ? MALE_SIZES
    : activeCat === "Female" ? FEMALE_SIZES
    : [];
  const currentNum = player.shoeSize?.split(" ")[1] ?? null;
  const canPickShoes = !!player.shoeSize || shoeSizesAssigned < shoePairsAllowed;

  function toggleShoes(wants: boolean) {
    setWantsShoes(wants);
    if (!wants) {
      setActiveCat(null);
      onUpdate({ shoeSize: null });
    }
  }

  function selectCat(cat: ShoeCategory) {
    if (activeCat !== cat && player.shoeSize) onUpdate({ shoeSize: null });
    setActiveCat(cat);
  }

  function selectSize(num: string) {
    if (!activeCat) return;
    onUpdate({ shoeSize: `${activeCat} ${num}` });
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-white/40 text-xs font-bold uppercase tracking-widest">
          Bowler {index + 1}
        </span>
        {player.name && !player.name.startsWith("Bowler ") && player.shoeSize && (
          <span className="w-2.5 h-2.5 rounded-full bg-green-400 flex-shrink-0" />
        )}
      </div>

      {/* Name */}
      <input
        type="text"
        value={player.name && !player.name.startsWith("Bowler ") ? player.name : ""}
        onChange={(e) => onUpdate({ name: e.target.value || null })}
        placeholder="Enter name"
        autoComplete="off"
        className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white text-base font-body placeholder:text-white/25 focus:outline-none focus:border-white/40 focus:bg-white/[0.08] transition-colors"
      />

      {/* Bumpers */}
      <div className="flex items-center gap-3">
        <span className="text-white/50 text-sm font-body flex-shrink-0">Bumpers</span>
        <div className="flex rounded-xl overflow-hidden border border-white/15">
          {([true, false] as const).map((val) => (
            <button
              key={String(val)}
              type="button"
              onClick={() => onUpdate({ bumpers: val })}
              className="px-5 py-2.5 text-sm font-body font-semibold transition-colors min-w-[60px]"
              style={{
                backgroundColor: player.bumpers === val
                  ? val ? CORAL : "rgba(255,255,255,0.15)"
                  : "transparent",
                color: player.bumpers === val ? "white" : "rgba(255,255,255,0.35)",
              }}
            >
              {val ? "Yes" : "No"}
            </button>
          ))}
        </div>
      </div>

      {/* Shoes */}
      {shoePairsAllowed > 0 && (
        <div className="space-y-3">
          {/* Want shoes toggle */}
          <div className="flex items-center gap-2">
            <span className="text-white/50 text-sm font-body flex-shrink-0">Shoes</span>
            <div className="flex gap-2 flex-1">
              <button
                type="button"
                onClick={() => toggleShoes(false)}
                className="flex-1 py-2.5 rounded-xl text-sm font-body font-semibold border transition-colors"
                style={{
                  backgroundColor: !wantsShoes ? "rgba(255,255,255,0.12)" : "transparent",
                  borderColor: !wantsShoes ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.1)",
                  color: !wantsShoes ? "white" : "rgba(255,255,255,0.35)",
                }}
              >
                No Shoes
              </button>
              <button
                type="button"
                onClick={() => toggleShoes(true)}
                disabled={!canPickShoes && !wantsShoes}
                className="flex-1 py-2.5 rounded-xl text-sm font-body font-semibold border transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: wantsShoes ? "rgba(34,197,94,0.15)" : "transparent",
                  borderColor: wantsShoes ? "rgba(34,197,94,0.4)" : "rgba(255,255,255,0.1)",
                  color: wantsShoes ? "#4ade80" : "rgba(255,255,255,0.35)",
                }}
              >
                Rental Shoes
              </button>
            </div>
          </div>

          {/* Category */}
          {wantsShoes && (
            <div className="flex gap-2">
              {(["Toddler", "Male", "Female"] as ShoeCategory[]).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => selectCat(cat)}
                  className="flex-1 py-3 rounded-xl text-sm font-body font-semibold border transition-colors min-h-[44px]"
                  style={{
                    backgroundColor: activeCat === cat ? CORAL : "rgba(255,255,255,0.04)",
                    borderColor: activeCat === cat ? CORAL : "rgba(255,255,255,0.12)",
                    color: activeCat === cat ? "white" : "rgba(255,255,255,0.5)",
                  }}
                >
                  {cat === "Male" ? "Men" : cat === "Female" ? "Women" : cat}
                </button>
              ))}
            </div>
          )}

          {/* Size chips */}
          {wantsShoes && activeCat && (
            <div className="flex gap-2 flex-wrap">
              {nums.map((num) => {
                const selected = currentNum === num && player.shoeSize?.startsWith(activeCat);
                return (
                  <button
                    key={num}
                    type="button"
                    onClick={() => selectSize(num)}
                    className="min-w-[44px] px-3 py-2.5 rounded-xl text-sm font-body font-semibold border transition-colors"
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

// ── Main content ─────────────────────────────────────────────────────

type Stage = "loading" | "choice" | "guest-services" | "express" | "opening" | "success" | "error" | "not-ready" | "cancelled";

function CheckinContent() {
  const sp = useSearchParams();
  const neonIdStr = sp.get("neonId") ?? "0";
  const neonId = parseInt(neonIdStr, 10);

  const [stage, setStage] = useState<Stage>("loading");
  const [reservation, setReservation] = useState<ReservationWithLines | null>(null);
  const [players, setPlayers] = useState<BowlingReservationPlayer[]>([]);
  const [shoePairsAllowed, setShoePairsAllowed] = useState(0);
  const [laneNumbers, setLaneNumbers] = useState<number[]>([]);
  const [laneLabel, setLaneLabel] = useState("");
  const [phase, setPhase] = useState<string>("");
  const [openError, setOpenError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Data fetching ──────────────────────────────────────────────
  useEffect(() => {
    if (!neonId || isNaN(neonId)) {
      setStage("error");
      setOpenError("Invalid reservation link.");
      return;
    }

    let alive = true;
    (async () => {
      try {
        // Fetch reservation, players, and lane status in parallel
        const [resRes, playersRes, checkinRes] = await Promise.all([
          fetch(`/api/bowling/v2/reservations/${neonId}`, { cache: "no-store" }),
          fetch(`/api/bowling/v2/reservations/${neonId}/players`, { cache: "no-store" }),
          fetch(`/api/bowling/v2/reservations/${neonId}/checkin`, { cache: "no-store" }),
        ]);

        if (!alive) return;

        if (!resRes.ok) {
          setStage("error");
          setOpenError("Reservation not found.");
          return;
        }

        const resData = await resRes.json() as ReservationWithLines;
        setReservation(resData);

        if (resData.status === "cancelled") {
          setStage("cancelled");
          return;
        }

        if (playersRes.ok) {
          const pData = await playersRes.json() as {
            players: BowlingReservationPlayer[];
            shoePairsAllowed: number;
            laneNumbers: number[];
          };
          setPlayers(pData.players);
          setShoePairsAllowed(pData.shoePairsAllowed);
          setLaneNumbers(pData.laneNumbers ?? []);
        }

        if (checkinRes.ok) {
          const cData = await checkinRes.json() as {
            phase?: string;
            laneLabel?: string;
            laneNumbers?: number[];
          };
          const p = cData.phase ?? "not_ready";
          setPhase(p);
          if (cData.laneLabel) setLaneLabel(cData.laneLabel);
          if (cData.laneNumbers?.length && !laneNumbers.length) {
            setLaneNumbers(cData.laneNumbers);
          }

          if (p === "running" || p === "completed") {
            setStage("success");
          } else if (p === "cancelled") {
            setStage("cancelled");
          } else if (p === "not_ready") {
            setStage("not-ready");
          } else {
            setStage("choice");
          }
        } else {
          setStage("choice"); // fallback — show options anyway
        }
      } catch {
        if (alive) {
          setStage("error");
          setOpenError("Unable to load your reservation. Please try again.");
        }
      }
    })();
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neonId]);

  // ── Poll for lane ready when not_ready ──────────────────────────
  useEffect(() => {
    if (stage !== "not-ready" || !neonId) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/bowling/v2/reservations/${neonId}/checkin`, { cache: "no-store" });
        if (!res.ok || !alive) return;
        const data = await res.json() as { phase?: string; laneLabel?: string };
        if (!alive) return;
        const p = data.phase ?? "";
        if (p === "ready") {
          setPhase("ready");
          if (data.laneLabel) setLaneLabel(data.laneLabel);
          setStage("choice");
        } else if (p === "running" || p === "completed") {
          if (data.laneLabel) setLaneLabel(data.laneLabel);
          setStage("success");
        }
      } catch { /* silent */ }
    }, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [stage, neonId]);

  // ── Player update ──────────────────────────────────────────────
  function updatePlayer(slot: number, patch: Partial<BowlingReservationPlayer>) {
    setPlayers((prev) => prev.map((p) => (p.slot === slot ? { ...p, ...patch } : p)));
  }

  // ── Open lane handler ──────────────────────────────────────────
  async function handleOpenLane() {
    setSaveError(null);
    setStage("opening");

    // Validate: require name for bowlers with shoe sizes
    const missing = players.find(
      (p) => p.shoeSize && (!p.name || p.name.startsWith("Bowler ")),
    );
    if (missing) {
      setSaveError(`Please enter a name for Bowler ${missing.slot}.`);
      setStage("express");
      return;
    }

    try {
      // 1. Save players
      const saveRes = await fetch(`/api/bowling/v2/reservations/${neonId}/players`, {
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
      if (!saveRes.ok) {
        const d = await saveRes.json().catch(() => ({})) as { error?: string };
        throw new Error(d.error ?? "Failed to save bowler info");
      }

      // 2. Open lane
      const openRes = await fetch(`/api/bowling/v2/reservations/${neonId}/checkin`, {
        method: "POST",
      });
      const openData = await openRes.json() as { ok?: boolean; laneLabel?: string; error?: string };
      if (!openRes.ok) {
        throw new Error(openData.error ?? "Failed to open lane");
      }

      if (openData.laneLabel) setLaneLabel(openData.laneLabel);
      setStage("success");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Something went wrong");
      setStage("express");
    }
  }

  const centerName = reservation ? (CENTER_NAME[reservation.centerCode] ?? "HeadPinz") : "HeadPinz";
  const timeStr = reservation ? formatTime(reservation.bookedAt) : "";
  const guestFirst = (reservation?.guestName ?? "").split(" ")[0] || "";
  const hasAnyName = players.some((p) => p.name && !p.name.startsWith("Bowler "));
  const hasAnyShoes = players.some((p) => p.shoeSize);

  // Build lane label from laneNumbers if not set from API
  const displayLaneLabel = laneLabel || (
    laneNumbers.length === 1 ? `Lane ${laneNumbers[0]}`
    : laneNumbers.length > 1 ? `Lanes ${laneNumbers.join(", ")}`
    : ""
  );

  return (
    <div style={{ backgroundColor: BG }} className="min-h-screen">
      <HeadPinzNav />

      <main className="pt-24 sm:pt-32 pb-32 px-4 sm:px-6">
        <div className="max-w-lg mx-auto">

          {/* ── Loading ── */}
          {stage === "loading" && (
            <div className="text-center py-20">
              <div className="w-10 h-10 border-2 border-white/20 border-t-white/70 rounded-full animate-spin mx-auto" />
              <p className="text-white/40 text-sm mt-4">Loading your reservation...</p>
            </div>
          )}

          {/* ── Error ── */}
          {stage === "error" && (
            <div className="text-center py-16 space-y-4">
              <div className="text-4xl">⚠️</div>
              <p className="text-white font-semibold text-lg">Something went wrong</p>
              <p className="text-white/50 text-sm">{openError ?? "Please try again."}</p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-6 py-3 rounded-xl font-body font-bold text-sm text-white transition-all hover:scale-[1.02]"
                style={{ backgroundColor: CORAL }}
              >
                Try Again
              </button>
            </div>
          )}

          {/* ── Cancelled ── */}
          {stage === "cancelled" && (
            <div className="text-center py-16 space-y-4">
              <div className="text-4xl">🚫</div>
              <p className="text-white font-semibold text-lg">Reservation Cancelled</p>
              <p className="text-white/50 text-sm">This bowling reservation has been cancelled.</p>
            </div>
          )}

          {/* ── Not Ready ── */}
          {stage === "not-ready" && (
            <div className="text-center py-12 space-y-6">
              <div className="text-5xl">⏳</div>
              <div>
                <p className="text-white font-heading font-black uppercase italic text-xl mb-2">
                  Lane Not Ready Yet
                </p>
                <p className="text-white/50 text-sm leading-relaxed max-w-xs mx-auto">
                  We&apos;re setting up your lane. This page will update automatically when it&apos;s ready.
                </p>
              </div>
              {reservation && (
                <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm space-y-1.5 text-left max-w-xs mx-auto">
                  <div className="flex justify-between">
                    <span className="text-white/40">Time</span>
                    <span className="text-white">{timeStr}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-white/40">Location</span>
                    <span className="text-white">{centerName}</span>
                  </div>
                  {reservation.qamfReservationId && (
                    <div className="flex justify-between">
                      <span className="text-white/40">Ref</span>
                      <span className="text-white font-mono text-xs">{reservation.qamfReservationId}</span>
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center justify-center gap-2 text-white/30 text-xs">
                <div className="w-3 h-3 border border-white/30 border-t-white/60 rounded-full animate-spin" />
                Checking every 15 seconds...
              </div>
            </div>
          )}

          {/* ── Choice Screen ── */}
          {stage === "choice" && (
            <div className="space-y-5">
              {/* Hero */}
              <div className="text-center space-y-2 pb-2">
                <p className="text-4xl">🎳</p>
                <h1
                  className="font-heading font-black uppercase italic"
                  style={{ fontSize: "clamp(24px, 6vw, 34px)", lineHeight: 1.1, color: "#4ade80" }}
                >
                  Your Lane is Ready!
                </h1>
                {displayLaneLabel && (
                  <p className="font-heading font-bold text-white text-lg">{displayLaneLabel}</p>
                )}
                <p className="text-white/50 text-sm">
                  {centerName}{timeStr ? ` · ${timeStr}` : ""}
                  {reservation?.playerCount ? ` · ${reservation.playerCount} bowler${reservation.playerCount !== 1 ? "s" : ""}` : ""}
                </p>
              </div>

              {/* Express Check-In */}
              <button
                type="button"
                onClick={() => setStage("express")}
                className="w-full rounded-2xl border p-6 text-left transition-all hover:scale-[1.01] active:scale-[0.99]"
                style={{
                  background: "linear-gradient(135deg, rgba(34,197,94,0.12) 0%, rgba(22,163,74,0.08) 100%)",
                  borderColor: "rgba(34,197,94,0.35)",
                }}
              >
                <div className="flex items-start gap-4">
                  <span className="text-2xl flex-shrink-0 mt-0.5">⚡</span>
                  <div>
                    <p className="text-white font-heading font-bold text-lg uppercase">
                      Express Check-In
                    </p>
                    <p className="text-white/55 text-sm mt-1 leading-relaxed">
                      Enter names &amp; shoe sizes, then start bowling right from your phone.
                    </p>
                  </div>
                </div>
              </button>

              {/* Guest Services */}
              <button
                type="button"
                onClick={() => setStage("guest-services")}
                className="w-full rounded-2xl border border-white/15 bg-white/[0.03] p-6 text-left transition-all hover:scale-[1.01] active:scale-[0.99] hover:bg-white/[0.05]"
              >
                <div className="flex items-start gap-4">
                  <span className="text-2xl flex-shrink-0 mt-0.5">🏬</span>
                  <div>
                    <p className="text-white font-heading font-bold text-lg uppercase">
                      Guest Services
                    </p>
                    <p className="text-white/55 text-sm mt-1 leading-relaxed">
                      Head to the front desk &mdash; we&apos;ll get you set up.
                    </p>
                  </div>
                </div>
              </button>
            </div>
          )}

          {/* ── Guest Services ── */}
          {stage === "guest-services" && (
            <div className="space-y-6 text-center">
              <button
                type="button"
                onClick={() => setStage("choice")}
                className="text-white/40 text-sm hover:text-white/70 transition-colors self-start"
              >
                ← Back
              </button>
              <div className="text-5xl">🏬</div>
              <div>
                <p className="text-white font-heading font-black uppercase italic text-xl mb-2">
                  Head to Guest Services
                </p>
                <p className="text-white/50 text-sm">
                  Show this screen at the front desk and we&apos;ll get you started.
                </p>
              </div>
              <div className="rounded-2xl border border-white/15 bg-white/[0.03] p-5 space-y-2 text-left">
                {reservation?.guestName && (
                  <div className="flex justify-between text-sm">
                    <span className="text-white/40">Guest</span>
                    <span className="text-white font-semibold">{reservation.guestName}</span>
                  </div>
                )}
                {reservation?.qamfReservationId && (
                  <div className="flex justify-between text-sm">
                    <span className="text-white/40">Booking ref</span>
                    <span className="text-white font-mono">{reservation.qamfReservationId}</span>
                  </div>
                )}
                {displayLaneLabel && (
                  <div className="flex justify-between text-sm">
                    <span className="text-white/40">Lane</span>
                    <span className="text-white font-semibold">{displayLaneLabel}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-white/40">Time</span>
                  <span className="text-white">{timeStr}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-white/40">Location</span>
                  <span className="text-white">{centerName}</span>
                </div>
              </div>
            </div>
          )}

          {/* ── Express Check-In ── */}
          {(stage === "express" || stage === "opening") && (
            <div className="space-y-4">
              {/* Header */}
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStage("choice")}
                  className="text-white/40 text-sm hover:text-white/70 transition-colors"
                >
                  ← Back
                </button>
                <div
                  className="uppercase font-bold text-right"
                  style={{ color: GOLD, fontSize: "10px", letterSpacing: "2.5px" }}
                >
                  Express Check-In
                </div>
              </div>

              {displayLaneLabel && (
                <div className="text-center">
                  <p className="text-green-400 font-heading font-bold text-sm uppercase tracking-wider">
                    {displayLaneLabel} is ready
                  </p>
                </div>
              )}

              {/* Bowler cards — all expanded for express check-in */}
              <div className="space-y-3">
                {players.map((player, i) => (
                  <BowlerCard
                    key={player.slot}
                    player={player}
                    index={i}
                    shoePairsAllowed={shoePairsAllowed}
                    shoeSizesAssigned={players.filter((p) => p.shoeSize).length}
                    onUpdate={(patch) => updatePlayer(player.slot, patch)}
                  />
                ))}
              </div>

              {/* Shoe pair counter */}
              {shoePairsAllowed > 0 && (
                <p className="text-white/30 text-xs text-right">
                  {players.filter((p) => p.shoeSize).length} of {shoePairsAllowed} shoe pair{shoePairsAllowed !== 1 ? "s" : ""} assigned
                </p>
              )}

              {/* Error */}
              {saveError && (
                <div
                  className="rounded-xl p-3.5 text-sm font-body"
                  style={{
                    backgroundColor: "rgba(253,91,86,0.12)",
                    border: "1.5px solid rgba(253,91,86,0.35)",
                    color: CORAL,
                  }}
                >
                  {saveError}
                </div>
              )}
            </div>
          )}

          {/* ── Success ── */}
          {stage === "success" && (
            <div className="text-center py-10 space-y-6">
              <div className="text-6xl">🎳</div>
              <div>
                <h1
                  className="font-heading font-black uppercase italic mb-2"
                  style={{ fontSize: "clamp(28px, 7vw, 40px)", color: GOLD, lineHeight: 1.1 }}
                >
                  Let&apos;s Bowl!
                </h1>
                {displayLaneLabel && (
                  <p
                    className="font-heading font-bold text-xl mt-3"
                    style={{ color: "#4ade80" }}
                  >
                    {displayLaneLabel} is open
                  </p>
                )}
              </div>
              {hasAnyShoes && (
                <p className="text-white/60 text-sm">
                  🥿 Shoes will be delivered to your lane.
                </p>
              )}
              <p className="text-white/35 text-xs">
                {centerName}{guestFirst ? ` · ${guestFirst}` : ""}
              </p>
            </div>
          )}

        </div>
      </main>

      {/* ── Sticky bottom bar — Open Lane button ── */}
      {(stage === "express" || stage === "opening") && (
        <div
          className="fixed bottom-0 inset-x-0 p-4 pb-6"
          style={{
            background: "linear-gradient(to top, #0a1628 60%, transparent)",
          }}
        >
          <div className="max-w-lg mx-auto">
            <button
              type="button"
              onClick={() => void handleOpenLane()}
              disabled={stage === "opening" || !hasAnyName}
              className="w-full py-4 rounded-2xl font-body font-black uppercase tracking-wider text-white text-base transition-all hover:scale-[1.02] active:scale-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
              style={{
                background: stage === "opening"
                  ? "rgba(34,197,94,0.3)"
                  : "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)",
                boxShadow: stage !== "opening" && hasAnyName ? "0 4px 24px rgba(34,197,94,0.4)" : "none",
              }}
            >
              {stage === "opening" ? (
                <span className="flex items-center justify-center gap-3">
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Opening Lane...
                </span>
              ) : (
                "🎳 Open My Lane"
              )}
            </button>
            {!hasAnyName && stage === "express" && (
              <p className="text-center text-white/30 text-xs mt-2">
                Enter at least one bowler name to continue
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────

function CheckinSkeleton() {
  return (
    <div style={{ backgroundColor: BG }} className="min-h-screen">
      <HeadPinzNav />
      <main className="pt-28 pb-20 px-4">
        <div className="max-w-lg mx-auto animate-pulse space-y-6">
          <div className="h-8 bg-white/5 rounded-xl w-48 mx-auto" />
          <div className="h-32 bg-white/5 rounded-2xl" />
          <div className="h-32 bg-white/5 rounded-2xl" />
        </div>
      </main>
    </div>
  );
}

// ── Exported component ───────────────────────────────────────────────

export default function BowlingCheckin() {
  return (
    <Suspense fallback={<CheckinSkeleton />}>
      <CheckinContent />
    </Suspense>
  );
}
