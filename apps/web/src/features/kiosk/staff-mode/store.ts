/**
 * Staff-mode store — ONE per browser tab, module-level, read through
 * useSyncExternalStore (the same tiny-external-store idiom config.ts uses).
 *
 * WHAT IT HOLDS. The employee a staff card resolved to, the signed token the
 * actions route wants back, when the kiosk was last touched, and which staff
 * sheet (if any) is open. NEVER persisted: a reload ends staff mode, which is
 * the safe direction for a credential on a machine guests stand at.
 *
 * THE 10-SECOND RULE (owner 2026-09-04): "active for 10 seconds and it resets
 * when the kiosk is used". Arming or any pointerdown/keydown on the document
 * stamps `lastTouchAt`; STAFF_IDLE_MS after the last stamp, staff mode ends by
 * itself. The listeners use the capture phase on `document`, exactly like
 * IdleWatcher, so a tap anywhere counts even when a handler stops propagation.
 * While a staff sheet is open the clock is PAUSED — a sheet is the kiosk being
 * used, and a form that closes itself mid-type would be worse than a bar that
 * lingers — and closing the sheet counts as a touch.
 *
 * Staff logout, idle expiry and the page's own teardown all call `end()`; the
 * guest session is never touched by any of them.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { StaffEmployee, StaffSheetKind, StaffTarget } from "./types";

export const STAFF_IDLE_MS = 10_000;
/** How long a "card isn't linked" / "Added …" notice stays up. */
const NOTICE_MS = 4_000;

export interface StaffSheet {
  kind: StaffSheetKind;
  target: StaffTarget;
}

interface StaffNotice {
  text: string;
  tone: "ok" | "warn";
  at: number;
}

interface StaffState {
  employee: StaffEmployee | null;
  token: string;
  lastTouchAt: number;
  sheet: StaffSheet | null;
  notice: StaffNotice | null;
}

const INACTIVE: StaffState = {
  employee: null,
  token: "",
  lastTouchAt: 0,
  sheet: null,
  notice: null,
};

let state: StaffState = INACTIVE;
/** Side modules (local-status cache) register here to reset with staff mode —
 *  the store must not import them, or the two would import each other. */
const onEndHooks = new Set<() => void>();
export function onStaffModeEnd(fn: () => void): () => void {
  onEndHooks.add(fn);
  return () => void onEndHooks.delete(fn);
}
const listeners = new Set<() => void>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function emit() {
  for (const l of listeners) l();
}

function set(patch: Partial<StaffState>) {
  state = { ...state, ...patch };
  emit();
}

function clearIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

/** (Re)start the idle clock — unless a sheet is open, which pauses it. */
function armIdleTimer() {
  clearIdleTimer();
  if (!state.employee || state.sheet) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    endStaffMode();
  }, STAFF_IDLE_MS);
}

function onActivity() {
  if (!state.employee) return;
  touchStaffMode();
}

function startListening() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("pointerdown", onActivity, { passive: true, capture: true });
  document.addEventListener("keydown", onActivity, { passive: true, capture: true });
}

function stopListening() {
  if (!listening || typeof document === "undefined") return;
  listening = false;
  document.removeEventListener("pointerdown", onActivity, { capture: true });
  document.removeEventListener("keydown", onActivity, { capture: true });
}

/** A resolved staff card: staff mode ON for this employee. Re-arming while
 *  already on (a second scan) just refreshes the token and the clock. */
export function armStaffMode(employee: StaffEmployee, token: string): void {
  set({ employee, token, lastTouchAt: Date.now(), sheet: null });
  startListening();
  armIdleTimer();
}

/** The kiosk was used — refill the idle window. */
export function touchStaffMode(): void {
  if (!state.employee) return;
  set({ lastTouchAt: Date.now() });
  armIdleTimer();
}

/** Staff logout / idle expiry / page teardown. Idempotent. Also drops the
 *  per-person on-site answers (local-status.ts) — the next manager re-asks. */
export function endStaffMode(): void {
  clearIdleTimer();
  stopListening();
  onEndHooks.forEach((fn) => fn());
  if (state.employee || state.sheet || state.token) {
    set({ employee: null, token: "", lastTouchAt: 0, sheet: null });
  }
}

export function openStaffSheet(sheet: StaffSheet): void {
  if (!state.employee) return;
  set({ sheet, lastTouchAt: Date.now() });
  clearIdleTimer(); // paused while open
}

export function closeStaffSheet(): void {
  if (!state.sheet) return;
  set({ sheet: null, lastTouchAt: Date.now() });
  armIdleTimer();
}

/** A brief line under the bar — "Added License Fee for Maya", "Card ····3464
 *  isn't linked to an employee". Shows whether or not staff mode is on. */
export function setStaffNotice(text: string, tone: "ok" | "warn" = "ok"): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  set({ notice: { text, tone, at: Date.now() } });
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    set({ notice: null });
  }, NOTICE_MS);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

const getSnapshot = () => state;
const getServerSnapshot = () => INACTIVE;

export interface StaffModeView {
  active: boolean;
  employee: StaffEmployee | null;
  token: string;
  sheet: StaffSheet | null;
  notice: StaffNotice | null;
}

export function useStaffMode(): StaffModeView {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    active: !!s.employee,
    employee: s.employee,
    token: s.token,
    sheet: s.sheet,
    notice: s.notice,
  };
}

/**
 * Whole seconds left on the idle clock, or null when staff mode is off or the
 * clock is paused (a sheet is open). Ticks four times a second so the ring
 * never looks stuck at a boundary.
 */
export function useStaffCountdown(): number | null {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const running = !!s.employee && !s.sheet;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, [running]);
  if (!running) return null;
  const left = s.lastTouchAt + STAFF_IDLE_MS - Math.max(now, s.lastTouchAt);
  return Math.max(0, Math.ceil(left / 1000));
}

/** Test seam — drop every listener/timer and return to INACTIVE. */
export function _resetStaffModeForTests(): void {
  clearIdleTimer();
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  stopListening();
  state = INACTIVE;
  emit();
}

/** Test seam — the raw state. */
export function _peekStaffMode(): StaffState {
  return state;
}
