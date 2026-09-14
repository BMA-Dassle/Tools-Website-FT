"use client";

import { useEffect, useRef, useState, type InputHTMLAttributes, type RefObject } from "react";

/**
 * A secret field with the "peek last character" pattern: every character is
 * masked except the one just typed, which stays readable for `peekMs` and then
 * masks too. Typing a credential on a public kiosk screen with the whole value
 * visible is a leak; a fully masked field makes a 6-digit punch ID easy to
 * mistype with no way to see where. This is the middle path phones use.
 *
 * The REAL value never touches the DOM — the input renders a display string of
 * mask dots (plus the peeked tail) and the change handler diffs it against the
 * previous display to recover appends and deletions. That covers a keyboard,
 * the kiosk's on-screen keyboard and Backspace; a mid-string edit or a paste
 * that replaces everything falls back to "start over with what was typed".
 *
 * Owner 2026-09-13: employee ID entry must not show the ID; use the peek
 * pattern rather than a plain password field.
 */
export function PeekSecretInput({
  value,
  onValueChange,
  peekMs = 1200,
  mask = "•",
  inputRef,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: string;
  onValueChange: (next: string) => void;
  /** How long the last typed character stays readable. */
  peekMs?: number;
  mask?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [peek, setPeek] = useState(false);
  const timer = useRef<number | null>(null);
  const lastDisplay = useRef("");

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const masked = mask.repeat(Math.max(0, value.length - 1));
  const display = value.length === 0 ? "" : masked + (peek ? value[value.length - 1] : mask);
  lastDisplay.current = display;

  return (
    <input
      {...rest}
      ref={inputRef}
      type="text"
      value={display}
      onChange={(e) => {
        const nextDisplay = e.target.value;
        const prev = lastDisplay.current;
        let next: string;
        if (nextDisplay.startsWith(prev)) {
          // Appended one or more characters (keyboard, OSK, or a paste at the end).
          next = value + nextDisplay.slice(prev.length);
        } else if (prev.startsWith(nextDisplay)) {
          // Deleted from the end (Backspace, select-all + delete → "").
          next = value.slice(0, nextDisplay.length);
        } else {
          // Edited in the middle or replaced wholesale: keep only the characters
          // that are not mask glyphs — the honest reading of what was typed.
          next = nextDisplay
            .split("")
            .filter((ch) => ch !== mask)
            .join("");
        }
        onValueChange(next);
        if (timer.current) window.clearTimeout(timer.current);
        if (next.length > value.length) {
          setPeek(true);
          timer.current = window.setTimeout(() => setPeek(false), peekMs);
        } else {
          setPeek(false);
        }
      }}
    />
  );
}
