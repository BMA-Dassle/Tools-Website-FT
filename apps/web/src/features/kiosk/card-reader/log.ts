/**
 * TX/RX log ring for the admin test panel — pure, no DOM.
 * Subscribes cleanly to useSyncExternalStore (stable snapshot identity).
 */
import type { EngineLogEvent } from "./engine/protocol-engine";

export interface LogEntry extends EngineLogEvent {
  id: number;
}

export function hexDump(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

export class LogRing {
  private readonly capacity: number;
  private entries: LogEntry[] = [];
  private nextId = 1;
  private listeners = new Set<() => void>();
  private snapshotCache: readonly LogEntry[] = [];
  private flushScheduled = false;

  constructor(capacity = 300) {
    this.capacity = capacity;
  }

  /**
   * Publish the current entries to subscribers, at most once per scheduled
   * tick. The snapshot is rebuilt HERE (not lazily in snapshot()) so the value
   * only advances together with a notification — useSyncExternalStore never sees
   * a changed snapshot without a matching subscribe callback (no tearing).
   */
  private flush = (): void => {
    this.flushScheduled = false;
    this.snapshotCache = this.entries.slice();
    for (const cb of this.listeners) cb();
  };

  /**
   * Coalesce bursts: a wrong-baud probe (or line noise) can emit hundreds of
   * frame/garbage events in a tick. Notifying React synchronously on each one
   * re-renders the whole admin panel per byte and FREEZES the tab the moment the
   * COM device connects. Batching to ~one notify per 40ms tick makes a flood
   * survivable while keeping the live log responsive. (Owner 2026-07-19: admin
   * froze as soon as the COM device connected.)
   */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(this.flush, 40);
  }

  push(e: EngineLogEvent): void {
    this.entries.push({ ...e, id: this.nextId++ });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.scheduleFlush();
  }

  clear(): void {
    this.entries = [];
    this.snapshotCache = [];
    this.flushScheduled = false;
    for (const cb of this.listeners) cb();
  }

  /** Newest-last; identity stable between flushes. */
  snapshot(): readonly LogEntry[] {
    return this.snapshotCache;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
