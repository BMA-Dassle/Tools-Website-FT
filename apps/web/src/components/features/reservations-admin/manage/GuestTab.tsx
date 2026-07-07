"use client";

/**
 * Manage Reservation — Guest tab: editable contact (partial PATCH — fixes a
 * typo'd email so resends actually arrive), survey snapshot, booking meta.
 */
import { useState } from "react";
import { SOURCE_LABELS } from "~/features/reservations-admin/constants";
import { fmtDate, fmtTime } from "~/features/reservations-admin/format";
import type { ReservationDetail } from "~/features/reservations-admin/service";
import type { Reservation } from "~/features/reservations-admin/types";
import { SurveyChip } from "../chips";
import { Card } from "./ui";

export default function GuestTab({
  detail,
  boardRow,
  token,
  onSaved,
}: {
  detail: ReservationDetail;
  boardRow: Reservation;
  token: string;
  onSaved: (msg: string) => void;
}) {
  const r = detail.reservation;
  const [name, setName] = useState(r.guestName ?? "");
  const [email, setEmail] = useState(r.guestEmail ?? "");
  const [phone, setPhone] = useState(r.guestPhone ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name !== (r.guestName ?? "") ||
    email !== (r.guestEmail ?? "") ||
    phone !== (r.guestPhone ?? "");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { neonId: r.id };
      if (name !== (r.guestName ?? "") && name.trim()) body.guestName = name.trim();
      if (email !== (r.guestEmail ?? "") && email.trim()) body.guestEmail = email.trim();
      if (phone !== (r.guestPhone ?? "") && phone.trim()) body.guestPhone = phone.trim();
      const res = await fetch(`/api/admin/reservations/guest?token=${encodeURIComponent(token)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        return;
      }
      onSaved("Guest contact updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    type = "text",
    placeholder = "",
  ) => (
    <label
      style={{
        display: "grid",
        gridTemplateColumns: "90px 1fr",
        gap: 10,
        alignItems: "center",
        padding: "6px 0",
        fontSize: "0.82rem",
      }}
    >
      <span style={{ color: "var(--ba-muted)" }}>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
        style={{
          backgroundColor: "var(--ba-input-bg)",
          border: "1px solid var(--ba-input-border)",
          borderRadius: 6,
          color: "var(--ba-fg)",
          padding: "0.35rem 0.6rem",
          fontSize: "0.82rem",
          width: "100%",
        }}
      />
    </label>
  );

  return (
    <>
      <Card title="Contact">
        {field("Name", name, setName)}
        {field("Email", email, setEmail, "email", "guest@example.com")}
        {field("Phone", phone, setPhone, "tel", "(239) 555-0100")}
        {error && (
          <div style={{ marginTop: 6, fontSize: "0.75rem", color: "#ef4444", fontWeight: 600 }}>
            {error}
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
            Updates confirmations &amp; resends. Doesn&rsquo;t rename the Square customer; QAMF
            picks the change up on the next reschedule.
          </span>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            style={{
              padding: "0.4rem 1.1rem",
              borderRadius: 8,
              fontSize: "0.78rem",
              fontWeight: 700,
              cursor: !dirty || saving ? "not-allowed" : "pointer",
              border: "none",
              backgroundColor: !dirty || saving ? "rgba(34,197,94,0.25)" : "#22c55e",
              color: "#fff",
              whiteSpace: "nowrap",
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </Card>

      <Card title="Survey">
        {boardRow.survey ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: "0.8rem" }}>
            <SurveyChip survey={boardRow.survey} />
            <span style={{ color: "var(--ba-muted)" }}>
              sent {fmtTime(boardRow.survey.sentAt)} {fmtDate(boardRow.survey.sentAt)}
              {boardRow.survey.channel ? ` · ${boardRow.survey.channel}` : ""}
            </span>
          </div>
        ) : (
          <div style={{ color: "var(--ba-muted)", fontSize: "0.8rem" }}>No survey sent</div>
        )}
      </Card>

      <Card title="Booking">
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "130px 1fr",
            gap: "4px 12px",
            margin: 0,
            fontSize: "0.8rem",
          }}
        >
          <dt style={{ color: "var(--ba-muted)" }}>Source</dt>
          <dd style={{ margin: 0 }}>
            {SOURCE_LABELS[r.bookingSource ?? "web"] ?? r.bookingSource ?? "Web"}
          </dd>
          <dt style={{ color: "var(--ba-muted)" }}>Booked</dt>
          <dd style={{ margin: 0 }}>
            {fmtTime(r.insertedAt)} · {fmtDate(r.insertedAt)}
          </dd>
          {r.squareCustomerId && (
            <>
              <dt style={{ color: "var(--ba-muted)" }}>Square customer</dt>
              <dd
                style={{
                  margin: 0,
                  fontFamily: "ui-monospace, monospace",
                  fontSize: "0.7rem",
                }}
              >
                {r.squareCustomerId}
              </dd>
            </>
          )}
          {r.loyaltyAction && (
            <>
              <dt style={{ color: "var(--ba-muted)" }}>Loyalty</dt>
              <dd style={{ margin: 0 }}>
                {r.loyaltyAction === "signup" ? "New member (signed up at booking)" : "Member"}
              </dd>
            </>
          )}
        </dl>
      </Card>
    </>
  );
}
