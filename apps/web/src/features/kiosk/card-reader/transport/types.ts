/**
 * Byte-level transport seam. Production: Web Serial (serial-transport.ts).
 * Tests: the scripted fake in engine/fake-transport.ts.
 */
export interface ByteTransport {
  readonly isOpen: boolean;
  write(bytes: Uint8Array): Promise<void>;
  /** Subscribe to raw inbound chunks (arbitrary split/merge). */
  onBytes(cb: (chunk: Uint8Array) => void): () => void;
  /** Fired once when the transport dies (close, USB unplug, read error). */
  onClose(cb: (reason: string | null) => void): () => void;
  close(): Promise<void>;
}
