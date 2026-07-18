/**
 * Scripted fake ByteTransport — TESTS ONLY. Records every host write and
 * lets the test push device bytes (in arbitrary chunkings) at will.
 */
import type { ByteTransport } from "../transport/types";

export class FakeTransport implements ByteTransport {
  isOpen = true;
  /** Every write() payload, in order. */
  writes: Uint8Array[] = [];
  /** Optional hook — script an automatic device reply per host write. */
  onWrite: ((bytes: Uint8Array) => void) | null = null;

  private byteListeners = new Set<(chunk: Uint8Array) => void>();
  private closeListeners = new Set<(reason: string | null) => void>();

  write(bytes: Uint8Array): Promise<void> {
    if (!this.isOpen) return Promise.reject(new Error("transport closed"));
    this.writes.push(Uint8Array.from(bytes));
    this.onWrite?.(bytes);
    return Promise.resolve();
  }

  onBytes(cb: (chunk: Uint8Array) => void): () => void {
    this.byteListeners.add(cb);
    return () => this.byteListeners.delete(cb);
  }

  onClose(cb: (reason: string | null) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  /** Device → host bytes. */
  receive(bytes: Uint8Array | number[]): void {
    const chunk = Uint8Array.from(bytes);
    for (const cb of this.byteListeners) cb(chunk);
  }

  /** Simulate a USB yank / device-side close. */
  die(reason: string): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    for (const cb of this.closeListeners) cb(reason);
  }

  close(): Promise<void> {
    if (this.isOpen) {
      this.isOpen = false;
      for (const cb of this.closeListeners) cb(null);
    }
    return Promise.resolve();
  }
}
