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
 * owns that one step, and the two never stack. Everywhere else the OS
 * keyboard is actively suppressed: eligible fields are stamped
 * inputmode="none" (see stampSubtree) so only this keyboard appears.
 *
 * Keys use onPointerDown + preventDefault so the field never loses focus
 * while typing.
 *
 * The sheet is 454px (numeric/phone) to 556px (qwerty/email) of the 1920px
 * canvas — nearly a third of the screen — and it covers whatever is under it.
 * Nothing else in the kiosk knows that, so while it's open this host RESERVES
 * its own height at the bottom of the focused field's scrolling ancestor (see
 * the reserve effect). Without it the last fields of a form simply cannot be
 * scrolled into view: `.k-flow-body`'s scroll extent stops 24px past the last
 * element, so scrollIntoView clamps at max scroll and the field stays buried
 * (owner 2026-08-04 — the Email field on the kiosk sign-in NEW PLAYER form).
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

/**
 * Windows touch-keyboard suppression. Every field this OSK serves gets
 * inputmode="none" — Chromium's signal to NOT pop the OS virtual keyboard on
 * focus (the two were stacking on touch kiosks). A field's original inputmode
 * intent (numeric/tel/email) is preserved as data-osk-layout first so the
 * matching OSK layout still comes up. Untouched on purpose:
 *  - [data-osk="off"] fields (admin) — staff keep the Windows keyboard there;
 *  - the Square card iframe — cross-origin, and it deliberately relies on the
 *    Windows keyboard (see the header comment).
 */
const LAYOUT_FROM_INPUTMODE: Partial<Record<string, OskLayoutId>> = {
  numeric: "numeric",
  decimal: "numeric",
  tel: "phone",
  email: "email",
};

function suppressOsKeyboard(el: EditableEl) {
  const mode = (el.getAttribute("inputmode") ?? "").toLowerCase();
  if (mode === "none") return;
  const mapped = LAYOUT_FROM_INPUTMODE[mode];
  if (!el.dataset.oskLayout && mapped) el.dataset.oskLayout = mapped;
  el.setAttribute("inputmode", "none");
}

function stampSubtree(root: Document | HTMLElement) {
  if (root instanceof HTMLElement) {
    const self = eligible(root);
    if (self) suppressOsKeyboard(self);
  }
  root.querySelectorAll("input, textarea").forEach((el) => {
    const field = eligible(el);
    if (field) suppressOsKeyboard(field);
  });
}

/** Breathing room between the focused field and the top edge of the sheet. */
const OSK_SCROLL_GAP = 24;

/**
 * Nearest SCROLLING ancestor — the element whose bottom the sheet covers, and
 * therefore the one that has to grow.
 *
 * Deliberately NOT gated on "is it currently overflowing": a container that
 * fits today still has its bottom third occluded once the sheet opens, and
 * adding the reserve is exactly what makes it scrollable. Matching on computed
 * overflow (not on a class) is what makes this work on every typing surface —
 * `.k-flow-body`, the `fixed inset-0 overflow-y-auto` overlays (guardian form,
 * LicenseMatchPicker), the check-in and waiver flows — including ones written
 * after this code.
 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll") return node;
    node = node.parentElement;
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
  // Re-render after every keypress. Typing changes only the FIELD's state (the
  // host is a KioskShell sibling), so without this bump the host never
  // re-renders while a guest types and the focus-time smart-caps decision goes
  // stale inside the press closure — every letter of an empty field landed
  // UPPERCASE ("SEBASTIAN"), which per-keystroke formatting then half-fixed
  // into "SeBASTIAN" (owner 2026-07-21 caps bug).
  const [, setEditTick] = useState(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // After "Done", a transparent full-canvas shield briefly swallows the next tap
  // so it can't fall THROUGH to whatever sits under the (now-closing) keyboard —
  // e.g. the wizard's Continue button docked at the same bottom edge, which on
  // the returning-racer lookup was advancing the flow to the cart (owner
  // 2026-07-19). Timing-independent: works even for a slow/firm Done press.
  const [shield, setShield] = useState(false);
  const shieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The sheet itself — measured (not hardcoded) so the reserve tracks the real
  // rendered height, which differs per layout (4 rows numeric vs 5 qwerty).
  const sheetRef = useRef<HTMLDivElement>(null);

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
      // Scrolling the field into view happens in the reserve effect below —
      // AFTER the sheet's height has been reserved. Doing it here scrolled
      // against the old (short) extent and the browser clamped it.
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

  // RESERVE the sheet's height while it's open, then bring the field up.
  //
  //  - padding-bottom on the field's scrolling ancestor buys the scroll RANGE
  //    that lets a bottom-of-form field travel above the sheet at all;
  //  - scroll-padding-bottom tells that scroller where its visible region now
  //    ends, so `block: "center"` centers within the UNCOVERED part.
  //
  // Both are restored on close/unmount (cleanup also runs before each re-run,
  // so the computed base padding read below is never a value we ourselves
  // added — the reserve can't compound across fields).
  //
  // --k-osk-h is published on the canvas for screens that want to lay out
  // around the sheet. Do NOT feed it back into a scroll container's padding:
  // this effect already owns that, and the two would double up.
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!target || !sheet) return;
    const h = sheet.offsetHeight;
    const canvas = target.closest<HTMLElement>(".kiosk-canvas");
    canvas?.style.setProperty("--k-osk-h", `${h}px`);
    // Only the scroller the sheet actually overlaps needs the reserve — a short
    // inner list that ends above the keyboard is left alone. Both rects are in
    // screen space, so comparing them is valid even though the reserve itself
    // is written in canvas px.
    const found = scrollParent(target);
    const scroller =
      found && found.getBoundingClientRect().bottom > sheet.getBoundingClientRect().top + 1
        ? found
        : null;
    const prevPad = scroller?.style.paddingBottom ?? "";
    const prevScrollPad = scroller?.style.scrollPaddingBottom ?? "";
    if (scroller) {
      const basePad = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
      scroller.style.paddingBottom = `${basePad + h}px`;
      scroller.style.scrollPaddingBottom = `${h + OSK_SCROLL_GAP}px`;
    }
    // One frame for the new extent to lay out before scrolling into it.
    const id = setTimeout(() => target.scrollIntoView({ block: "center", behavior: "smooth" }), 50);
    return () => {
      clearTimeout(id);
      canvas?.style.removeProperty("--k-osk-h");
      if (scroller) {
        scroller.style.paddingBottom = prevPad;
        scroller.style.scrollPaddingBottom = prevScrollPad;
      }
    };
  }, [target, layout]);

  // Stamp inputmode="none" on every OSK-served field — existing DOM at mount,
  // then every field React adds later — so the Windows touch keyboard never
  // pops over this one. (React won't fight the stamp: it only rewrites an
  // attribute when the JSX prop itself changes between renders.)
  useEffect(() => {
    stampSubtree(document);
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n instanceof HTMLElement) stampSubtree(n);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

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
  // Smart-caps is for NAMES (qwerty) only. The email layout never capitalizes —
  // auto-capping the first letter was landing "John@…" in bookings, and emails
  // are normalized lowercase at capture anyway (owner 2026-07-19).
  // letterCase drives the KEY LABELS only — press() recomputes the actual
  // case per keypress so a stale render can never uppercase a whole word.
  const letterCase =
    layout === "qwerty"
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
    // Decide the case HERE, from the field's live value — never from the
    // render-time letterCase (that closure is only as fresh as the last
    // re-render; see setEditTick above).
    const caps = layout === "qwerty" && shouldCapitalize(target.value, start, shift);
    const literal = code.length === 1 && /[a-z]/.test(code) && caps ? code.toUpperCase() : code;
    const next = applyOskKey(target.value, start, end, literal);
    setNativeValue(target, next.value, next.caret);
    if (shift && code !== OSK_BACKSPACE) setShift(false);
    setEditTick((t) => t + 1);
  };

  return (
    <div
      ref={sheetRef}
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
