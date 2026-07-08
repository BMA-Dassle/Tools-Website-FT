"use client";

/**
 * Guest contact (phone / email) popover — opened from the guest name so the
 * row stays single-line. Extracted verbatim from
 * app/admin/[token]/reservations/ReservationsClient.tsx.
 */
import ModalShell from "../ModalShell";
import { NAV_BTN } from "../theme";

export interface ContactTarget {
  name: string;
  phone?: string;
  email?: string;
}

export default function ContactModal({
  target,
  onClose,
}: {
  target: ContactTarget;
  onClose: () => void;
}) {
  return (
    <ModalShell
      onClose={onClose}
      maxWidth={380}
      borderRadius={12}
      padding={24}
      blurBackdrop={false}
    >
      <h3 style={{ margin: "0 0 14px", fontSize: "0.95rem", fontWeight: 700 }}>{target.name}</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {target.phone ? (
          <a
            href={`tel:${target.phone}`}
            style={{ color: "#60a5fa", fontSize: "0.9rem", textDecoration: "none" }}
          >
            📞 {target.phone}
          </a>
        ) : (
          <span style={{ color: "var(--ba-muted)", fontSize: "0.85rem" }}>No phone</span>
        )}
        {target.email ? (
          <a
            href={`mailto:${target.email}`}
            style={{
              color: "#60a5fa",
              fontSize: "0.9rem",
              textDecoration: "none",
              wordBreak: "break-all",
            }}
          >
            ✉️ {target.email}
          </a>
        ) : (
          <span style={{ color: "var(--ba-muted)", fontSize: "0.85rem" }}>No email</span>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
        <button
          type="button"
          onClick={onClose}
          style={{ ...NAV_BTN, fontSize: "0.8rem", fontWeight: 600 }}
        >
          Close
        </button>
      </div>
    </ModalShell>
  );
}
