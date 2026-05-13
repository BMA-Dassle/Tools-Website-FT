"use client";

import BowlerEditor from "./BowlerEditor";
import type { AdminBowlerSelection } from "./BowlerEditor";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface AdminBowlerListProps {
  bowlers: AdminBowlerSelection[];
  onChange: (bowlers: AdminBowlerSelection[]) => void;
  /** Show "+ Add Guest Adult" button. Default false. */
  showAddGuest?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function AdminBowlerList({ bowlers, onChange, showAddGuest = false }: AdminBowlerListProps) {
  function updateBowler(idx: number, updated: AdminBowlerSelection) {
    const next = [...bowlers];
    next[idx] = updated;
    onChange(next);
  }

  function removeBowler(idx: number) {
    onChange(bowlers.filter((_, i) => i !== idx));
  }

  function addGuest() {
    onChange([
      ...bowlers,
      {
        key: "guest-" + Date.now(),
        name: "",
        relation: "guest",
        selected: true,
        shoeSize: null,
        wantBumpers: false,
      },
    ]);
  }

  return (
    <div>
      {/* Bowler rows */}
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          overflow: "visible",
          backgroundColor: "#fff",
        }}
      >
        {bowlers.map((b, i) => (
          <BowlerEditor
            key={b.key}
            bowler={b}
            onChange={(updated) => updateBowler(i, updated)}
            editableName={b.relation === "guest"}
            onRemove={b.relation === "guest" ? () => removeBowler(i) : undefined}
          />
        ))}
        {bowlers.length === 0 && (
          <div style={{ padding: 16, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
            No bowlers
          </div>
        )}
      </div>

      {/* Add guest button (opt-in, used by regular bowling admin) */}
      {showAddGuest && (
        <button
          type="button"
          onClick={addGuest}
          style={{
            marginTop: 8,
            fontSize: 12,
            fontWeight: 600,
            padding: "4px 12px",
            border: "1px solid #d1d5db",
            borderRadius: 6,
            backgroundColor: "#fff",
            color: "#374151",
            cursor: "pointer",
          }}
        >
          + Add Guest Adult
        </button>
      )}
    </div>
  );
}
