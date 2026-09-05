"use client";

/**
 * Per-person "is this guest on the on-site server yet?" — the read that greys
 * the Membership / Comp chips (owner 2026-09-04: "just disable the buttons if
 * it's not local yet").
 *
 * A tiny module cache keyed by the id we would WRITE with, read through
 * useSyncExternalStore: every card asks once, a re-render is free, and an
 * answer is trusted for TTL_MS before the next look. `recheck` drops the cache
 * for one person so staff can tap the hint after the sync has had a minute.
 * Cleared whenever staff mode ends — a stale "local" from the last manager must
 * not carry into the next.
 */
import { useEffect, useSyncExternalStore } from "react";
import { fetchPersonLocal } from "./client";
import { onStaffModeEnd, useStaffMode } from "./store";
import type { StaffLocation, StaffSheetKind } from "./types";

export type LocalStatus = "checking" | "local" | "not-local" | "unknown";

const TTL_MS = 60_000;

const cache = new Map<string, { status: LocalStatus; at: number }>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
const key = (location: StaffLocation, personId: string) => `${location}:${personId}`;

function read(location: StaffLocation, personId: string): LocalStatus | null {
  const hit = cache.get(key(location, personId));
  if (!hit) return null;
  if (hit.status !== "checking" && Date.now() - hit.at > TTL_MS) return null;
  return hit.status;
}

async function probe(token: string, location: StaffLocation, personId: string): Promise<void> {
  const k = key(location, personId);
  if (inflight.has(k)) return;
  inflight.add(k);
  cache.set(k, { status: "checking", at: Date.now() });
  emit();
  try {
    const local = await fetchPersonLocal(token, personId, location);
    cache.set(k, {
      status: local === true ? "local" : local === false ? "not-local" : "unknown",
      at: Date.now(),
    });
  } finally {
    inflight.delete(k);
    emit();
  }
}

/** Forget one answer so the next render asks again. */
export function recheckPersonLocal(location: StaffLocation, personId: string): void {
  cache.delete(key(location, personId));
  emit();
}

/** Forget everything — staff mode ended. */
export function clearLocalStatus(): void {
  cache.clear();
  emit();
}
onStaffModeEnd(clearLocalStatus);

/**
 * The status for one person, probing on demand. `personId` null (no account
 * yet) → "not-local" without a network call: a person with no BMI id cannot
 * be on any server.
 */
export function usePersonLocal(location: StaffLocation, personId: string | null): LocalStatus {
  const { token, active } = useStaffMode();
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (personId ? read(location, personId) : "not-local"),
    () => "checking" as LocalStatus,
  );
  useEffect(() => {
    if (!active || !personId || !token) return;
    if (read(location, personId) === null) void probe(token, location, personId);
  }, [active, token, location, personId, snapshot]);
  if (!personId) return "not-local";
  return snapshot ?? "checking";
}

/** PURE: may this chip be tapped? Membership and Comp write to the local server
 *  and need a local person; Race history reads the cloud and needs only an
 *  account. */
export function staffActionEnabled(
  kind: StaffSheetKind,
  hasAccount: boolean,
  status: LocalStatus,
): boolean {
  if (!hasAccount) return false;
  if (kind === "history") return true;
  return status === "local";
}

/** PURE: the one-line reason shown beside disabled chips, or null when nothing
 *  is disabled for a reason worth stating. */
export function staffActionHint(hasAccount: boolean, status: LocalStatus): string | null {
  if (!hasAccount) return "Finish sign-in first — no account yet";
  switch (status) {
    case "checking":
      return "Checking on-site sync…";
    case "not-local":
      return "Not on the on-site server yet — tap to re-check";
    case "unknown":
      return "Couldn't check on-site sync — tap to re-check";
    case "local":
      return null;
  }
}
