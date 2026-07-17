/**
 * Pure core of the kiosk on-screen keyboard — layouts + key application.
 * No DOM here so the editing logic is unit-testable in node; the React host
 * (components/OnScreenKeyboard.tsx) owns focus tracking and native-value
 * injection.
 */

export type OskLayoutId = "qwerty" | "email" | "phone" | "numeric";

/** Special key codes (anything else is a literal string to insert). */
export const OSK_BACKSPACE = "{bksp}";
export const OSK_SPACE = "{space}";
export const OSK_SHIFT = "{shift}";
export const OSK_DONE = "{done}";

export interface OskKey {
  /** literal to insert, or one of the {special} codes */
  code: string;
  /** display label (defaults to code) */
  label?: string;
  /** relative width, 1 = standard key */
  w?: number;
}

const letters = (row: string): OskKey[] => row.split("").map((c) => ({ code: c }));

export const OSK_LAYOUTS: Record<OskLayoutId, OskKey[][]> = {
  qwerty: [
    letters("1234567890"),
    letters("qwertyuiop"),
    letters("asdfghjkl"),
    [
      { code: OSK_SHIFT, label: "⇧", w: 1.4 },
      ...letters("zxcvbnm"),
      { code: OSK_BACKSPACE, label: "⌫", w: 1.4 },
    ],
    [
      { code: "@", w: 1.2 },
      { code: OSK_SPACE, label: "space", w: 5 },
      { code: "'", w: 1 },
      { code: "-", w: 1 },
      { code: ".", w: 1 },
      { code: OSK_DONE, label: "Done", w: 1.8 },
    ],
  ],
  email: [
    letters("1234567890"),
    letters("qwertyuiop"),
    letters("asdfghjkl"),
    [{ code: "_", w: 1.2 }, ...letters("zxcvbnm"), { code: OSK_BACKSPACE, label: "⌫", w: 1.4 }],
    [
      { code: "@", w: 1.4 },
      { code: ".", w: 1 },
      { code: "-", w: 1 },
      { code: ".com", label: ".com", w: 1.8 },
      { code: OSK_DONE, label: "Done", w: 1.8 },
    ],
  ],
  phone: [
    letters("123"),
    letters("456"),
    letters("789"),
    [
      { code: OSK_BACKSPACE, label: "⌫", w: 1 },
      { code: "0", w: 1 },
      { code: OSK_DONE, label: "Done", w: 1 },
    ],
  ],
  numeric: [
    letters("123"),
    letters("456"),
    letters("789"),
    [
      { code: OSK_BACKSPACE, label: "⌫", w: 1 },
      { code: "0", w: 1 },
      { code: OSK_DONE, label: "Done", w: 1 },
    ],
  ],
};

/** Digit row appended to email layout via the "123" toggle → reuse numeric. */
export function layoutForField(args: {
  type?: string | null;
  oskLayout?: string | null;
}): OskLayoutId {
  const explicit = (args.oskLayout ?? "").toLowerCase();
  if (
    explicit === "qwerty" ||
    explicit === "email" ||
    explicit === "phone" ||
    explicit === "numeric"
  ) {
    return explicit;
  }
  const t = (args.type ?? "text").toLowerCase();
  if (t === "email") return "email";
  if (t === "tel") return "phone";
  if (t === "number") return "numeric";
  return "qwerty";
}

export interface OskEditState {
  value: string;
  /** caret position (collapsed selection) after the edit */
  caret: number;
}

/**
 * Apply a key to a value with a selection [selStart, selEnd). Literal keys
 * replace the selection; backspace deletes the selection or the char before
 * the caret; space inserts " ".
 */
export function applyOskKey(
  value: string,
  selStart: number,
  selEnd: number,
  code: string,
): OskEditState {
  const start = Math.max(0, Math.min(selStart, value.length));
  const end = Math.max(start, Math.min(selEnd, value.length));
  if (code === OSK_BACKSPACE) {
    if (start !== end) {
      return { value: value.slice(0, start) + value.slice(end), caret: start };
    }
    if (start === 0) return { value, caret: 0 };
    return { value: value.slice(0, start - 1) + value.slice(end), caret: start - 1 };
  }
  const insert = code === OSK_SPACE ? " " : code;
  return {
    value: value.slice(0, start) + insert + value.slice(end),
    caret: start + insert.length,
  };
}

/**
 * Smart-caps for name-ish typing: capitalize at the start of the value and
 * after a space (or when shift is latched). Only letters are affected.
 */
export function shouldCapitalize(value: string, caret: number, shiftLatched: boolean): boolean {
  if (shiftLatched) return true;
  if (caret <= 0) return true;
  return value[caret - 1] === " ";
}
