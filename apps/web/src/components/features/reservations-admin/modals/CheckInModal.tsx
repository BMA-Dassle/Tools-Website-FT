"use client";

/**
 * Check-In modal for the admin reservations board — lane phase (with 10s
 * not-ready polling), per-bowler shoe sizes/names, save-shoes vs open-lanes.
 * Extracted verbatim from app/admin/[token]/reservations/ReservationsClient.tsx
 * (only the overlay wrapper moved to ModalShell).
 */
import { useEffect, useState } from "react";
import {
  CENTERS,
  KIND_FULL_LABELS,
  SHOE_CATEGORY_LABELS,
  SHOE_SIZES,
} from "~/features/reservations-admin/constants";
import { fmtDate, fmtTime } from "~/features/reservations-admin/format";
import type { Reservation, ShoeCategory } from "~/features/reservations-admin/types";
import { CENTER_CODE_TO_QAMF_ID, isFastTraxDuckpinCenter } from "@/lib/qamf-centers";
import ModalShell from "../ModalShell";
import { INPUT_STYLE, NAV_BTN } from "../theme";

export default function CheckInModal({
  reservation,
  token,
  onClose,
  onCheckedIn,
}: {
  reservation: Reservation;
  token: string;
  onClose: () => void;
  onCheckedIn: (msg: string) => void;
}) {
  const [phase, setPhase] = useState<string>("loading");
  const [laneLabel, setLaneLabel] = useState("");
  const [laneNumbers, setLaneNumbers] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savingShoes, setSavingShoes] = useState(false);

  // Shoe sizes + optional names: one entry per player slot
  const playerCount = reservation.playerCount ?? 1;
  const [shoes, setShoes] = useState<Array<{ category: ShoeCategory | null; size: string | null }>>(
    () => Array.from({ length: playerCount }, () => ({ category: null, size: null })),
  );
  const [names, setNames] = useState<string[]>(() => Array.from({ length: playerCount }, () => ""));

  // Parse existing shoe size string like "Female 8" into category + size
  function parseShoeSize(raw: string | null): {
    category: ShoeCategory | null;
    size: string | null;
  } {
    if (!raw) return { category: null, size: null };
    const space = raw.indexOf(" ");
    if (space === -1) return { category: null, size: null };
    const cat = raw.slice(0, space);
    const sz = raw.slice(space + 1);
    if (cat === "Female" || cat === "Women") return { category: "Female", size: sz };
    if (cat === "Male" || cat === "Men") return { category: "Male", size: sz };
    if (cat === "Toddler" || cat === "Kids") return { category: "Toddler", size: sz };
    return { category: null, size: null };
  }

  // Fetch phase + existing players on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [phaseRes, playersRes] = await Promise.all([
          fetch(`/api/bowling/v2/reservations/${reservation.id}/checkin`, { cache: "no-store" }),
          fetch(`/api/bowling/v2/reservations/${reservation.id}/players`, { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (phaseRes.ok) {
          const pd = await phaseRes.json();
          setPhase(pd.phase || "not_ready");
          setLaneLabel(pd.laneLabel || "");
          setLaneNumbers(pd.laneNumbers || []);
        } else {
          setPhase("error");
        }
        if (playersRes.ok) {
          const plData = await playersRes.json();
          const existing = (plData.players || []) as Array<{
            slot: number;
            name?: string | null;
            shoeSize?: string | null;
          }>;
          if (existing.length > 0) {
            setShoes((prev) =>
              prev.map((_, i) => {
                const player = existing.find((p) => p.slot === i + 1);
                return parseShoeSize(player?.shoeSize ?? null);
              }),
            );
            setNames((prev) =>
              prev.map((_, i) => {
                const player = existing.find((p) => p.slot === i + 1);
                const n = player?.name ?? "";
                return n.startsWith("Bowler ") ? "" : n;
              }),
            );
          }
        }
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reservation.id]);

  // Poll phase every 10s while not_ready
  useEffect(() => {
    if (phase !== "not_ready") return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/bowling/v2/reservations/${reservation.id}/checkin`, {
          cache: "no-store",
        });
        if (res.ok) {
          const pd = await res.json();
          setPhase(pd.phase || "not_ready");
          setLaneLabel(pd.laneLabel || "");
          setLaneNumbers(pd.laneNumbers || []);
        }
      } catch {
        /* ignore */
      }
    }, 10_000);
    return () => clearInterval(id);
  }, [phase, reservation.id]);

  function shoeString(s: { category: ShoeCategory | null; size: string | null }): string | null {
    if (!s.category || !s.size) return null;
    return `${s.category} ${s.size}`;
  }

  async function saveShoes() {
    const payload = shoes.map((s, i) => ({
      slot: i + 1,
      shoeSize: shoeString(s),
      name: names[i]?.trim() || `Bowler ${i + 1}`,
    }));
    const res = await fetch(`/api/bowling/v2/reservations/${reservation.id}/players`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ players: payload }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `Save shoes failed (${res.status})`);
    }
  }

  async function handleSaveShoesOnly() {
    setSavingShoes(true);
    setError(null);
    try {
      await saveShoes();
      onCheckedIn("Shoe sizes saved");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSavingShoes(false);
    }
  }

  async function handleCheckin() {
    setSubmitting(true);
    setError(null);
    try {
      // 1. Save shoe sizes
      await saveShoes();
      // 2. Open lanes (express check-in POST)
      const openRes = await fetch(`/api/bowling/v2/reservations/${reservation.id}/checkin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const openData = await openRes.json();
      if (!openRes.ok) throw new Error(openData.error || `Lane open failed (${openRes.status})`);
      // 3. Override method to "desk" (admin check-in)
      await fetch(`/api/admin/bowling/reservations/checkin?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ neonId: reservation.id, method: "desk" }),
      });
      onCheckedIn(`Checked in — ${openData.laneLabel || laneLabel || "lanes opened"}`);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Phase banner colors
  const bannerStyle: Record<string, { bg: string; border: string; color: string; text: string }> = {
    loading: {
      bg: "var(--ba-bg2)",
      border: "var(--ba-border)",
      color: "var(--ba-muted)",
      text: "Loading lane status…",
    },
    not_ready: {
      bg: "rgba(245,158,11,0.1)",
      border: "rgba(245,158,11,0.25)",
      color: "#f59e0b",
      text: "Lanes not yet assigned — polling for updates…",
    },
    ready: {
      bg: "rgba(34,197,94,0.1)",
      border: "rgba(34,197,94,0.25)",
      color: "#22c55e",
      text: `${laneLabel || "Lane"} ready`,
    },
    running: {
      bg: "rgba(20,184,166,0.1)",
      border: "rgba(20,184,166,0.25)",
      color: "#14b8a6",
      text: `Already open — ${laneLabel || "lanes running"}`,
    },
    completed: {
      bg: "var(--ba-bg2)",
      border: "var(--ba-border)",
      color: "var(--ba-muted)",
      text: "Session completed",
    },
    cancelled: {
      bg: "var(--ba-bg2)",
      border: "var(--ba-border)",
      color: "var(--ba-muted)",
      text: "Reservation cancelled",
    },
    error: {
      bg: "rgba(239,68,68,0.1)",
      border: "rgba(239,68,68,0.25)",
      color: "#ef4444",
      text: "Failed to load lane status",
    },
  };
  // Duckpin (FastTrax 11542) booked lanes sit at QAMF "Confirmed" and never
  // reach "Ready" — there's no Conqueror front-desk step like HeadPinz. So the
  // check-in GET only flips to phase="ready" via the 30-min self-service gate.
  // For staff, that window is wrong: they must be able to open an assigned lane
  // on demand (early walk-up, or a multi-lane party where one lane is still
  // busy). When lanes ARE assigned we treat not_ready as staff-openable.
  const isDuckpin = isFastTraxDuckpinCenter(CENTER_CODE_TO_QAMF_ID[reservation.centerCode]);
  const lanesAssigned = laneNumbers.length > 0 || laneLabel.length > 0;
  const staffCanOpen = phase === "ready" || (isDuckpin && phase === "not_ready" && lanesAssigned);

  const banner = { ...(bannerStyle[phase] || bannerStyle.error) };
  // Don't mislabel an assigned-but-not-started lane as "not yet assigned".
  if (phase === "not_ready" && lanesAssigned) {
    banner.text = isDuckpin
      ? `${laneLabel || "Lane"} assigned — ready to open`
      : `${laneLabel || "Lane"} assigned — waiting on lane setup…`;
  }

  return (
    <ModalShell onClose={onClose} maxWidth={500}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <h3
          style={{
            fontSize: "1rem",
            fontWeight: 700,
            color: "#22c55e",
            margin: 0,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Check In
        </h3>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "var(--ba-muted)",
            cursor: "pointer",
            fontSize: "1.2rem",
          }}
        >
          &times;
        </button>
      </div>

      {/* Reservation info */}
      <div
        style={{
          padding: "0.75rem",
          borderRadius: 10,
          backgroundColor: "var(--ba-bg2)",
          border: "1px solid var(--ba-border)",
          marginBottom: "1rem",
          fontSize: "0.8rem",
          lineHeight: 1.7,
        }}
      >
        <div>
          <strong style={{ color: "var(--ba-fg)" }}>{reservation.guestName || "Guest"}</strong>
        </div>
        <div style={{ color: "var(--ba-muted)" }}>
          {fmtTime(reservation.bookedAt)} &middot; {fmtDate(reservation.bookedAt)} &middot;{" "}
          {CENTERS[reservation.centerCode] ?? reservation.centerCode}
        </div>
        <div style={{ color: "var(--ba-muted)" }}>
          {playerCount} bowler{playerCount > 1 ? "s" : ""} &middot;{" "}
          {KIND_FULL_LABELS[reservation.productKind] ?? reservation.productKind}
        </div>
      </div>

      {/* Phase banner */}
      <div
        style={{
          padding: "0.6rem 0.75rem",
          borderRadius: 8,
          backgroundColor: banner.bg,
          border: `1px solid ${banner.border}`,
          fontSize: "0.75rem",
          fontWeight: 600,
          color: banner.color,
          marginBottom: "1rem",
        }}
      >
        {banner.text}
      </div>

      {/* Shoe size picker — FastTrax duckpin has NO rental shoes, so staff never
          see the picker for it (owner 2026-07-26). The guest express check-in
          already hides shoes for duckpin via shoePairsAllowed=0. */}
      {!isDuckpin && phase !== "loading" && phase !== "completed" && phase !== "cancelled" && (
        <div style={{ marginBottom: "1rem" }}>
          <span
            style={{
              fontSize: "0.7rem",
              color: "var(--ba-muted)",
              display: "block",
              marginBottom: 8,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontWeight: 600,
            }}
          >
            Shoe Sizes
          </span>
          {shoes.map((shoe, idx) => (
            <div
              key={idx}
              style={{
                marginBottom: 10,
                padding: "0.5rem",
                borderRadius: 8,
                backgroundColor: "var(--ba-bg2)",
                border: "1px solid var(--ba-border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span
                  style={{
                    fontSize: "0.7rem",
                    fontWeight: 600,
                    color: "var(--ba-muted)",
                    whiteSpace: "nowrap",
                  }}
                >
                  Bowler {idx + 1}
                </span>
                <input
                  type="text"
                  placeholder="Name (optional)"
                  value={names[idx] ?? ""}
                  onChange={(e) =>
                    setNames((prev) => prev.map((n, i) => (i === idx ? e.target.value : n)))
                  }
                  style={{
                    ...INPUT_STYLE,
                    padding: "0.2rem 0.5rem",
                    fontSize: "0.68rem",
                    flex: 1,
                  }}
                />
              </div>
              {/* Category buttons */}
              <div style={{ display: "flex", gap: 4, marginBottom: shoe.category ? 6 : 0 }}>
                {(["Toddler", "Male", "Female"] as ShoeCategory[]).map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() =>
                      setShoes((prev) =>
                        prev.map((s, i) =>
                          i === idx ? { category: s.category === cat ? null : cat, size: null } : s,
                        ),
                      )
                    }
                    style={{
                      padding: "0.25rem 0.6rem",
                      borderRadius: 6,
                      fontSize: "0.65rem",
                      fontWeight: 600,
                      cursor: "pointer",
                      border: `1px solid ${shoe.category === cat ? "rgba(0,226,229,0.4)" : "var(--ba-border)"}`,
                      backgroundColor:
                        shoe.category === cat ? "rgba(0,226,229,0.15)" : "var(--ba-input-bg)",
                      color: shoe.category === cat ? "#00E2E5" : "var(--ba-muted)",
                    }}
                  >
                    {SHOE_CATEGORY_LABELS[cat]}
                  </button>
                ))}
                {shoe.category && shoe.size && (
                  <span
                    style={{
                      marginLeft: "auto",
                      fontSize: "0.65rem",
                      fontWeight: 600,
                      color: "#00E2E5",
                    }}
                  >
                    {SHOE_CATEGORY_LABELS[shoe.category]} {shoe.size}
                  </span>
                )}
              </div>
              {/* Size chips */}
              {shoe.category && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4 }}>
                  {SHOE_SIZES[shoe.category].map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={() =>
                        setShoes((prev) => prev.map((s, i) => (i === idx ? { ...s, size: sz } : s)))
                      }
                      style={{
                        padding: "0.2rem 0.4rem",
                        borderRadius: 5,
                        fontSize: "0.6rem",
                        fontWeight: 600,
                        cursor: "pointer",
                        minWidth: 28,
                        textAlign: "center",
                        border: `1px solid ${shoe.size === sz ? "#22c55e" : "var(--ba-border)"}`,
                        backgroundColor:
                          shoe.size === sz ? "rgba(34,197,94,0.15)" : "var(--ba-input-bg)",
                        color: shoe.size === sz ? "#22c55e" : "var(--ba-fg)",
                      }}
                    >
                      {sz}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          style={{
            padding: "0.5rem 0.75rem",
            borderRadius: 8,
            fontSize: "0.8rem",
            fontWeight: 600,
            marginBottom: "1rem",
            backgroundColor: "rgba(239,68,68,0.15)",
            color: "#ef4444",
            border: "1px solid rgba(239,68,68,0.3)",
          }}
        >
          {error}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onClose} style={{ ...NAV_BTN, fontSize: "0.8rem" }}>
          Close
        </button>
        {!isDuckpin &&
          ((phase === "not_ready" && !staffCanOpen) ||
            phase === "running" ||
            phase === "error") && (
            <button
              type="button"
              onClick={handleSaveShoesOnly}
              disabled={savingShoes}
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: 8,
                fontSize: "0.8rem",
                fontWeight: 700,
                cursor: savingShoes ? "not-allowed" : "pointer",
                border: "none",
                backgroundColor: savingShoes ? "rgba(0,226,229,0.2)" : "rgba(0,226,229,0.9)",
                color: savingShoes ? "rgba(0,226,229,0.5)" : "#000418",
                opacity: savingShoes ? 0.6 : 1,
              }}
            >
              {savingShoes ? "Saving…" : "Save Shoes"}
            </button>
          )}
        {staffCanOpen && (
          <button
            type="button"
            onClick={handleCheckin}
            disabled={submitting}
            style={{
              padding: "0.5rem 1.25rem",
              borderRadius: 8,
              fontSize: "0.8rem",
              fontWeight: 700,
              cursor: submitting ? "not-allowed" : "pointer",
              border: "none",
              backgroundColor: submitting ? "rgba(34,197,94,0.3)" : "#22c55e",
              color: "#fff",
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? "Checking in…" : "Check In & Open Lanes"}
          </button>
        )}
      </div>
    </ModalShell>
  );
}
