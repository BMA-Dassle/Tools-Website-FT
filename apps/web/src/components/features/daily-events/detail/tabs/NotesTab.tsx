"use client";

/**
 * Notes tab — all BMI memos, public and private (portal parity: no filter).
 * Content lifted unchanged from the pre-tab DailyEventDetail "Memo" section.
 */
import { fmtEventDateTime } from "~/features/daily-events/format";
import { safe } from "~/features/daily-events/print-html";
import type { ProjectLog, ReservationDetail } from "~/features/daily-events/types";
import DetailSection from "../DetailSection";

export default function NotesTab({ detail }: { detail: ReservationDetail }) {
  const logs = Array.isArray(detail.logs) ? detail.logs : [];

  if (logs.length === 0) {
    return (
      <div style={{ fontSize: "0.85rem", color: "var(--ba-muted)" }}>
        No memos on this event — notes live in BMI Office.
      </div>
    );
  }

  return (
    <DetailSection id="logs" title="Memo">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {logs.map((log: ProjectLog, i: number) => (
          <div
            key={safe(log.id) || i}
            style={{
              backgroundColor: "var(--ba-muted2)",
              border: "1px solid var(--ba-border)",
              borderRadius: 8,
              padding: 12,
            }}
          >
            {safe(log.memo) && (
              <div
                style={{
                  fontSize: "0.875rem",
                  color: "var(--ba-fg)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {safe(log.memo)}
              </div>
            )}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginTop: 6,
                fontSize: "0.75rem",
                color: "var(--ba-muted)",
              }}
            >
              {safe(log.updated) && <span>{fmtEventDateTime(safe(log.updated))}</span>}
              {safe(log.updatedBy) && <span>by {safe(log.updatedBy)}</span>}
              {log.isPublic != null && (
                <span
                  style={{
                    padding: "0 6px",
                    borderRadius: 4,
                    border: "1px solid var(--ba-border)",
                    fontSize: "0.65rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.03em",
                  }}
                >
                  {log.isPublic ? "Public" : "Private"}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </DetailSection>
  );
}
