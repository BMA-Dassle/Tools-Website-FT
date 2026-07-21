/**
 * Kiosk-side client for the mobile-join session — a tiny module store (the
 * config.ts store pattern) so BOTH the people step (QR panel, poll) and
 * KioskFlow (continue-confirm sheet, idle pause, start-over cleanup) read the
 * same live snapshot via useSyncExternalStore.
 *
 * Lives in module memory ON PURPOSE — never persisted: a kiosk reload starts
 * a fresh code and the orphaned session dies by server TTL when polls stop.
 */
import type { JoinBrand, JoinCenter, JoinStepKind, JoinedGuest } from "./types";

export type MobileJoinCloseReason = "continued" | "start-over" | "idle" | "done";

export interface MobileJoinSnapshot {
  status: "idle" | "opening" | "open" | "closed" | "error";
  code: string | null;
  joinUrl: string | null;
  /** Phones with a fresh heartbeat (includes ones that already finished). */
  activeClients: number;
  /** Phones mid-sign-in — drives the "continuing will cancel" warning. */
  inProgressClients: number;
}

const IDLE_SNAPSHOT: MobileJoinSnapshot = {
  status: "idle",
  code: null,
  joinUrl: null,
  activeClients: 0,
  inProgressClients: 0,
};

let snapshot: MobileJoinSnapshot = IDLE_SNAPSHOT;
/** True when no session is live locally — makes closeMobileJoin idempotent. */
let closed = true;
/** Guards against a stale create response landing after a close/re-open. */
let openSeq = 0;
/** Consecutive poll failures — the panel goes muted at 5, self-heals on success. */
let failStreak = 0;

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const setSnapshot = (patch: Partial<MobileJoinSnapshot>) => {
  snapshot = { ...snapshot, ...patch };
  notify();
};

export function subscribeMobileJoin(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMobileJoinSnapshot(): MobileJoinSnapshot {
  return snapshot;
}

/** SSR snapshot for useSyncExternalStore. */
export function serverMobileJoinSnapshot(): MobileJoinSnapshot {
  return IDLE_SNAPSHOT;
}

export interface OpenMobileJoinArgs {
  kioskId: string;
  center: JoinCenter;
  brand: JoinBrand;
  stepKind: JoinStepKind;
}

const DEVICE_NONCE_KEY = "kiosk_join_device";
const newNonce = () => (Math.random().toString(36).slice(2) + "00000000").slice(0, 8);
const memoryNonce = newNonce();

/**
 * Scope the server's one-session-per-kiosk supersede rule to this DEVICE.
 * kioskNumber is honor-system config — two devices configured (or defaulted)
 * to the same number would otherwise retire each other's live QR every time
 * both sit on a people step (seen live 2026-07-20 as codes "expiring" within
 * seconds). localStorage keeps the suffix stable across reloads so a reloaded
 * kiosk still instantly supersedes its own stale QR; a storage-less webview
 * falls back to a per-load id and stale sessions die by the 300s TTL instead.
 */
function deviceScopedKioskId(kioskId: string): string {
  let nonce: string;
  try {
    const stored = window.localStorage.getItem(DEVICE_NONCE_KEY);
    if (stored && /^[a-z0-9]{4,16}$/.test(stored)) {
      nonce = stored;
    } else {
      nonce = newNonce();
      window.localStorage.setItem(DEVICE_NONCE_KEY, nonce);
    }
  } catch {
    nonce = memoryNonce;
  }
  return `${kioskId}~${nonce}`;
}

/** Open a fresh join session. Always a NEW code — the server supersedes any
 *  prior session for this device, so stale QRs die cleanly. */
export async function openMobileJoin(args: OpenMobileJoinArgs): Promise<void> {
  const seq = ++openSeq;
  closed = false;
  failStreak = 0;
  snapshot = { ...IDLE_SNAPSHOT, status: "opening" };
  notify();
  try {
    const res = await fetch("/api/kiosk/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...args, kioskId: deviceScopedKioskId(args.kioskId) }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`create failed (${res.status})`);
    const data = (await res.json()) as { code: string; joinUrl: string };
    if (seq !== openSeq || closed) {
      // A close or newer open raced this create — retire the session we
      // just made so no live QR points at it.
      sendClose(data.code, "done");
      return;
    }
    setSnapshot({ status: "open", code: data.code, joinUrl: data.joinUrl });
  } catch {
    if (seq === openSeq && !closed) setSnapshot({ status: "error" });
  }
}

/**
 * One poll tick. Returns the CUMULATIVE joined-guest list (the hook dedupes
 * deliveries by joinId). Never throws; transient failures keep the last
 * snapshot and only flip to "error" after 5 in a row — a later success
 * self-heals back to "open". An authoritative closed/404 marks the session
 * closed locally WITHOUT auto-recreating (the panel offers "Get a new code").
 */
export async function pollMobileJoin(): Promise<JoinedGuest[]> {
  const code = snapshot.code;
  if (closed || !code || snapshot.status === "closed") return [];
  try {
    const res = await fetch(`/api/kiosk/join/${code}`, { cache: "no-store" });
    if (res.status === 404) {
      closed = true;
      setSnapshot({ status: "closed", activeClients: 0, inProgressClients: 0 });
      return [];
    }
    if (!res.ok) throw new Error(`poll ${res.status}`);
    const data = (await res.json()) as
      | { status: "open"; guests: JoinedGuest[]; clients: { active: number; inProgress: number } }
      | { status: "closed" };
    failStreak = 0;
    if (data.status === "closed") {
      closed = true;
      setSnapshot({ status: "closed", activeClients: 0, inProgressClients: 0 });
      return [];
    }
    setSnapshot({
      status: "open",
      activeClients: data.clients.active,
      inProgressClients: data.clients.inProgress,
    });
    return data.guests;
  } catch {
    failStreak += 1;
    if (failStreak >= 5 && snapshot.status === "open") setSnapshot({ status: "error" });
    return [];
  }
}

/**
 * THE close funnel — every kiosk exit path lands here (Continue-confirmed,
 * step unmount, start over, idle reset). Idempotent: the first reason wins,
 * later calls no-op. Fire-and-forget with keepalive so the POST survives the
 * one hard-reload path (resetToKiosk self-update).
 */
export function closeMobileJoin(reason: MobileJoinCloseReason): void {
  if (closed) return;
  closed = true;
  const code = snapshot.code;
  setSnapshot({ status: "closed", activeClients: 0, inProgressClients: 0 });
  if (code) sendClose(code, reason);
}

function sendClose(code: string, reason: MobileJoinCloseReason): void {
  void fetch(`/api/kiosk/join/${code}/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
    keepalive: true,
  }).catch(() => {});
}
