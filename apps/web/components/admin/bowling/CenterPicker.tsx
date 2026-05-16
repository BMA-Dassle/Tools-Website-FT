"use client";

const CENTERS = [
  { code: "TXBSQN0FEKQ11", label: "Fort Myers", qamfId: 9172 },
  { code: "PPTR5G2N0QXF7", label: "Naples", qamfId: 3148 },
] as const;

export { CENTERS };
export type CenterCode = (typeof CENTERS)[number]["code"];

interface CenterPickerProps {
  value: string;
  onChange: (centerCode: string) => void;
}

const BASE_BTN: React.CSSProperties = {
  padding: "6px 16px",
  fontSize: 13,
  fontWeight: 600,
  border: "none",
  borderRadius: 16,
  cursor: "pointer",
  transition: "background-color 0.15s, color 0.15s",
  lineHeight: "20px",
};

export default function CenterPicker({ value, onChange }: CenterPickerProps) {
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 4,
        background: "#e5e7eb",
        borderRadius: 18,
        padding: 2,
      }}
    >
      {CENTERS.map((c) => {
        const active = value === c.code;
        return (
          <button
            key={c.code}
            type="button"
            onClick={() => onChange(c.code)}
            style={{
              ...BASE_BTN,
              backgroundColor: active ? "#004AAD" : "transparent",
              color: active ? "#fff" : "#374151",
            }}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
