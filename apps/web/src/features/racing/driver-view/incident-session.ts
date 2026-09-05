/**
 * ONE CRASH IS ONE INCIDENT, however many karts it touches and however many
 * times the venue re-announces it.
 *
 * WHAT WENT WRONG (measured 2026-09-05, first night of ingest): `kart_event`
 * held **8,615 caution rows** — one session alone had 2,239 across nine karts —
 * because a single `CrashNotification` was fanned out to every kart in the
 * heat, and the venue RE-FIRES crash detect every second or two for as long as
 * a kart sits stopped. N karts × M re-fires. The public race history printed
 * every one of them.
 *
 * THE RULE (owner 2026-09-05): "when a crash is detected that should be treated
 * as a crash till all karts have cleared and it's one yellow flag."
 *
 * So a session holds at most ONE open incident. The first crash opens it and is
 * the only thing written down. Every later crash — another kart, or the same
 * kart re-firing — JOINS it and writes nothing. The incident stays open until
 * every kart in it has cleared (`UnCrash`), and closing it is what lifts the
 * yellow.
 *
 * PURE. The reducer is the whole rule; `incident-session.server.ts` is the thin
 * Redis wrapper around it, so the behaviour can be tested without a race.
 */

export interface IncidentState {
  /** Stable id — the venue record id of the crash that opened it. Used as the
   *  primary key of the single stored row, so replays are idempotent. */
  id: string;
  sessionId: string;
  startedAtMs: number;
  /** Last time anything about it moved, for the stale sweep below. */
  lastAtMs: number;
  /** Every kart that has crashed in this incident, in order. */
  karts: string[];
  /** Those that have not yet cleared. Empty means the track is clean. */
  open: string[];
}

export interface JoinResult {
  state: IncidentState;
  /** True only for the crash that OPENED the incident — the one that gets
   *  written down and the one that raises the yellow. */
  isNew: boolean;
  /** True when this kart had not crashed in this incident before. Its own
   *  crash takeover is worth showing even if the yellow is already up. */
  isNewKart: boolean;
}

/**
 * How long an incident can go untouched before a fresh crash counts as a NEW
 * one rather than a continuation.
 *
 * Generous, because the cost of splitting one incident in two is a duplicate
 * yellow — the exact thing this exists to stop — while the cost of merging two
 * genuinely separate spins is one missing line in a history. Re-fires arrive
 * every second or two, so any real continuation refreshes this constantly.
 */
export const INCIDENT_IDLE_MS = 90_000;

export function joinIncident(
  prev: IncidentState | null,
  args: { sessionId: string; kart: string; atMs: number; eventId: string },
): JoinResult {
  const { sessionId, kart, atMs, eventId } = args;

  const stale =
    prev === null ||
    prev.sessionId !== sessionId ||
    atMs - prev.lastAtMs > INCIDENT_IDLE_MS ||
    // Everyone cleared: the next crash is a new incident, not a resurrection.
    prev.open.length === 0;

  if (stale) {
    return {
      state: {
        id: eventId,
        sessionId,
        startedAtMs: atMs,
        lastAtMs: atMs,
        karts: [kart],
        open: [kart],
      },
      isNew: true,
      isNewKart: true,
    };
  }

  const isNewKart = !prev.karts.includes(kart);
  return {
    state: {
      ...prev,
      lastAtMs: Math.max(prev.lastAtMs, atMs),
      karts: isNewKart ? [...prev.karts, kart] : prev.karts,
      open: prev.open.includes(kart) ? prev.open : [...prev.open, kart],
    },
    isNew: false,
    isNewKart,
  };
}

export interface ClearResult {
  state: IncidentState | null;
  /** True on the clear that emptied it — the moment the yellow comes down. */
  closed: boolean;
}

/** One kart has recovered. The incident survives until they all have. */
export function clearKart(
  prev: IncidentState | null,
  args: { sessionId: string; kart: string; atMs: number },
): ClearResult {
  if (prev === null || prev.sessionId !== args.sessionId) return { state: prev, closed: false };
  if (!prev.open.includes(args.kart)) return { state: prev, closed: false };

  const open = prev.open.filter((k) => k !== args.kart);
  const state: IncidentState = {
    ...prev,
    lastAtMs: Math.max(prev.lastAtMs, args.atMs),
    open,
  };
  return { state, closed: open.length === 0 };
}

/**
 * A safety valve for the clear that never comes.
 *
 * A kart towed off, a marshal resetting it by hand, a missed `UnCrash` — any of
 * those would otherwise leave a yellow standing over a clean track for the rest
 * of the night. Past the idle window the incident is treated as closed.
 */
export function isStale(state: IncidentState | null, nowMs: number): boolean {
  return state !== null && nowMs - state.lastAtMs > INCIDENT_IDLE_MS;
}
