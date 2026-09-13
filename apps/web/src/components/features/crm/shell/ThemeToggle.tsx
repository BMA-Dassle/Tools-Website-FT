"use client";

import { IconMoon, IconSun } from "@tabler/icons-react";
import { ICON } from "../primitives/icon-props";
import type { CrmTheme } from "../lib/theme";

/**
 * Dark ⇄ light. An icon-only button, so the name lives in `aria-label` and
 * says what pressing it DOES (brief R13 / lesson 1738).
 */
export interface ThemeToggleProps {
  theme: CrmTheme;
  onChange: (theme: CrmTheme) => void;
  testId?: string;
  className?: string;
}

export function ThemeToggle({ theme, onChange, testId, className }: ThemeToggleProps) {
  const next: CrmTheme = theme === "dark" ? "light" : "dark";
  const label = next === "light" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <button
      type="button"
      className={["btn btn-ghost btn-icon", className ?? ""].filter(Boolean).join(" ")}
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={() => onChange(next)}
    >
      {theme === "dark" ? <IconSun {...ICON} /> : <IconMoon {...ICON} />}
    </button>
  );
}
