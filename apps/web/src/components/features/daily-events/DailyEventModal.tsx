"use client";

/**
 * Event-detail modal — replaces the portal's ReservationModal wrapper.
 *
 * Full-viewport ModalShell (like ManageReservationModal) with a slim top
 * bar: "Event Detail" label, prev/next navigation over the board's visible
 * event ids (replaces the portal's router-state plumbing), and a close
 * button. The portal's "Full Page" button is gone — the modal IS the full
 * viewport now.
 *
 * The body remounts DailyEventDetail via `key={projectId}` on navigation
 * (repo idiom) so all fetch/scroll state resets per event.
 */
import ModalShell from "../reservations-admin/ModalShell";
import { NAV_BTN } from "../reservations-admin/theme";
import DailyEventDetail from "./detail/DailyEventDetail";

export default function DailyEventModal({
  token,
  projectId,
  locationId,
  ids,
  onNavigate,
  onClose,
}: {
  token: string;
  projectId: string;
  locationId: number;
  /** Visible event ids from the board, in display order (prev/next walk). */
  ids: string[];
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  const idx = ids.indexOf(projectId);
  const showNav = ids.length > 1 && idx >= 0;
  const prevId = showNav && idx > 0 ? ids[idx - 1] : null;
  const nextId = showNav && idx < ids.length - 1 ? ids[idx + 1] : null;

  const navBtn = (disabled: boolean): React.CSSProperties => ({
    ...NAV_BTN,
    padding: "0.25rem 0.6rem",
    lineHeight: 1,
    ...(disabled ? { opacity: 0.4, cursor: "default" } : {}),
  });

  return (
    <ModalShell onClose={onClose} variant="full">
      {/* ── Slim top bar ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "8px 16px",
          borderBottom: "1px solid var(--ba-border)",
          backgroundColor: "var(--ba-bg)",
          borderTopLeftRadius: 12,
          borderTopRightRadius: 12,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: "0.75rem", fontWeight: 500, color: "var(--ba-muted)" }}>
          Event Detail
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {showNav && (
            <>
              <button
                type="button"
                aria-label="Previous event"
                disabled={!prevId}
                onClick={() => prevId && onNavigate(prevId)}
                style={navBtn(!prevId)}
              >
                ‹
              </button>
              <span
                style={{
                  fontSize: "0.72rem",
                  color: "var(--ba-muted)",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                {idx + 1} of {ids.length}
              </span>
              <button
                type="button"
                aria-label="Next event"
                disabled={!nextId}
                onClick={() => nextId && onNavigate(nextId)}
                style={navBtn(!nextId)}
              >
                ›
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            style={{
              background: "none",
              border: "none",
              color: "var(--ba-muted)",
              cursor: "pointer",
              fontSize: "1.25rem",
              lineHeight: 1,
              padding: "0 4px",
            }}
          >
            &times;
          </button>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
        <DailyEventDetail
          key={projectId}
          token={token}
          projectId={projectId}
          locationId={locationId}
        />
      </div>
    </ModalShell>
  );
}
