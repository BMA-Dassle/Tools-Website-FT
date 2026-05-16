"use client";

import ShoeSizePicker from "./ShoeSizePicker";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AdminBowlerSelection {
  key: string;
  name: string;
  relation: "kid" | "family" | "parent" | "guest";
  selected: boolean;
  shoeSize: string | null;
  wantBumpers: boolean;
  kbfPassId?: number;
  kbfMemberSlot?: number;
  redeemedToday?: boolean;
}

interface BowlerEditorProps {
  bowler: AdminBowlerSelection;
  onChange: (updated: AdminBowlerSelection) => void;
  /** If true, name renders as an editable text input (used for guests) */
  editableName?: boolean;
  /** Called when guest remove button is clicked */
  onRemove?: () => void;
  /** Lock all interactions (used when a hold is active) */
  disabled?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Relation badges                                                    */
/* ------------------------------------------------------------------ */

const RELATION_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  kid: { label: "Kid", bg: "#dcfce7", color: "#166534" },
  family: { label: "Family", bg: "#dbeafe", color: "#1e40af" },
  parent: { label: "Adult", bg: "#dbeafe", color: "#1e40af" },
  guest: { label: "Guest", bg: "#ffedd5", color: "#9a3412" },
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function BowlerEditor({
  bowler,
  onChange,
  editableName,
  onRemove,
  disabled,
}: BowlerEditorProps) {
  const badge = RELATION_BADGE[bowler.relation] ?? RELATION_BADGE.guest;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 44,
        padding: "0 8px",
        borderBottom: "1px solid #e5e7eb",
        opacity: disabled ? 0.6 : bowler.selected ? 1 : 0.5,
        pointerEvents: disabled ? "none" : undefined,
      }}
    >
      {/* Checkbox */}
      <input
        type="checkbox"
        checked={bowler.selected}
        disabled={disabled}
        onChange={(e) => onChange({ ...bowler, selected: e.target.checked })}
        style={{
          width: 16,
          height: 16,
          cursor: disabled ? "default" : "pointer",
          accentColor: "#004AAD",
          flexShrink: 0,
        }}
      />

      {/* Name */}
      {editableName ? (
        <input
          type="text"
          value={bowler.name}
          onChange={(e) => onChange({ ...bowler, name: e.target.value })}
          placeholder="Guest name"
          style={{
            fontWeight: 600,
            fontSize: 13,
            color: "#111827",
            border: "1px solid #d1d5db",
            borderRadius: 4,
            padding: "2px 6px",
            width: 110,
            outline: "none",
          }}
        />
      ) : (
        <span
          style={{
            fontWeight: 600,
            fontSize: 13,
            color: "#111827",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 120,
          }}
        >
          {bowler.name || "—"}
        </span>
      )}

      {/* Relation badge */}
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          padding: "1px 8px",
          borderRadius: 10,
          backgroundColor: badge.bg,
          color: badge.color,
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {badge.label}
      </span>

      {/* Redeemed today badge */}
      {bowler.redeemedToday && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: "1px 6px",
            borderRadius: 10,
            backgroundColor: "#fee2e2",
            color: "#991b1b",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          Played today
        </span>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Shoe size + Bumpers — only when selected */}
      {bowler.selected && (
        <>
          <ShoeSizePicker
            compact
            value={bowler.shoeSize}
            onChange={(sz) => onChange({ ...bowler, shoeSize: sz })}
          />
          <button
            type="button"
            title={bowler.wantBumpers ? "Bumpers ON" : "Bumpers OFF"}
            onClick={() => onChange({ ...bowler, wantBumpers: !bowler.wantBumpers })}
            style={{
              width: 26,
              height: 26,
              fontSize: 12,
              fontWeight: 700,
              borderRadius: 4,
              border: bowler.wantBumpers ? "1px solid #004AAD" : "1px solid #d1d5db",
              backgroundColor: bowler.wantBumpers ? "#004AAD" : "#fff",
              color: bowler.wantBumpers ? "#fff" : "#9ca3af",
              cursor: "pointer",
              padding: 0,
              flexShrink: 0,
              lineHeight: "24px",
              textAlign: "center",
            }}
          >
            B
          </button>
        </>
      )}

      {/* Remove button for guests */}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove guest"
          style={{
            width: 22,
            height: 22,
            fontSize: 14,
            lineHeight: "20px",
            textAlign: "center",
            border: "1px solid #d1d5db",
            borderRadius: 4,
            backgroundColor: "#fff",
            color: "#9ca3af",
            cursor: "pointer",
            padding: 0,
            flexShrink: 0,
          }}
        >
          &times;
        </button>
      )}
    </div>
  );
}
