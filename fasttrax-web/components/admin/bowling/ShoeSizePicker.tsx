"use client";

import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Data                                                               */
/* ------------------------------------------------------------------ */

type ShoeCategory = "Toddler" | "Male" | "Female";

const CATEGORIES: ShoeCategory[] = ["Toddler", "Male", "Female"];
const CATEGORY_LABELS: Record<ShoeCategory, string> = {
  Toddler: "Toddler",
  Male: "Men",
  Female: "Women",
};
const CATEGORY_PREFIX: Record<ShoeCategory, string> = {
  Toddler: "T",
  Male: "M",
  Female: "W",
};

const SHOE_SIZES: Record<ShoeCategory, string[]> = {
  Toddler: ["6", "7", "8", "9", "10", "11", "12", "13"],
  Male: [
    "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "5.5",
    "6", "6.5", "7", "7.5", "8", "8.5", "9", "9.5", "10", "10.5",
    "11", "11.5", "12", "12.5", "13", "13.5", "14", "14.5", "15",
  ],
  Female: [
    "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "5.5",
    "6", "6.5", "7", "7.5", "8", "8.5", "9", "9.5", "10", "10.5",
    "11", "11.5", "12",
  ],
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Parse "Male 10.5" or "Toddler 8" → { category, size } */
function parseValue(v: string | null): { category: ShoeCategory; size: string } | null {
  if (!v) return null;
  const lower = v.toLowerCase();
  if (lower.startsWith("toddler") || lower.startsWith("kids")) {
    const size = v.replace(/^(toddler|kids)\s*/i, "");
    return size ? { category: "Toddler", size } : null;
  }
  if (lower.startsWith("male") || lower.startsWith("men")) {
    const size = v.replace(/^(male|men)\s*/i, "");
    return size ? { category: "Male", size } : null;
  }
  if (lower.startsWith("female") || lower.startsWith("women")) {
    const size = v.replace(/^(female|women)\s*/i, "");
    return size ? { category: "Female", size } : null;
  }
  return null;
}

/** "Male 10.5" → "M10.5", "Toddler 8" → "T8" */
function shortLabel(v: string | null): string {
  const parsed = parseValue(v);
  if (!parsed) return "Shoe";
  return CATEGORY_PREFIX[parsed.category] + parsed.size;
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface ShoeSizePickerProps {
  value: string | null;
  onChange: (size: string | null) => void;
  compact?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Size grid (shared between compact & full modes)                    */
/* ------------------------------------------------------------------ */

function SizeGrid({
  category,
  selectedSize,
  onSelect,
}: {
  category: ShoeCategory;
  selectedSize: string | null;
  onSelect: (size: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, padding: "4px 0" }}>
      {SHOE_SIZES[category].map((s) => {
        const active = selectedSize === s;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onSelect(s)}
            style={{
              width: 40,
              height: 30,
              fontSize: 12,
              fontWeight: active ? 700 : 400,
              border: active ? "2px solid #004AAD" : "1px solid #d1d5db",
              borderRadius: 4,
              backgroundColor: active ? "#004AAD" : "#fff",
              color: active ? "#fff" : "#374151",
              cursor: "pointer",
              padding: 0,
              lineHeight: "28px",
              textAlign: "center",
            }}
          >
            {s}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Category tabs                                                      */
/* ------------------------------------------------------------------ */

function CategoryTabs({
  active,
  onSelect,
}: {
  active: ShoeCategory;
  onSelect: (c: ShoeCategory) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 2, marginBottom: 4 }}>
      {CATEGORIES.map((c) => {
        const isActive = active === c;
        return (
          <button
            key={c}
            type="button"
            onClick={() => onSelect(c)}
            style={{
              flex: 1,
              padding: "4px 0",
              fontSize: 12,
              fontWeight: isActive ? 700 : 400,
              border: "none",
              borderBottom: isActive ? "2px solid #004AAD" : "2px solid transparent",
              backgroundColor: "transparent",
              color: isActive ? "#004AAD" : "#6b7280",
              cursor: "pointer",
            }}
          >
            {CATEGORY_LABELS[c]}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ShoeSizePicker({ value, onChange, compact = false }: ShoeSizePickerProps) {
  const parsed = parseValue(value);
  const [category, setCategory] = useState<ShoeCategory>(parsed?.category ?? "Male");
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function handleSelect(size: string) {
    const current = parseValue(value);
    if (current && current.category === category && current.size === size) {
      // Deselect
      onChange(null);
    } else {
      onChange(`${category} ${size}`);
    }
    if (compact) setOpen(false);
  }

  // Non-compact: render inline
  if (!compact) {
    return (
      <div>
        <CategoryTabs active={category} onSelect={setCategory} />
        <SizeGrid
          category={category}
          selectedSize={parsed?.category === category ? parsed.size : null}
          onSelect={handleSelect}
        />
      </div>
    );
  }

  // Compact: chip + dropdown
  return (
    <div ref={wrapperRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          fontSize: 12,
          fontWeight: 600,
          padding: "2px 8px",
          borderRadius: 10,
          border: value ? "1px solid #004AAD" : "1px solid #d1d5db",
          backgroundColor: value ? "#e0ecff" : "#f9fafb",
          color: value ? "#004AAD" : "#9ca3af",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {shortLabel(value)}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            zIndex: 50,
            marginTop: 4,
            width: 260,
            padding: 8,
            backgroundColor: "#fff",
            border: "1px solid #d1d5db",
            borderRadius: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
          }}
        >
          <CategoryTabs active={category} onSelect={setCategory} />
          <SizeGrid
            category={category}
            selectedSize={parsed?.category === category ? parsed.size : null}
            onSelect={handleSelect}
          />
        </div>
      )}
    </div>
  );
}
