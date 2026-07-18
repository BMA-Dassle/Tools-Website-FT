"use client";

/**
 * Global kiosk on-screen keyboard.
 *
 * Mounted ONCE inside KioskShell. Focus-driven: any same-origin
 * <input>/<textarea> focus (except [data-osk="off"]) docks the branded
 * keyboard as a bottom sheet, with the layout chosen from the input type
 * (or data-osk-layout). Typing goes through the native value setter +
 * a bubbled `input` event, so React CONTROLLED inputs — ContactStep,
 * ReturningRacerLookup, KBF identity — work completely unmodified.
 *
 * The Square card iframe is cross-origin: focusing it fires window `blur`
 * (never `focusin`), which HIDES this keyboard — the Windows touch keyboard
 * owns that one step, and the two never stack.
 *
 * Keys use onPointerDown + preventDefault so the field never loses focus
 * while typing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  applyOskKey,
  layoutForField,
  shouldCapitalize,
  OSK_BACKSPACE,
  OSK_DONE,
  OSK_LAYOUTS,
  OSK_SHIFT,
  type OskLayoutId,
} from "../osk-core";

type EditableEl = HTMLInputElement | HTMLTextAreaElement;

const ELIGIBLE_TYPES = new Set(["text", "email", "tel", "number", "search", "password"]);

function eligible(el: EventTarget | null): EditableEl | null {
  if (!(el instanceof HTMLElement)) return null;
  if (el.closest('[data-osk="off"]')) return null;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && ELIGIBLE_TYPES.has((el.type || "text").toLowerCase())) {
    return el;
  }
  return null;
}

/** Write through the native setter so React's onChange sees the edit. */
function setNativeValue(el: EditableEl, value: string, caret: number) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    /* number inputs throw on setSelectionRange — caret goes to the end natively */
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function OnScreenKeyboardHost() {
  const pathname = usePathname();
  const [target, setTarget] = useState<EditableEl | null>(null);
  const [layout, setLayout] = useState<OskLayoutId>("qwerty");
  const [shift, setShift] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // After "Done", a transparent full-canvas shield briefly swallows the next tap
  // so it can't fall THROUGH to whatever sits under the (now-closing) keyboard —
  // e.g. the wizard's Continue button docked at the same bottom edge, which on
  // the returning-racer lookup was advancing the flow to the cart (owner
  // 2026-07-19). Timing-independent: works even for a slow/firm Done press.
  const [shield, setShield] = useState(false);
  const shieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    setTarget(null);
    setShift(false);
  }, []);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const el = eligible(e.target);
      if (!el) return;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setTarget(el);
      setLayout(layoutForField({ type: el.getAttribute("type"), oskLayout: el.dataset.oskLayout }));
      // Keep the field visible above the docked sheet.
      setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
    };
    const onFocusOut = () => {
      // Grace period: focus bouncing between fields shouldn't flash the sheet.
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => {
        const el = eligible(document.activeElement);
        if (!el) hide();
      }, 150);
    };
    // Square's card iframe steals focus cross-origin → window blur, not focusin.
    const onWindowBlur = () => hide();

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("blur", onWindowBlur);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (shieldTimer.current) clearTimeout(shieldTimer.current);
    };
  }, [hide]);

  // Route change = new screen = no stale keyboard.
  useEffect(() => hide(), [pathname, hide]);

  // Swallow the post-"Done" fall-through tap (see press()). Rendered even after
  // the keyboard itself has closed (target null), for the brief shield window.
  const swallow = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const clickShield = shield ? (
    <div
      className="fixed inset-0 z-[100]"
      aria-hidden="true"
      onPointerDownCapture={swallow}
      onPointerUpCapture={swallow}
      onClickCapture={swallow}
    />
  ) : null;

  if (!target) return clickShield;

  const rows = OSK_LAYOUTS[layout];
  const letterCase =
    layout === "qwerty" || layout === "email"
      ? shouldCapitalize(target.value, target.selectionStart ?? target.value.length, shift)
      : false;

  const press = (code: string) => {
    if (code === OSK_DONE) {
      // Close the sheet AND raise the click-shield so this tap can't fall through
      // to the Continue button under the keyboard (which was advancing the
      // returning-racer lookup to the cart). The shield covers the canvas for a
      // beat and swallows the very next pointer/click event, then removes itself.
      target.blur();
      hide();
      setShield(true);
      if (shieldTimer.current) clearTimeout(shieldTimer.current);
      shieldTimer.current = setTimeout(() => setShield(false), 500);
      return;
    }
    if (code === OSK_SHIFT) {
      setShift((s) => !s);
      return;
    }
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const literal =
      code.length === 1 && /[a-z]/.test(code) && letterCase ? code.toUpperCase() : code;
    const next = applyOskKey(target.value, start, end, literal);
    setNativeValue(target, next.value, next.caret);
    if (shift && code !== OSK_BACKSPACE) setShift(false);
  };

  return (
    <div
      // Docks to the bottom of the SCALED 1080×1920 canvas (the canvas transform
      // is the containing block for position:fixed here), so sizes are canvas px
      // — they scale with everything else. z-[90]: ABOVE the in-flow modals (DOB
      // prompt z-75, waiver sheet z-76) so the keyboard is never hidden behind a
      // modal on those typing steps ("missing keyboard on several steps").
      className="fixed inset-x-0 bottom-0 z-[90] border-t border-white/10 bg-[#060d22]/97 px-[40px] pb-[32px] pt-[26px] backdrop-blur-xl"
      // Keep focus in the field: the keyboard itself is never focusable.
      onPointerDown={(e) => e.preventDefault()}
    >
      <div className="mx-auto flex max-w-[1000px] flex-col gap-[12px]">
        {rows.map((row, ri) => (
          <div key={ri} className="flex justify-center gap-[12px]">
            {row.map((k) => {
              const isDone = k.code === OSK_DONE;
              const isShift = k.code === OSK_SHIFT;
              const label =
                k.label ?? (k.code.length === 1 && letterCase ? k.code.toUpperCase() : k.code);
              return (
                <button
                  key={k.code}
                  type="button"
                  tabIndex={-1}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    press(k.code);
                  }}
                  style={{ flexGrow: k.w ?? 1, flexBasis: 0 }}
                  className={`h-[90px] min-w-0 rounded-xl border text-[34px] font-semibold active:bg-[#00e2e5] active:text-[#04252b] ${
                    isDone
                      ? "font-heading border-transparent bg-[#00e2e5] font-extrabold italic text-[#04252b]"
                      : isShift && shift
                        ? "border-[#00e2e5] bg-[#00e2e5]/20 text-white"
                        : "border-white/10 bg-[#0f1c3d] text-[#f5ecee]"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
