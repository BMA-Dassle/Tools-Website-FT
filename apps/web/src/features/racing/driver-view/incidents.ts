/**
 * Grouping crash triggers into one incident, and naming which kart tripped first.
 *
 * WHAT THE DATA SUPPORTS (measured over 32h of real traffic, 2026-09-05):
 * 1,319 crash events, 1,316 of them stamped to the millisecond across 690
 * distinct sub-second values. Clustered at a 4s gap they form 605 incidents, of
 * which 176 involve more than one kart — and in every single one the first kart
 * is unambiguous. Min gap between the first and second kart 62ms, median 1,425ms,
 * **zero ties**. Ordering is not the hard part.
 *
 * WHAT THE DATA DOES NOT SUPPORT — AND THIS IS THE WHOLE POINT: first is not
 * guilty. Crash detect fires on impact, so a kart that is rear-ended trips it
 * first and the kart that hit it trips second. A real cascade from the log:
 *
 *     20:23:11  kart 6 +0ms -> 28 +328ms -> 10 +1375ms -> 1 +7656ms
 *               -> 11 +8736ms -> 33 +16412ms
 *
 * Kart 6 was first. Kart 6 may equally have been the one hit. And by +16s the
 * cluster is no longer one collision — it is other drivers arriving at a corner
 * that is already blocked.
 *
 * SO: this is an OPS tool, never a guest-facing one. `firstKart` is "who tripped
 * first", which is a lead for a marshal and a cue for pulling camera footage. It
 * is NEVER rendered to a driver as fault. Telling a guest "kart 11 caused this"
 * would be wrong often enough to start arguments at the desk that we could not
 * win, because we cannot see the contact — only the accelerometers.
 *
 * PURE. Feed it rows; it has no idea where they came from.
 */
import type { KartNumber } from "./types";

export interface CrashTrigger {
  kart: KartNumber;
  /** Epoch ms of the venue's own stamp. */
  atMs: number;
  eventId: string;
  sessionId: string | null;
}

export interface Incident {
  /** When the first kart tripped. */
  startedAtMs: number;
  /** The kart that tripped first. A LEAD, not a verdict — see the file note. */
  firstKart: KartNumber;
  /** Every kart involved, in trip order, first occurrence only. */
  karts: KartNumber[];
  /** Per kart, how long after the first trigger it fired. */
  offsetsMs: Record<KartNumber, number>;
  /** Gap between the first kart and the next DIFFERENT one. Null when alone. */
  leadMs: number | null;
  sessionId: string | null;
  /** Every trigger in the incident, ordered. */
  triggers: CrashTrigger[];
}

/**
 * How close two triggers must be to belong to the same incident.
 *
 * 4s matches the measurement above and is deliberately generous — it captures
 * the cascade, which is what a marshal wants to see. For "was this one actual
 * collision", pass something near 750ms: at that width the pairs that survive
 * (kart 28 -> 11 at +172ms, kart 28 -> 22 at +141ms) really do look like contact.
 */
export const DEFAULT_CLUSTER_GAP_MS = 4000;

/**
 * A single kart tripping repeatedly inside one incident is one kart, not several
 * — the venue re-fires crash detect while a kart sits stopped, and kart 15's own
 * log shows Crash/UnCrash alternating every second or two.
 */
export function clusterCrashes(
  triggers: readonly CrashTrigger[],
  gapMs: number = DEFAULT_CLUSTER_GAP_MS,
): Incident[] {
  const sorted = [...triggers].sort(
    (a, b) => a.atMs - b.atMs || a.eventId.localeCompare(b.eventId),
  );
  const out: Incident[] = [];
  let current: CrashTrigger[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const startedAtMs = current[0].atMs;
    const karts: KartNumber[] = [];
    const offsetsMs: Record<KartNumber, number> = {};
    for (const t of current) {
      if (offsetsMs[t.kart] === undefined) {
        offsetsMs[t.kart] = t.atMs - startedAtMs;
        karts.push(t.kart);
      }
    }
    const firstKart = karts[0];
    const second = karts.find((k) => k !== firstKart);
    out.push({
      startedAtMs,
      firstKart,
      karts,
      offsetsMs,
      leadMs: second === undefined ? null : offsetsMs[second],
      sessionId: current.find((t) => t.sessionId !== null)?.sessionId ?? null,
      triggers: current,
    });
    current = [];
  };

  for (const t of sorted) {
    if (current.length > 0 && t.atMs - current[current.length - 1].atMs > gapMs) flush();
    current.push(t);
  }
  flush();
  return out;
}

/**
 * How much weight to put on "first" for one incident.
 *
 * A lead measured in tens of milliseconds is two karts in the same collision and
 * says almost nothing about order of blame. A lead of a second or more means the
 * second kart arrived at something already happening. Neither is fault; this only
 * tells a marshal how much the ordering is worth reading.
 */
export function leadConfidence(incident: Incident): "alone" | "simultaneous" | "sequential" {
  if (incident.leadMs === null) return "alone";
  return incident.leadMs < 400 ? "simultaneous" : "sequential";
}
