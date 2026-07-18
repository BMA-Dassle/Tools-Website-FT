/**
 * Web Serial adapter for the CRT-591 — binary flavor of the house pattern in
 * app/admin/[token]/checkin/CheckInClient.tsx (which is text/line oriented).
 *
 * Always 8N1 no-flow-control (spec 1.1.1). The close sequence fully releases
 * both stream locks so the SAME port can be re-opened at a different baud —
 * that's what the client's auto-baud probe does between attempts.
 */
import type { ByteTransport } from "./types";

/** A stalled serial driver can hang open/close forever — bound every step. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out ${what} after ${Math.round(ms / 1000)}s — the port may be held by another program (vendor tool?) or the USB-serial driver is stalled. Close other software using the port, or unplug/replug the adapter.`,
          ),
        ),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Race a cleanup step against a deadline; never throw — teardown must finish. */
async function bounded(step: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([step.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
}

export async function openSerialTransport(
  port: SerialPort,
  options: { baudRate: number },
): Promise<ByteTransport> {
  await withTimeout(
    port.open({
      baudRate: options.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    }),
    5_000,
    "opening the serial port",
  );

  if (!port.readable || !port.writable) {
    await port.close().catch(() => undefined);
    throw new Error("Serial port opened without readable/writable streams");
  }

  const writer = port.writable.getWriter();

  const byteListeners = new Set<(chunk: Uint8Array) => void>();
  const closeListeners = new Set<(reason: string | null) => void>();
  let open = true;
  let closing = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const fireClose = (reason: string | null) => {
    if (!open) return;
    open = false;
    for (const cb of closeListeners) cb(reason);
    closeListeners.clear();
    byteListeners.clear();
  };

  // Read pump. A serial framing/parity/overflow error errors the CURRENT
  // readable stream but does NOT close the port — the correct Web Serial
  // recovery is to release the reader and acquire a new one from
  // port.readable, then keep going. Only a truly gone port (readable === null)
  // or a deliberate close() ends the pump. This keeps line noise, a wrong-baud
  // probe, or a device hiccup from tearing down the whole connection.
  void (async () => {
    let reason: string | null = null;
    while (!closing) {
      const readable = port.readable;
      if (!readable) break; // port physically gone
      const reader = readable.getReader();
      activeReader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break; // stream closed (cancel or normal end)
          if (value && value.length) for (const cb of byteListeners) cb(value);
        }
        break; // done === true → normal end / cancelled
      } catch (err) {
        // Recoverable stream error (framing/parity/overflow): loop re-acquires
        // a reader. If the port is gone, the while-loop's readable check ends it.
        reason = err instanceof Error ? err.message : String(err);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released by cancel() */
        }
        if (activeReader === reader) activeReader = null;
      }
      if (closing || !port.readable) break;
      // brief yield so a hard, immediately-repeating error can't hot-loop
      await new Promise((r) => setTimeout(r, 50));
    }
    fireClose(closing ? null : reason);
  })();

  return {
    get isOpen() {
      return open;
    },
    async write(bytes: Uint8Array) {
      if (!open) throw new Error("serial transport is closed");
      await writer.write(bytes);
    },
    onBytes(cb) {
      byteListeners.add(cb);
      return () => byteListeners.delete(cb);
    },
    onClose(cb) {
      if (!open) {
        cb(null);
        return () => undefined;
      }
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
    async close() {
      if (closing) return;
      closing = true;
      // Cancel the reader (ends the pump), release both locks, close the port.
      // Every step is deadline-bounded: a write stuck in a stalled driver
      // would otherwise hang forever and freeze the auto-baud probe.
      if (activeReader) await bounded(activeReader.cancel(), 2_000);
      await bounded(writer.abort(), 1_500);
      try {
        writer.releaseLock();
      } catch {
        /* already released */
      }
      await bounded(port.close(), 3_000);
      fireClose(null);
    },
  };
}
