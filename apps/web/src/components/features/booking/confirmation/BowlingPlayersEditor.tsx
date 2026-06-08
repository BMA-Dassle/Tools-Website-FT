"use client";

import { useEffect, useState } from "react";

// Shoe-size catalog — mirrors components/bowling/BowlingConfirmation.tsx so the
// saved label format ("Female 8", "Male 11.5", "Toddler 10") matches what the
// players API + KDS expect.
const SHOE_SIZES: Record<string, string[]> = {
  Toddler: ["6", "7", "8", "9", "10", "11", "12", "13"],
  Male: [
    "1",
    "1.5",
    "2",
    "2.5",
    "3",
    "3.5",
    "4",
    "4.5",
    "5",
    "5.5",
    "6",
    "6.5",
    "7",
    "7.5",
    "8",
    "8.5",
    "9",
    "9.5",
    "10",
    "10.5",
    "11",
    "11.5",
    "12",
    "12.5",
    "13",
    "13.5",
    "14",
    "14.5",
    "15",
  ],
  Female: [
    "1",
    "1.5",
    "2",
    "2.5",
    "3",
    "3.5",
    "4",
    "4.5",
    "5",
    "5.5",
    "6",
    "6.5",
    "7",
    "7.5",
    "8",
    "8.5",
    "9",
    "9.5",
    "10",
    "10.5",
    "11",
    "11.5",
    "12",
  ],
};

interface PlayerRow {
  slot: number;
  name: string;
  shoeSize: string | null;
  bumpers: boolean;
}

interface PlayersResponse {
  players?: Array<{
    slot: number;
    name?: string | null;
    shoeSize?: string | null;
    bumpers?: boolean | null;
  }>;
  shoePairsAllowed?: number;
}

/**
 * Inline editor for bowler names, shoe sizes, and bumpers on the v2 confirmation
 * bowling card. Resolves the Neon reservation id from the qamfReservationId
 * stored in the booking record, then reads/writes via the players API. Renders
 * nothing if the reservation can't be resolved (e.g. legacy/seedless bookings).
 */
export function BowlingPlayersEditor({
  qamfReservationId,
  accent = "#fd5b56",
}: {
  qamfReservationId: string;
  accent?: string;
}) {
  const [neonId, setNeonId] = useState<number | null>(null);
  const [players, setPlayers] = useState<PlayerRow[] | null>(null);
  const [shoePairsAllowed, setShoePairsAllowed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const idRes = await fetch(
          `/api/bowling/v2/reservations/by-qamf/${encodeURIComponent(qamfReservationId)}`,
        );
        if (!idRes.ok) {
          if (alive) setLoading(false);
          return; // No Neon reservation — hide the editor gracefully.
        }
        const idData = (await idRes.json()) as { id: number };
        const res = await fetch(`/api/bowling/v2/reservations/${idData.id}/players`);
        if (!res.ok) throw new Error("Couldn't load bowler details.");
        const data = (await res.json()) as PlayersResponse;
        if (!alive) return;
        setNeonId(idData.id);
        setPlayers(
          (data.players ?? []).map((p) => ({
            slot: p.slot,
            name: p.name && !p.name.startsWith("Bowler ") ? p.name : "",
            shoeSize: p.shoeSize ?? null,
            bumpers: !!p.bumpers,
          })),
        );
        setShoePairsAllowed(data.shoePairsAllowed ?? 0);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Couldn't load bowler details.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [qamfReservationId]);

  function update(slot: number, patch: Partial<PlayerRow>) {
    setPlayers((prev) => prev?.map((p) => (p.slot === slot ? { ...p, ...patch } : p)) ?? prev);
    setSaved(false);
  }

  const shoeCount = players?.filter((p) => p.shoeSize).length ?? 0;

  async function save() {
    if (!players || neonId == null) return;
    setError(null);
    const missing = players.find((p) => p.shoeSize && !p.name.trim());
    if (missing) {
      setError(`Add a name for the bowler in slot ${missing.slot} (required for shoe rental).`);
      return;
    }
    if (shoeCount > shoePairsAllowed) {
      setError(
        `Only ${shoePairsAllowed} shoe rental${shoePairsAllowed !== 1 ? "s" : ""} are included with this booking.`,
      );
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/bowling/v2/reservations/${neonId}/players`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          players: players.map((p) => ({
            slot: p.slot,
            name: p.name.trim() || null,
            shoeSize: p.shoeSize,
            bumpers: p.bumpers,
          })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save bowler details.");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save bowler details.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-white/30 text-xs">Loading bowler details…</p>;
  if (!players || players.length === 0) return null;

  return (
    <div className="pt-3 border-t border-white/[0.08] space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-white font-semibold text-sm">Bowler details</p>
        {shoePairsAllowed > 0 && (
          <p className="text-white/40 text-xs">
            {shoeCount}/{shoePairsAllowed} shoe rental{shoePairsAllowed !== 1 ? "s" : ""}
          </p>
        )}
      </div>
      {players.map((p) => {
        const parts = p.shoeSize ? p.shoeSize.split(" ") : [];
        const cat = parts[0] ?? "";
        const size = parts[1] ?? "";
        return (
          <div
            key={p.slot}
            className="rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-2"
          >
            <input
              type="text"
              value={p.name}
              onChange={(e) => update(p.slot, { name: e.target.value })}
              placeholder={`Bowler ${p.slot} name`}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-white/30"
            />
            <div className="flex flex-wrap items-center gap-2">
              {shoePairsAllowed > 0 && (
                <>
                  <span className="text-white/40 text-xs">Shoes</span>
                  <select
                    value={cat}
                    onChange={(e) => {
                      const c = e.target.value;
                      update(p.slot, { shoeSize: c ? `${c} ${SHOE_SIZES[c]?.[0] ?? ""}` : null });
                    }}
                    className="rounded-lg border border-white/10 bg-[#0a1020] px-2 py-1.5 text-sm text-white outline-none"
                  >
                    <option value="">None</option>
                    <option value="Toddler">Toddler</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                  </select>
                  {cat && (
                    <select
                      value={size}
                      onChange={(e) => update(p.slot, { shoeSize: `${cat} ${e.target.value}` })}
                      className="rounded-lg border border-white/10 bg-[#0a1020] px-2 py-1.5 text-sm text-white outline-none"
                    >
                      {(SHOE_SIZES[cat] ?? []).map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  )}
                </>
              )}
              <label className="ml-auto inline-flex items-center gap-1.5 text-white/60 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={p.bumpers}
                  onChange={(e) => update(p.slot, { bumpers: e.target.checked })}
                  className="h-4 w-4 rounded border-white/20 bg-white/5"
                  style={{ accentColor: accent }}
                />
                Bumpers
              </label>
            </div>
          </div>
        );
      })}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="w-full rounded-lg py-2.5 text-sm font-bold text-[#000418] transition-colors disabled:opacity-50"
        style={{ backgroundColor: accent }}
      >
        {saving ? "Saving…" : saved ? "Saved ✓" : "Save bowler details"}
      </button>
    </div>
  );
}
