"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import CenterPicker, { CENTERS } from "@/components/admin/bowling/CenterPicker";
import AdminBowlerList from "@/components/admin/bowling/AdminBowlerList";
import LanePicker from "@/components/admin/bowling/LanePicker";
import type { AdminBowlerSelection } from "@/components/admin/bowling/BowlerEditor";
import type { Lane } from "@/lib/qamf-bowling";

// ── Types ──────────────────────────────────────────────────────────────

interface PassMember {
  id: number;
  passId: number;
  relation: "kid" | "family";
  slot: number;
  firstName: string;
  lastName: string;
  birthday: string;
  prefs?: { wantBumpers: boolean | null; shoeSize?: string | null } | null;
}

interface KbfPass {
  id: number;
  email: string;
  centerName: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  preferred2fa: "sms" | "email";
  isTest: boolean;
  fpass: boolean;
  members: PassMember[];
}

interface RedeemedPair {
  passId: number;
  slot: number;
}

type Mode = "bowl-now" | "book-lane";
type Phase = "idle" | "searching" | "ready" | "submitting" | "done" | "error";

// ── Helpers ────────────────────────────────────────────────────────────

const CENTER_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

function centerCodeForName(name: string): string {
  if (name.includes("Naples")) return "PPTR5G2N0QXF7";
  return "TXBSQN0FEKQ11";
}

// ── Component ──────────────────────────────────────────────────────────

export default function KbfAdminClient({ token }: { token: string }) {
  // State: center + search
  const [centerCode, setCenterCode] = useState<string>(CENTERS[0].code);
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  // State: account results
  const [passes, setPasses] = useState<KbfPass[]>([]);
  const [selectedPass, setSelectedPass] = useState<KbfPass | null>(null);
  const [redeemedToday, setRedeemedToday] = useState<RedeemedPair[]>([]);

  // State: bowlers
  const [bowlers, setBowlers] = useState<AdminBowlerSelection[]>([]);

  // State: mode + lane selection
  const [mode, setMode] = useState<Mode>("bowl-now");
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [lanesLoading, setLanesLoading] = useState(false);
  const [selectedLane, setSelectedLane] = useState<number | null>(null);

  // State: submission progress
  const [progress, setProgress] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; laneLabel?: string; neonId?: number; error?: string } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  // Headers for admin API calls
  const headers = {
    "Content-Type": "application/json",
    "x-admin-token": token,
  };

  // ── Search ─────────────────────────────────────────────────────────

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setPhase("searching");
    setError(null);
    setPasses([]);
    setSelectedPass(null);
    setBowlers([]);
    setResult(null);

    try {
      const res = await fetch("/api/admin/kbf/search", {
        method: "POST",
        headers,
        body: JSON.stringify({ query: query.trim() }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Search failed");
        setPhase("error");
        return;
      }

      const found: KbfPass[] = data.passes ?? [];
      const redeemed: RedeemedPair[] = data.redeemedToday ?? [];
      setPasses(found);
      setRedeemedToday(redeemed);

      if (found.length === 0) {
        setError("No accounts found");
        setPhase("idle");
        return;
      }

      // Auto-select first pass (or the one matching current center)
      const match = found.find((p) => centerCodeForName(p.centerName) === centerCode) || found[0];
      selectPass(match, redeemed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setPhase("error");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, centerCode, token]);

  function selectPass(pass: KbfPass, redeemed: RedeemedPair[]) {
    setSelectedPass(pass);
    // Auto-switch center to match the pass
    const passCenter = centerCodeForName(pass.centerName);
    setCenterCode(passCenter);

    // Build bowler selections from members
    const selections: AdminBowlerSelection[] = [];

    // Add account holder as "parent"
    selections.push({
      key: `parent:${pass.id}:0`,
      name: `${pass.firstName} ${pass.lastName}`.trim() || "Account Holder",
      relation: "parent",
      selected: false, // Adults off by default
      shoeSize: null,
      wantBumpers: false,
      kbfPassId: pass.id,
      kbfMemberSlot: 0,
      redeemedToday: false,
    });

    // Add members
    for (const m of pass.members) {
      const isRedeemed = redeemed.some(
        (r) => r.passId === m.passId && r.slot === m.slot,
      );
      selections.push({
        key: `${m.relation}:${m.passId}:${m.slot}`,
        name: `${m.firstName} ${m.lastName}`.trim() || "Unnamed",
        relation: m.relation === "kid" ? "kid" : "family",
        selected: m.relation === "kid" && !isRedeemed, // Auto-select kids not already redeemed
        shoeSize: m.prefs?.shoeSize ?? null,
        wantBumpers: m.prefs?.wantBumpers ?? false,
        kbfPassId: m.passId,
        kbfMemberSlot: m.slot,
        redeemedToday: isRedeemed,
      });
    }

    setBowlers(selections);
    setPhase("ready");
    // Load lanes when Bowl Now is the mode
    loadLanes(passCenter);
  }

  // ── Lanes ──────────────────────────────────────────────────────────

  async function loadLanes(code?: string) {
    const cc = code || centerCode;
    const centerId = CENTER_CODE_TO_QAMF[cc];
    if (!centerId) return;
    setLanesLoading(true);
    try {
      const res = await fetch(
        `/api/admin/kbf/lanes?centerId=${centerId}`,
        { headers },
      );
      const data = await res.json();
      setLanes(data.lanes ?? []);
      setSelectedLane(null); // LanePicker auto-selects first closed
    } catch {
      setLanes([]);
    } finally {
      setLanesLoading(false);
    }
  }

  // Refresh lanes periodically when in bowl-now mode
  useEffect(() => {
    if (phase !== "ready" || mode !== "bowl-now") return;
    const iv = setInterval(() => loadLanes(), 15000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, mode, centerCode]);

  // ── Submit: Bowl Now ───────────────────────────────────────────────

  async function handleBowlNow() {
    if (!selectedPass || !selectedLane) return;
    const selected = bowlers.filter((b) => b.selected);
    if (selected.length === 0) return;
    if (!selected.some((b) => b.relation === "kid")) {
      setError("At least one kid must be selected");
      return;
    }

    setPhase("submitting");
    setError(null);
    setProgress(["Creating reservation..."]);
    setResult(null);

    try {
      const res = await fetch("/api/admin/kbf/bowl-now", {
        method: "POST",
        headers,
        body: JSON.stringify({
          centerCode,
          passId: selectedPass.id,
          laneNumber: selectedLane,
          bowlers: selected.map((b) => ({
            name: b.name,
            kbfPassId: b.kbfPassId,
            kbfMemberSlot: b.kbfMemberSlot,
            kbfRelation: b.relation === "kid" ? "kid" : b.relation === "family" ? "family" : undefined,
            shoeSize: b.shoeSize,
            bumpers: b.wantBumpers,
          })),
          guestName: `${selectedPass.firstName} ${selectedPass.lastName}`.trim(),
          guestEmail: selectedPass.email,
          guestPhone: selectedPass.phone,
        }),
      });

      const data = await res.json();
      if (data.ok) {
        setProgress((prev) => [...prev, "Lane opened!", "Shoes sent to KDS!", `${data.laneLabel} is live!`]);
        setResult({ ok: true, laneLabel: data.laneLabel, neonId: data.neonId });
        setPhase("done");
      } else {
        setProgress((prev) => [...prev, `Failed: ${data.error}`]);
        setResult({ ok: false, error: data.error });
        setPhase("error");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Request failed";
      setProgress((prev) => [...prev, `Error: ${msg}`]);
      setResult({ ok: false, error: msg });
      setPhase("error");
    }
  }

  // ── Submit: Book Lane ──────────────────────────────────────────────
  // TODO: Phase 2 — date picker + time slot selection
  // For now, just show a placeholder

  // ── Reset ──────────────────────────────────────────────────────────

  function handleReset() {
    setPhase("idle");
    setQuery("");
    setPasses([]);
    setSelectedPass(null);
    setBowlers([]);
    setLanes([]);
    setSelectedLane(null);
    setProgress([]);
    setResult(null);
    setError(null);
    searchRef.current?.focus();
  }

  // ── Render ─────────────────────────────────────────────────────────

  const selectedCount = bowlers.filter((b) => b.selected).length;
  const hasKid = bowlers.some((b) => b.selected && b.relation === "kid");
  const canSubmit =
    selectedCount > 0 &&
    hasKid &&
    (mode === "bowl-now" ? selectedLane !== null : false); // book-lane disabled for now

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "20px 16px", fontFamily: "Arial, sans-serif" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#1a1a1a" }}>
          KBF Admin
        </h1>
        <CenterPicker value={centerCode} onChange={setCenterCode} />
      </div>

      {/* Search */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          ref={searchRef}
          type="text"
          placeholder="Phone or email..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doSearch()}
          disabled={phase === "searching" || phase === "submitting"}
          style={{
            flex: 1,
            padding: "10px 14px",
            fontSize: 14,
            border: "1px solid #d1d5db",
            borderRadius: 8,
            outline: "none",
          }}
        />
        <button
          onClick={doSearch}
          disabled={phase === "searching" || phase === "submitting" || !query.trim()}
          style={{
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 600,
            backgroundColor: "#004AAD",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: phase === "searching" ? "wait" : "pointer",
            opacity: !query.trim() ? 0.5 : 1,
          }}
        >
          {phase === "searching" ? "..." : "Search"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: "10px 14px",
          marginBottom: 16,
          backgroundColor: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: 8,
          color: "#991b1b",
          fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* Account info */}
      {selectedPass && (
        <div style={{
          padding: "12px 16px",
          marginBottom: 16,
          backgroundColor: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: 700, fontSize: 15, color: "#1a1a1a" }}>
              {selectedPass.firstName} {selectedPass.lastName}
            </span>
            {selectedPass.fpass && (
              <span style={{
                padding: "2px 8px",
                fontSize: 11,
                fontWeight: 700,
                backgroundColor: "#dbeafe",
                color: "#1d4ed8",
                borderRadius: 999,
              }}>
                Family Pass
              </span>
            )}
            <span style={{
              padding: "2px 8px",
              fontSize: 11,
              fontWeight: 600,
              backgroundColor: "#f0fdf4",
              color: "#166534",
              borderRadius: 999,
            }}>
              {selectedPass.centerName.replace("HeadPinz ", "")}
            </span>
          </div>
          <div style={{ fontSize: 13, color: "#6b7280" }}>
            {selectedPass.email}
            {selectedPass.phone && <> &middot; {selectedPass.phone}</>}
            {" "}&middot; {selectedPass.members.length} member{selectedPass.members.length !== 1 ? "s" : ""}
          </div>
          {/* If multiple passes found, show switcher */}
          {passes.length > 1 && (
            <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
              {passes.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectPass(p, redeemedToday)}
                  style={{
                    padding: "4px 10px",
                    fontSize: 12,
                    fontWeight: p.id === selectedPass.id ? 700 : 400,
                    backgroundColor: p.id === selectedPass.id ? "#004AAD" : "#fff",
                    color: p.id === selectedPass.id ? "#fff" : "#374151",
                    border: "1px solid #d1d5db",
                    borderRadius: 6,
                    cursor: "pointer",
                  }}
                >
                  {p.centerName.replace("HeadPinz ", "")} {p.fpass ? "(FBF)" : "(KBF)"}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Bowler selection */}
      {selectedPass && bowlers.length > 0 && (phase === "ready" || phase === "error" || phase === "submitting") && (
        <>
          <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 }}>
            Bowlers ({selectedCount} selected)
          </div>
          <AdminBowlerList bowlers={bowlers} onChange={setBowlers} />

          {/* Mode toggle */}
          <div style={{ display: "flex", gap: 8, margin: "16px 0 12px" }}>
            {(["bowl-now", "book-lane"] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  if (m === "bowl-now") loadLanes();
                }}
                style={{
                  flex: 1,
                  padding: "10px 0",
                  fontSize: 13,
                  fontWeight: 600,
                  backgroundColor: mode === m ? "#004AAD" : "#fff",
                  color: mode === m ? "#fff" : "#374151",
                  border: `1px solid ${mode === m ? "#004AAD" : "#d1d5db"}`,
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                {m === "bowl-now" ? "Bowl Now" : "Book Lane"}
              </button>
            ))}
          </div>

          {/* Bowl Now: Lane picker */}
          {mode === "bowl-now" && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 }}>
                Select Lane
              </div>
              <LanePicker
                lanes={lanes}
                selected={selectedLane}
                onChange={setSelectedLane}
                loading={lanesLoading}
              />
              <button
                onClick={() => loadLanes()}
                style={{
                  marginTop: 8,
                  padding: "4px 12px",
                  fontSize: 11,
                  color: "#6b7280",
                  backgroundColor: "transparent",
                  border: "1px solid #e5e7eb",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Refresh lanes
              </button>
            </div>
          )}

          {/* Book Lane: placeholder */}
          {mode === "book-lane" && (
            <div style={{
              padding: 20,
              textAlign: "center",
              color: "#9ca3af",
              fontSize: 13,
              border: "1px dashed #d1d5db",
              borderRadius: 8,
              marginBottom: 16,
            }}>
              Date &amp; time picker coming soon. Use Bowl Now for walk-ins.
            </div>
          )}

          {/* Confirm button */}
          {mode === "bowl-now" && (
            <button
              onClick={handleBowlNow}
              disabled={!canSubmit || phase === "submitting"}
              style={{
                width: "100%",
                padding: "14px 0",
                fontSize: 15,
                fontWeight: 700,
                backgroundColor: canSubmit ? "#22c55e" : "#d1d5db",
                color: canSubmit ? "#fff" : "#9ca3af",
                border: "none",
                borderRadius: 10,
                cursor: canSubmit ? "pointer" : "not-allowed",
                letterSpacing: 0.5,
              }}
            >
              {phase === "submitting"
                ? "Opening lane..."
                : selectedLane
                  ? `Open Lane ${selectedLane} & Send to KDS`
                  : "Select a lane"}
            </button>
          )}

          {!hasKid && selectedCount > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#dc2626" }}>
              At least one kid must be selected for KBF.
            </div>
          )}
        </>
      )}

      {/* Progress / result */}
      {(phase === "submitting" || phase === "done" || (phase === "error" && progress.length > 0)) && (
        <div style={{
          marginTop: 16,
          padding: "14px 16px",
          backgroundColor: phase === "done" ? "#f0fdf4" : phase === "error" ? "#fef2f2" : "#f9fafb",
          border: `1px solid ${phase === "done" ? "#bbf7d0" : phase === "error" ? "#fecaca" : "#e5e7eb"}`,
          borderRadius: 8,
        }}>
          {progress.map((msg, i) => (
            <div key={i} style={{
              fontSize: 13,
              color: i === progress.length - 1 && phase === "done" ? "#166534" : "#374151",
              fontWeight: i === progress.length - 1 ? 700 : 400,
              marginBottom: i < progress.length - 1 ? 4 : 0,
            }}>
              {i < progress.length - 1 ? "✓ " : phase === "submitting" ? "⏳ " : phase === "done" ? "✓ " : "✗ "}
              {msg}
            </div>
          ))}
        </div>
      )}

      {/* Done: reset */}
      {phase === "done" && (
        <button
          onClick={handleReset}
          style={{
            marginTop: 12,
            width: "100%",
            padding: "12px 0",
            fontSize: 14,
            fontWeight: 600,
            backgroundColor: "#fff",
            color: "#004AAD",
            border: "1px solid #004AAD",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          New Lookup
        </button>
      )}
    </div>
  );
}
