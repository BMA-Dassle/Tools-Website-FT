"use client";

/**
 * Manage Reservation — Notes tab: edit the reservation note; on save the
 * server re-syncs the QAMF memo (bowling/KBF) and appends to the BMI
 * project's private log (race/attraction) — the result line says exactly
 * which desks now see it.
 */
import { useState } from "react";
import type { ReservationDetail } from "~/features/reservations-admin/service";
import { Card } from "./ui";

export default function NotesTab({
  detail,
  token,
  onSaved,
}: {
  detail: ReservationDetail;
  token: string;
  onSaved: (msg: string) => void;
}) {
  const r = detail.reservation;
  const [text, setText] = useState(r.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{
    memoSynced: boolean;
    bmiMemoSynced: boolean;
  } | null>(null);

  const isBowling = r.productKind === "open" || r.productKind === "kbf";

  async function save() {
    setSaving(true);
    setError(null);
    setSyncResult(null);
    try {
      const res = await fetch(`/api/admin/reservations/notes?token=${encodeURIComponent(token)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ neonId: r.id, notes: text }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      setSyncResult({ memoSynced: !!data.memoSynced, bmiMemoSynced: !!data.bmiMemoSynced });
      onSaved("Notes saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Reservation notes">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={2000}
        placeholder="Notes the desk should see — party details, requests, follow-ups…"
        style={{
          width: "100%",
          minHeight: 120,
          backgroundColor: "var(--ba-input-bg)",
          border: "1px solid var(--ba-input-border)",
          borderRadius: 8,
          color: "var(--ba-fg)",
          padding: "0.6rem 0.75rem",
          fontSize: "0.82rem",
          fontFamily: "inherit",
          resize: "vertical",
        }}
      />
      {error && (
        <div style={{ marginTop: 6, fontSize: "0.75rem", color: "#ef4444", fontWeight: 600 }}>
          {error}
        </div>
      )}
      {syncResult && (
        <div
          style={{ marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap", fontSize: "0.75rem" }}
        >
          <span style={{ color: syncResult.memoSynced ? "#22c55e" : "var(--ba-muted)" }}>
            {syncResult.memoSynced
              ? "✓ Conqueror memo re-synced"
              : isBowling
                ? "Conqueror memo not updated"
                : "Conqueror: n/a"}
          </span>
          <span style={{ color: syncResult.bmiMemoSynced ? "#22c55e" : "var(--ba-muted)" }}>
            {syncResult.bmiMemoSynced
              ? "✓ Added to BMI project notes"
              : r.bmiBillId
                ? "BMI project notes not updated"
                : "BMI: n/a"}
          </span>
        </div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 10,
          gap: 10,
        }}
      >
        <span style={{ fontSize: "0.7rem", color: "var(--ba-muted)", lineHeight: 1.4 }}>
          Bowling notes re-sync the Conqueror memo; racing/attraction notes append to the BMI
          project&rsquo;s notes (existing combo/VIP memos are kept).
        </span>
        <button
          type="button"
          onClick={save}
          disabled={saving || text === (r.notes ?? "")}
          style={{
            padding: "0.4rem 1.1rem",
            borderRadius: 8,
            fontSize: "0.78rem",
            fontWeight: 700,
            cursor: saving || text === (r.notes ?? "") ? "not-allowed" : "pointer",
            border: "none",
            backgroundColor:
              saving || text === (r.notes ?? "") ? "rgba(0,226,229,0.25)" : "#00E2E5",
            color: "#04252b",
            whiteSpace: "nowrap",
          }}
        >
          {saving ? "Saving…" : "Save notes"}
        </button>
      </div>
    </Card>
  );
}
