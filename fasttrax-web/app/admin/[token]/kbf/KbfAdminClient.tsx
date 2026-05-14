"use client";

import { useState, useCallback, useRef } from "react";
import CenterPicker, { CENTERS } from "@/components/admin/bowling/CenterPicker";
import AdminBowlerList from "@/components/admin/bowling/AdminBowlerList";
import type { AdminBowlerSelection } from "@/components/admin/bowling/BowlerEditor";
import { isKbfBookableDate } from "@/lib/kbf-schedule";

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
type Phase = "idle" | "searching" | "ready" | "hold" | "submitting" | "done" | "error";

// ── Helpers ────────────────────────────────────────────────────────────

const CENTER_CODE_TO_QAMF: Record<string, number> = {
  TXBSQN0FEKQ11: 9172,
  PPTR5G2N0QXF7: 3148,
};

function centerCodeForName(name: string): string {
  if (name.includes("Naples")) return "PPTR5G2N0QXF7";
  return "TXBSQN0FEKQ11";
}

const BLUE = "#004AAD";

/** "3 PM", "11 AM" */
function formatHour(h: number): string {
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12} ${ampm}`;
}

/** "3:30 PM" */
function formatHourMinute(h: number, m: number): string {
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function todayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Build calendar grid cells — null for empty leading/trailing slots. */
function buildCalCells(year: number, month: number): (number | null)[] {
  const firstDow = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
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
  const [futureReservations, setFutureReservations] = useState<{ passId: number; bookedAt: string }[]>([]);

  // State: bowlers
  const [bowlers, setBowlers] = useState<AdminBowlerSelection[]>([]);

  // State: step (1 = bowlers, 2 = book-lane calendar)
  const [step, setStep] = useState<1 | 2>(1);

  // State: mode
  const [mode, setMode] = useState<Mode>("bowl-now");

  // State: hold (temp QAMF reservation)
  const [holdQamfId, setHoldQamfId] = useState<string | null>(null);
  const [holdLaneNumber, setHoldLaneNumber] = useState<number | null>(null);
  const [holdLoading, setHoldLoading] = useState(false);

  // State: book-lane calendar
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth());
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [selectedMinute, setSelectedMinute] = useState<number | null>(null);

  // State: book-lane availability (fetched from QAMF)
  const [availableSlots, setAvailableSlots] = useState<{ hour: number; minute: number }[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const fetchDateRef = useRef("");

  // State: phone collection (when account has no phone)
  const [enteredPhone, setEnteredPhone] = useState("");

  // State: submission progress
  const [progress, setProgress] = useState<string[]>([]);
  const [result, setResult] = useState<{ ok: boolean; laneLabel?: string; neonId?: number; error?: string } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  // Headers for admin API calls
  const headers = {
    "Content-Type": "application/json",
    "x-admin-token": token,
  };

  // ── Cancel any active hold ────────────────────────────────────────

  async function cancelHold() {
    if (!holdQamfId) return;
    const qid = holdQamfId;
    setHoldQamfId(null);
    setHoldLaneNumber(null);
    try {
      await fetch("/api/admin/kbf/hold", {
        method: "DELETE",
        headers,
        body: JSON.stringify({ centerCode, qamfId: qid }),
      });
    } catch {
      // Best-effort — temp reservations auto-expire
    }
  }

  // ── Search ─────────────────────────────────────────────────────────

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setPhase("searching");
    setError(null);
    setPasses([]);
    setSelectedPass(null);
    setBowlers([]);
    setResult(null);
    setHoldQamfId(null);
    setHoldLaneNumber(null);

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
      const futureRez: { passId: number; bookedAt: string }[] = data.futureReservations ?? [];
      setPasses(found);
      setRedeemedToday(redeemed);
      setFutureReservations(futureRez);

      if (found.length === 0) {
        setError("No accounts found");
        setPhase("idle");
        return;
      }

      // Show results list — user picks the right account
      setPhase("idle");
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

    for (const m of pass.members) {
      // Skip family members on non-fpass accounts
      if (m.relation === "family" && !pass.fpass) continue;

      const isRedeemed = redeemed.some(
        (r) => r.passId === m.passId && r.slot === m.slot,
      );
      selections.push({
        key: `${m.relation}:${m.passId}:${m.slot}`,
        name: `${m.firstName} ${m.lastName}`.trim() || "Unnamed",
        relation: m.relation === "kid" ? "kid" : "family",
        selected: m.relation === "kid" ? !isRedeemed : false,
        shoeSize: m.prefs?.shoeSize ?? null,
        wantBumpers: m.prefs?.wantBumpers ?? false,
        kbfPassId: m.passId,
        kbfMemberSlot: m.slot,
        redeemedToday: isRedeemed,
      });
    }

    setBowlers(selections);
    setStep(1);
    setPhase("ready");
  }

  // ── Book Lane: fetch real QAMF availability for a date ────────────

  async function fetchAvailability(date: string) {
    fetchDateRef.current = date;
    const centerId = CENTER_CODE_TO_QAMF[centerCode];
    if (!centerId) return;
    const playerCount = bowlers.filter((b) => b.selected).length || 1;
    setSlotsLoading(true);
    setAvailableSlots([]);
    try {
      const res = await fetch(
        `/api/bowling/v2/availability?centerId=${centerId}&players=${playerCount}&startDate=${date}&kind=kbf`,
      );
      const data = await res.json();
      if (fetchDateRef.current !== date) return;
      const slots: { hour: number; minute: number }[] = [];
      for (const a of (data.Availabilities ?? []) as { BookedAt: string }[]) {
        const d = new Date(a.BookedAt);
        const etStr = d.toLocaleString("en-US", {
          timeZone: "America/New_York",
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        });
        const [hh, mm] = etStr.split(":").map(Number);
        slots.push({ hour: hh, minute: mm });
      }
      setAvailableSlots(slots);
    } catch {
      if (fetchDateRef.current === date) setAvailableSlots([]);
    } finally {
      if (fetchDateRef.current === date) setSlotsLoading(false);
    }
  }

  // ── Hold: create temp QAMF reservation ────────────────────────────

  async function createHold(holdMode: "bowl-now" | "book-lane", bookedAt?: string) {
    if (!selectedPass) return;
    const selected = bowlers.filter((b) => b.selected);
    if (selected.length === 0) return;

    // Cancel any previous hold first
    await cancelHold();

    setHoldLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/admin/kbf/hold", {
        method: "POST",
        headers,
        body: JSON.stringify({
          centerCode,
          mode: holdMode,
          ...(bookedAt ? { bookedAt } : {}),
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
          guestPhone: selectedPass.phone || enteredPhone || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Failed to hold slot");
        setHoldLoading(false);
        return null;
      }

      setHoldQamfId(data.qamfId);
      setHoldLaneNumber(data.laneNumber ?? null);
      setHoldLoading(false);
      setPhase("hold");
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to hold slot");
      setHoldLoading(false);
      return null;
    }
  }

  // ── Bowl Now: hold → show lane → confirm ──────────────────────────

  async function handleBowlNowHold() {
    if (!selectedPass) return;
    const selected = bowlers.filter((b) => b.selected);
    if (selected.length === 0) return;
    if (!selected.some((b) => b.relation === "kid")) {
      setError("At least one kid must be selected");
      return;
    }

    setMode("bowl-now");
    const hold = await createHold("bowl-now");
    if (!hold) return;
    // Phase is now "hold" — UI shows assigned lane + confirm button
  }

  async function handleBowlNowConfirm() {
    if (!selectedPass || !holdQamfId || !holdLaneNumber) return;
    const selected = bowlers.filter((b) => b.selected);

    setPhase("submitting");
    setError(null);
    setProgress(["Confirming reservation..."]);
    setResult(null);

    try {
      const res = await fetch("/api/admin/kbf/bowl-now", {
        method: "POST",
        headers,
        body: JSON.stringify({
          centerCode,
          qamfId: holdQamfId,
          laneNumber: holdLaneNumber,
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
          guestPhone: selectedPass.phone || enteredPhone || undefined,
          ...(enteredPhone && !selectedPass.phone ? { linkPhone: enteredPhone } : {}),
        }),
      });

      const data = await res.json();
      if (data.ok) {
        setProgress((prev) => [...prev, `Lane ${holdLaneNumber} confirmed`, "Lane opened!", "Shoes sent to KDS!", `Lane ${holdLaneNumber} is live!`]);
        setResult({ ok: true, laneLabel: data.laneLabel, neonId: data.neonId });
        setHoldQamfId(null); // Hold is consumed
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

  // ── Book Lane: minute selected → hold, then confirm ───────────────

  async function handleMinuteSelected(minute: number) {
    setSelectedMinute(minute);

    if (selectedHour === null || !selectedDate) return;
    const hh = String(selectedHour).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");
    const bookedAt = new Date(`${selectedDate}T${hh}:${mm}:00`).toISOString();

    setMode("book-lane");
    await createHold("book-lane", bookedAt);
  }

  async function handleBookLaneConfirm() {
    if (!selectedPass || !holdQamfId || !selectedDate || selectedHour === null || selectedMinute === null) return;
    const selected = bowlers.filter((b) => b.selected);
    if (selected.length === 0) return;

    const hh = String(selectedHour).padStart(2, "0");
    const mm = String(selectedMinute).padStart(2, "0");
    const bookedAt = new Date(`${selectedDate}T${hh}:${mm}:00`).toISOString();

    setPhase("submitting");
    setError(null);
    setProgress(["Confirming reservation..."]);
    setResult(null);

    try {
      const res = await fetch("/api/admin/kbf/book-lane", {
        method: "POST",
        headers,
        body: JSON.stringify({
          centerCode,
          qamfId: holdQamfId,
          bookedAt,
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
          guestPhone: selectedPass.phone || enteredPhone || undefined,
          ...(enteredPhone && !selectedPass.phone ? { linkPhone: enteredPhone } : {}),
        }),
      });

      const data = await res.json();
      if (data.ok) {
        setProgress((prev) => [...prev, `Booked for ${selectedDate} at ${formatHourMinute(selectedHour!, selectedMinute!)}!`]);
        setResult({ ok: true, neonId: data.neonId });
        setHoldQamfId(null); // Hold is consumed
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

  // ── Reset ──────────────────────────────────────────────────────────

  function handleReset() {
    cancelHold();
    setPhase("idle");
    setStep(1);
    setMode("bowl-now");
    setQuery("");
    setPasses([]);
    setSelectedPass(null);
    setFutureReservations([]);
    setBowlers([]);
    setSelectedDate("");
    setSelectedHour(null);
    setSelectedMinute(null);
    setAvailableSlots([]);
    setSlotsLoading(false);
    setEnteredPhone("");
    setProgress([]);
    setResult(null);
    setError(null);
    setHoldQamfId(null);
    setHoldLaneNumber(null);
    searchRef.current?.focus();
  }

  // ── Render ─────────────────────────────────────────────────────────

  const selectedCount = bowlers.filter((b) => b.selected).length;
  const hasKid = bowlers.some((b) => b.selected && b.relation === "kid");
  const canAdvance = selectedCount > 0 && hasKid;

  // Future reservation check — blocks Book Lane
  const passFutureRez = selectedPass
    ? futureReservations.find((fr) => fr.passId === selectedPass.id)
    : undefined;

  // Calendar data
  const calCells = buildCalCells(calYear, calMonth);
  const calToday = todayYmd();
  const availableHours = [...new Set(availableSlots.map((s) => s.hour))].sort((a, b) => a - b);
  const availableMinutes = selectedHour !== null
    ? [...new Set(availableSlots.filter((s) => s.hour === selectedHour).map((s) => s.minute))].sort((a, b) => a - b)
    : [];

  const isHolding = phase === "hold" && mode === "book-lane" && holdQamfId;
  const canConfirmBookLane = isHolding && selectedDate && selectedHour !== null && selectedMinute !== null;
  const bookLaneBusy = phase === "submitting" && mode === "book-lane";

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 20px", fontFamily: "Arial, sans-serif" }}>
      {/* ── Header row: title + search + center picker ──────────── */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginBottom: 16,
        flexWrap: "wrap",
      }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", flexShrink: 0 }}>
          KBF Admin
        </h1>
        <div style={{ display: "flex", flex: 1, gap: 8, minWidth: 200 }}>
          <input
            ref={searchRef}
            type="text"
            placeholder="Name, email, or phone..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch()}
            disabled={phase === "searching" || phase === "submitting"}
            style={{
              flex: 1,
              padding: "8px 12px",
              fontSize: 14,
              border: "1px solid #d1d5db",
              borderRadius: 8,
              outline: "none",
              minWidth: 0,
            }}
          />
          <button
            onClick={doSearch}
            disabled={phase === "searching" || phase === "submitting" || !query.trim()}
            style={{
              padding: "8px 16px",
              fontSize: 14,
              fontWeight: 600,
              backgroundColor: BLUE,
              color: "#fff",
              border: "none",
              borderRadius: 8,
              cursor: phase === "searching" ? "wait" : "pointer",
              opacity: !query.trim() ? 0.5 : 1,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {phase === "searching" ? "..." : "Search"}
          </button>
        </div>
        <div style={{ flexShrink: 0 }}>
          <CenterPicker value={centerCode} onChange={setCenterCode} />
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: "10px 14px",
          marginBottom: 12,
          backgroundColor: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: 8,
          color: "#991b1b",
          fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* Search results list — pick an account */}
      {passes.length > 0 && !selectedPass && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 }}>
            {passes.length} result{passes.length !== 1 ? "s" : ""}
          </div>
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
            {passes.map((p) => {
              const kids = p.members.filter((m) => m.relation === "kid");
              return (
                <button
                  key={p.id}
                  onClick={() => selectPass(p, redeemedToday)}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "10px 14px",
                    textAlign: "left",
                    backgroundColor: "#fff",
                    border: "none",
                    borderBottom: "1px solid #e5e7eb",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: "#1a1a1a" }}>
                      {p.firstName} {p.lastName}
                    </span>
                    <span style={{
                      padding: "1px 6px",
                      fontSize: 10,
                      fontWeight: 700,
                      backgroundColor: p.fpass ? "#dbeafe" : "#f0fdf4",
                      color: p.fpass ? "#1d4ed8" : "#166534",
                      borderRadius: 999,
                    }}>
                      {p.centerName.replace("HeadPinz ", "")} {p.fpass ? "FBF" : "KBF"}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>
                    {p.email}
                    {p.phone && <> &middot; {p.phone}</>}
                    {" "}&middot; {kids.length} kid{kids.length !== 1 ? "s" : ""}
                    {kids.length > 0 && (
                      <span style={{ color: "#9ca3af" }}>
                        {" "}({kids.map((k) => k.firstName).join(", ")})
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Selected account header */}
      {selectedPass && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 14px",
          marginBottom: 12,
          backgroundColor: "#f9fafb",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: "#1a1a1a" }}>
                {selectedPass.firstName} {selectedPass.lastName}
              </span>
              <span style={{
                padding: "1px 6px",
                fontSize: 10,
                fontWeight: 700,
                backgroundColor: selectedPass.fpass ? "#dbeafe" : "#f0fdf4",
                color: selectedPass.fpass ? "#1d4ed8" : "#166534",
                borderRadius: 999,
              }}>
                {selectedPass.centerName.replace("HeadPinz ", "")} {selectedPass.fpass ? "FBF" : "KBF"}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              {selectedPass.email}
              {selectedPass.phone && <> &middot; {selectedPass.phone}</>}
            </div>
          </div>
          <button
            onClick={() => {
              cancelHold();
              setSelectedPass(null);
              setBowlers([]);
              setPhase("idle");
              setStep(1);
              setMode("bowl-now");
            }}
            style={{
              padding: "4px 10px",
              fontSize: 12,
              fontWeight: 600,
              backgroundColor: "#fff",
              color: "#6b7280",
              border: "1px solid #d1d5db",
              borderRadius: 6,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            Change
          </button>
        </div>
      )}

      {/* ── STEP 1: Bowlers + action buttons ──────────────────────── */}
      {step === 1 && selectedPass && bowlers.length > 0 && (phase === "ready" || phase === "error" || phase === "hold" || phase === "submitting") && (
        <>
          {/* Phone collection */}
          {!selectedPass.phone && (
            <div style={{
              padding: "8px 14px",
              marginBottom: 12,
              backgroundColor: "#fffbeb",
              border: "1px solid #fde68a",
              borderRadius: 8,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#92400e", marginBottom: 6 }}>
                No phone on file — add one so they can book online via text
              </div>
              <input
                type="tel"
                placeholder="(239) 555-1234"
                value={enteredPhone}
                onChange={(e) => setEnteredPhone(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 12px",
                  fontSize: 14,
                  border: "1px solid #d1d5db",
                  borderRadius: 6,
                  outline: "none",
                  boxSizing: "border-box",
                  backgroundColor: "#fff",
                  color: "#1a1a1a",
                }}
              />
            </div>
          )}

          <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 }}>
            Bowlers ({selectedCount} selected)
          </div>
          <AdminBowlerList bowlers={bowlers} onChange={setBowlers} />

          {!hasKid && selectedCount > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#dc2626" }}>
              At least one kid must be selected for KBF.
            </div>
          )}

          {/* Future reservation warning */}
          {passFutureRez && (
            <div style={{
              padding: "10px 14px",
              marginTop: 10,
              backgroundColor: "#fef3c7",
              border: "1px solid #fde68a",
              borderRadius: 8,
              fontSize: 13,
              color: "#92400e",
            }}>
              Already has a reservation for{" "}
              {new Date(passFutureRez.bookedAt).toLocaleString("en-US", {
                timeZone: "America/New_York",
                month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
              })}
              {" "}— Book Lane disabled
            </div>
          )}

          {/* Bowl Now hold state — show assigned lane + confirm */}
          {phase === "hold" && mode === "bowl-now" && holdQamfId && holdLaneNumber && (
            <div style={{
              marginTop: 12,
              padding: "16px 20px",
              backgroundColor: "#f0fdf4",
              border: "2px solid #22c55e",
              borderRadius: 10,
              textAlign: "center",
            }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: "#166534", marginBottom: 4 }}>
                Lane {holdLaneNumber} assigned
              </div>
              <div style={{ fontSize: 13, color: "#15803d", marginBottom: 12 }}>
                Temp hold active — confirm to open the lane
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                <button
                  onClick={() => { cancelHold(); setPhase("ready"); }}
                  style={{
                    padding: "10px 24px",
                    fontSize: 14,
                    fontWeight: 600,
                    backgroundColor: "#fff",
                    color: "#6b7280",
                    border: "1px solid #d1d5db",
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleBowlNowConfirm}
                  style={{
                    padding: "10px 32px",
                    fontSize: 15,
                    fontWeight: 700,
                    backgroundColor: "#22c55e",
                    color: "#fff",
                    border: "none",
                    borderRadius: 8,
                    cursor: "pointer",
                  }}
                >
                  Open Lane {holdLaneNumber}
                </button>
              </div>
            </div>
          )}

          {/* Action buttons (only when no hold active) */}
          {(phase === "ready" || phase === "error") && (
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button
                onClick={handleBowlNowHold}
                disabled={!canAdvance || holdLoading}
                style={{
                  flex: 1,
                  padding: "14px 0",
                  fontSize: 14,
                  fontWeight: 700,
                  backgroundColor: canAdvance ? "#22c55e" : "#d1d5db",
                  color: canAdvance ? "#fff" : "#9ca3af",
                  border: "none",
                  borderRadius: 10,
                  cursor: canAdvance && !holdLoading ? "pointer" : "not-allowed",
                }}
              >
                {holdLoading && mode === "bowl-now" ? "Getting lane..." : "🎳 Bowl Now"}
              </button>
              <button
                onClick={() => {
                  setMode("book-lane");
                  setStep(2);
                }}
                disabled={!canAdvance || !!passFutureRez}
                style={{
                  flex: 1,
                  padding: "14px 0",
                  fontSize: 14,
                  fontWeight: 700,
                  backgroundColor: canAdvance && !passFutureRez ? BLUE : "#d1d5db",
                  color: canAdvance && !passFutureRez ? "#fff" : "#9ca3af",
                  border: "none",
                  borderRadius: 10,
                  cursor: canAdvance && !passFutureRez ? "pointer" : "not-allowed",
                }}
              >
                Book Lane →
              </button>
            </div>
          )}
        </>
      )}

      {/* ── STEP 2: Book Lane calendar ────────────────────────────── */}
      {step === 2 && mode === "book-lane" && (phase === "ready" || phase === "error" || phase === "hold" || phase === "submitting") && (
        <>
          {/* Back + summary bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <button
              onClick={() => {
                cancelHold();
                setStep(1);
                setPhase("ready");
                setMode("bowl-now");
                setSelectedDate("");
                setSelectedHour(null);
                setSelectedMinute(null);
              }}
              disabled={phase === "submitting"}
              style={{
                padding: "6px 12px",
                fontSize: 13,
                fontWeight: 600,
                backgroundColor: "transparent",
                color: "#9ca3af",
                border: "1px solid #6b7280",
                borderRadius: 6,
                cursor: phase === "submitting" ? "not-allowed" : "pointer",
                flexShrink: 0,
              }}
            >
              ← Back
            </button>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>
              Book Lane
            </span>
            <span style={{ fontSize: 13, color: "#9ca3af" }}>
              {selectedCount} bowler{selectedCount !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Book Lane: two-column layout — calendar left, times right */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 12 }}>
            {/* Left column: calendar */}
            <div>
              {/* Month navigation */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <button
                  onClick={() => {
                    if (calMonth === 0) { setCalMonth(11); setCalYear((y) => y - 1); }
                    else setCalMonth((m) => m - 1);
                  }}
                  style={{
                    width: 32, height: 32, fontSize: 18, fontWeight: 700,
                    backgroundColor: "transparent", color: "#fff",
                    border: "1px solid #6b7280", borderRadius: 6,
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  ‹
                </button>
                <span style={{ fontWeight: 700, fontSize: 15, color: "#fff" }}>
                  {new Date(calYear, calMonth).toLocaleString("default", { month: "long", year: "numeric" })}
                </span>
                <button
                  onClick={() => {
                    if (calMonth === 11) { setCalMonth(0); setCalYear((y) => y + 1); }
                    else setCalMonth((m) => m + 1);
                  }}
                  style={{
                    width: 32, height: 32, fontSize: 18, fontWeight: 700,
                    backgroundColor: "transparent", color: "#fff",
                    border: "1px solid #6b7280", borderRadius: 6,
                    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  ›
                </button>
              </div>

              {/* Day-of-week headers */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", textAlign: "center", marginBottom: 2 }}>
                {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                  <div key={i} style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", padding: "4px 0" }}>{d}</div>
                ))}
              </div>

              {/* Calendar grid */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
                {calCells.map((day, i) => {
                  if (day == null) return <div key={i} />;
                  const ymd = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                  const bookable = isKbfBookableDate(ymd);
                  const isPast = ymd < calToday;
                  const isSelected = ymd === selectedDate;
                  const isTodayCell = ymd === calToday;

                  return (
                    <button
                      key={i}
                      onClick={() => {
                        if (!bookable || isPast) return;
                        // Cancel hold when changing date
                        cancelHold();
                        setSelectedDate(ymd);
                        setSelectedHour(null);
                        setSelectedMinute(null);
                        setPhase("ready");
                        fetchAvailability(ymd);
                      }}
                      disabled={!bookable || isPast}
                      style={{
                        padding: "8px 0",
                        fontSize: 13,
                        fontWeight: isSelected ? 700 : isTodayCell ? 600 : 400,
                        backgroundColor: isSelected ? BLUE : "transparent",
                        color: isSelected ? "#fff" : !bookable || isPast ? "#6b728050" : "#fff",
                        border: isTodayCell && !isSelected ? `1px solid ${BLUE}` : "1px solid transparent",
                        borderRadius: 6,
                        cursor: bookable && !isPast ? "pointer" : "default",
                      }}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right column: time selection */}
            <div>
              {!selectedDate && (
                <div style={{ fontSize: 14, color: "#6b7280", paddingTop: 40, textAlign: "center" }}>
                  Select a date to see available times
                </div>
              )}

              {selectedDate && slotsLoading && (
                <div style={{ fontSize: 13, color: "#9ca3af", paddingTop: 8 }}>
                  Loading available times…
                </div>
              )}

              {selectedDate && !slotsLoading && availableHours.length === 0 && (
                <div style={{ fontSize: 13, color: "#f87171", paddingTop: 8 }}>
                  No available start times for this date.
                </div>
              )}

              {/* Hour chips */}
              {selectedDate && !slotsLoading && availableHours.length > 0 && (
                <div>
                  <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 }}>
                    Start Time
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {availableHours.map((h) => (
                      <button
                        key={h}
                        onClick={() => {
                          // Cancel hold when changing hour
                          cancelHold();
                          setSelectedHour(h);
                          setSelectedMinute(null);
                          setPhase("ready");
                        }}
                        style={{
                          minWidth: 60, padding: "8px 12px", fontSize: 13,
                          fontWeight: selectedHour === h ? 700 : 400,
                          backgroundColor: selectedHour === h ? BLUE : "#fff",
                          color: selectedHour === h ? "#fff" : "#374151",
                          border: `1px solid ${selectedHour === h ? BLUE : "#d1d5db"}`,
                          borderRadius: 8, cursor: "pointer",
                        }}
                      >
                        {formatHour(h)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Minute chips */}
              {selectedHour !== null && availableMinutes.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 1 }}>
                    Minutes
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {availableMinutes.map((m) => {
                      const isHeld = selectedMinute === m && holdQamfId;
                      return (
                        <button
                          key={m}
                          onClick={() => handleMinuteSelected(m)}
                          disabled={holdLoading}
                          style={{
                            minWidth: 52, padding: "8px 12px", fontSize: 13,
                            fontWeight: selectedMinute === m ? 700 : 400,
                            backgroundColor: isHeld ? "#22c55e" : selectedMinute === m ? BLUE : "#fff",
                            color: selectedMinute === m ? "#fff" : "#374151",
                            border: `1px solid ${isHeld ? "#22c55e" : selectedMinute === m ? BLUE : "#d1d5db"}`,
                            borderRadius: 8, cursor: holdLoading ? "wait" : "pointer",
                          }}
                        >
                          :{String(m).padStart(2, "0")}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Hold loading indicator */}
              {holdLoading && mode === "book-lane" && (
                <div style={{ marginTop: 12, fontSize: 12, color: "#9ca3af" }}>
                  Holding time slot…
                </div>
              )}

              {/* Hold active indicator */}
              {isHolding && (
                <div style={{
                  marginTop: 12,
                  padding: "8px 12px",
                  backgroundColor: "#f0fdf4",
                  border: "1px solid #bbf7d0",
                  borderRadius: 8,
                  fontSize: 12,
                  color: "#166534",
                  fontWeight: 600,
                }}>
                  ✓ Time slot held — 10 min expiry
                </div>
              )}
            </div>
          </div>

          {/* Confirm / submit button */}
          {(
            <button
              onClick={handleBookLaneConfirm}
              disabled={!canConfirmBookLane && !bookLaneBusy}
              style={{
                width: "100%",
                padding: "14px 0",
                fontSize: 15,
                fontWeight: 700,
                backgroundColor: canConfirmBookLane ? BLUE : "#d1d5db",
                color: canConfirmBookLane ? "#fff" : "#9ca3af",
                border: "none",
                borderRadius: 10,
                cursor: canConfirmBookLane ? "pointer" : "not-allowed",
                letterSpacing: 0.5,
              }}
            >
              {bookLaneBusy
                ? "Booking..."
                : canConfirmBookLane && selectedHour !== null && selectedMinute !== null
                  ? `Confirm: ${selectedDate} at ${formatHourMinute(selectedHour, selectedMinute)}`
                  : "Select date & time"}
            </button>
          )}
        </>
      )}

      {/* Progress / result */}
      {(phase === "submitting" || phase === "done" || (phase === "error" && progress.length > 0)) && (
        <div style={{
          marginTop: 12,
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

      {/* Bowl Now done: shoe charge warning */}
      {phase === "done" && mode === "bowl-now" && (
        <div
          style={{
            marginTop: 12,
            padding: "16px 20px",
            backgroundColor: "#dc2626",
            border: "3px solid #fca5a5",
            borderRadius: 10,
            textAlign: "center",
            animation: "shoeWarn 1s ease-in-out 3",
          }}
        >
          <style>{`@keyframes shoeWarn { 0%,100% { transform: scale(1); } 50% { transform: scale(1.03); box-shadow: 0 0 24px rgba(220,38,38,.6); } }`}</style>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#fff", marginBottom: 6 }}>
            👟 CHARGE FOR SHOES 👟
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#fee2e2", lineHeight: 1.4 }}>
            Return to Conqueror and ring up shoe rentals now.<br />
            KBF does NOT include shoes — they must be paid for.
          </div>
        </div>
      )}

      {/* Done: reset */}
      {phase === "done" && (
        <button
          onClick={handleReset}
          style={{
            marginTop: 10,
            width: "100%",
            padding: "12px 0",
            fontSize: 14,
            fontWeight: 600,
            backgroundColor: "#fff",
            color: BLUE,
            border: `1px solid ${BLUE}`,
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
