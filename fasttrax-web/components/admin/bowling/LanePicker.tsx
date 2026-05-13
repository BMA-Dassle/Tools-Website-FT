"use client";

import { useEffect } from "react";
import type { Lane } from "@/lib/qamf-bowling";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface LanePickerProps {
  lanes: Lane[];
  selected: number | null;
  onChange: (laneNumber: number) => void;
  loading?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Lane button styles by status                                       */
/* ------------------------------------------------------------------ */

function laneStyle(lane: Lane, isSelected: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    width: 48,
    height: 48,
    fontSize: 14,
    fontWeight: 700,
    borderRadius: 6,
    border: "2px solid",
    cursor: "default",
    padding: 0,
    lineHeight: "44px",
    textAlign: "center",
    transition: "background-color 0.15s",
  };

  if (isSelected) {
    return {
      ...base,
      backgroundColor: "#22c55e",
      borderColor: "#22c55e",
      color: "#fff",
      cursor: "pointer",
    };
  }

  switch (lane.Status) {
    case "Closed":
      return {
        ...base,
        backgroundColor: "rgba(34,197,94,0.06)",
        borderColor: "#22c55e",
        color: "#166534",
        cursor: "pointer",
      };
    case "Open":
      return {
        ...base,
        backgroundColor: "rgba(239,68,68,0.06)",
        borderColor: "#ef4444",
        color: "#991b1b",
        opacity: 0.6,
      };
    case "Error":
    default:
      return {
        ...base,
        backgroundColor: "#f3f4f6",
        borderColor: "#d1d5db",
        color: "#9ca3af",
        opacity: 0.5,
      };
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function LanePicker({ lanes, selected, onChange, loading }: LanePickerProps) {
  const sorted = [...lanes].sort((a, b) => a.LaneNumber - b.LaneNumber);
  const closedLanes = sorted.filter((l) => l.Status === "Closed");

  // Auto-select first closed lane if nothing selected
  useEffect(() => {
    if (selected == null && closedLanes.length > 0) {
      onChange(closedLanes[0].LaneNumber);
    }
  }, [selected, closedLanes, onChange]);

  return (
    <div>
      {loading && (
        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
          Loading lanes...
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {sorted.map((lane) => {
          const isClickable = lane.Status === "Closed";
          const isSelected = selected === lane.LaneNumber;
          return (
            <button
              key={lane.LaneNumber}
              type="button"
              disabled={!isClickable}
              onClick={() => isClickable && onChange(lane.LaneNumber)}
              style={laneStyle(lane, isSelected)}
            >
              {lane.LaneNumber}
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11, color: "#6b7280" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#22c55e", display: "inline-block" }} />
          Available
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#ef4444", display: "inline-block" }} />
          In Use
        </span>
      </div>
    </div>
  );
}
