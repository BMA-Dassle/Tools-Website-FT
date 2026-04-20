import type { KeyboardEvent } from "react";

/**
 * Produce the props needed to make a non-interactive element (a div, span)
 * behave as a keyboard-accessible button. Satisfies both:
 *   - jsx-a11y/click-events-have-key-events (Enter/Space trigger onClick)
 *   - jsx-a11y/no-static-element-interactions (role + tabIndex)
 *
 * Prefer a real `<button type="button">` when possible — only reach for
 * this helper when the element has to stay a div/span for layout reasons
 * (nested anchors, grid-item children, table cells that can't be buttons).
 *
 * Usage:
 *   <div {...clickableDivProps(() => doStuff())}>click me</div>
 *
 *   // With aria-label when no visible text:
 *   <div {...clickableDivProps(handleOpen, "Open settings")}>⚙</div>
 *
 *   // Disabled state:
 *   <div {...clickableDivProps(handle, "Submit", { disabled: isLoading })}>…</div>
 */
export function clickableDivProps(
  onClick: (e: React.SyntheticEvent) => void,
  ariaLabel?: string,
  options: { disabled?: boolean } = {},
) {
  const { disabled = false } = options;
  return {
    role: "button" as const,
    tabIndex: disabled ? -1 : 0,
    "aria-disabled": disabled || undefined,
    "aria-label": ariaLabel,
    onClick: disabled
      ? undefined
      : (e: React.SyntheticEvent) => {
          onClick(e);
        },
    onKeyDown: disabled
      ? undefined
      : (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick(e);
          }
        },
  };
}

/**
 * Just the keyboard handler piece, for when you already have role +
 * tabIndex set some other way.
 */
export function onKeyDownActivate(
  onClick: (e: React.SyntheticEvent) => void,
): (e: KeyboardEvent) => void {
  return (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick(e);
    }
  };
}

/**
 * Props for a modal backdrop div that dismisses on:
 *   - click outside the modal content (via target === currentTarget check)
 *   - Escape key
 *
 * Use on the OUTER `<div>` of a modal. The inner content div then needs
 * NO onClick at all (no stopPropagation) — the target check handles it.
 * This eliminates the paired `click-events-have-key-events` +
 * `no-static-element-interactions` warnings across all modals in the app.
 *
 *   <div className="fixed inset-0 …" {...modalBackdropProps(onClose)}>
 *     <div className="rounded-lg …">modal content</div>
 *   </div>
 */
export function modalBackdropProps(onClose: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-label": "Close dialog",
    onClick: (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClose();
      }
    },
  };
}
