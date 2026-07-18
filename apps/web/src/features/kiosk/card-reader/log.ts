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
  private dirty = false;

  constructor(capacity = 300) {
    this.capacity = capacity;
  }

  push(e: EngineLogEvent): void {
    this.entries.push({ ...e, id: this.nextId++ });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.dirty = true;
    for (const cb of this.listeners) cb();
  }

  clear(): void {
    this.entries = [];
    this.dirty = true;
    for (const cb of this.listeners) cb();
  }

  /** Newest-last; identity stable between mutations. */
  snapshot(): readonly LogEntry[] {
    if (this.dirty) {
      this.snapshotCache = [...this.entries];
      this.dirty = false;
    }
    return this.snapshotCache;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
