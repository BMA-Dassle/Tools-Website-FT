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
    };
  }, [hide]);

  // Route change = new screen = no stale keyboard.
  useEffect(() => hide(), [pathname, hide]);

  if (!target) return null;

  const rows = OSK_LAYOUTS[layout];
  const letterCase =
    layout === "qwerty" || layout === "email"
      ? shouldCapitalize(target.value, target.selectionStart ?? target.value.length, shift)
      : false;

  const press = (code: string) => {
    if (code === OSK_DONE) {
      target.blur();
      hide();
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
      className="fixed inset-x-0 bottom-0 z-[70] border-t border-white/10 bg-[#060d22]/97 px-[2%] pb-[1.6%] pt-[1.2%] backdrop-blur-xl"
      // Keep focus in the field: the keyboard itself is never focusable.
      onPointerDown={(e) => e.preventDefault()}
    >
      <div className="mx-auto flex max-w-[1000px] flex-col gap-[0.7vh]">
        {rows.map((row, ri) => (
          <div key={ri} className="flex justify-center gap-[0.7vh]">
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
                  className={`h-[6.2vh] min-w-0 rounded-xl border text-[2.4vh] font-semibold active:bg-[#00e2e5] active:text-[#04252b] ${
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
