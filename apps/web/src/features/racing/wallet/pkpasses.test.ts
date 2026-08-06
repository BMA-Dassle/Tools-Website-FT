/**
 * A hand-rolled ZIP is only worth avoiding a dependency for if it is actually a
 * valid ZIP. These read the bytes back with Node's own unzipper-adjacent
 * primitives and assert the structure Apple's multi-pass format needs.
 *
 * The failure this guards against is silent: a malformed central directory
 * still "downloads fine" and only fails on the phone, which is the same class
 * of bug as a pass whose barcode renders `missing: meta.code`.
 */
import { describe, it, expect } from "vitest";
import { crc32 } from "node:zlib";
import {
  buildPkpassesBundle,
  fetchPkpass,
  looksLikePkpass,
  PKPASSES_CONTENT_TYPE,
} from "./pkpasses";

const bytes = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));

/** Minimal reader — walks the central directory the way a real unzipper does. */
function readCentralDirectory(buf: Buffer) {
  // End-of-central-directory is the last 22 bytes when there is no comment.
  const eocdOffset = buf.length - 22;
  expect(buf.readUInt32LE(eocdOffset)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const files: { name: string; crc: number; size: number; localOffset: number }[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    // STORED. Re-compressing a .pkpass (already a compressed zip) would be
    // wasted CPU on every tap.
    expect(method).toBe(0);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    files.push({ name, crc, size, localOffset });
    p += 46 + nameLen;
  }
  expect(p - cdOffset).toBe(cdSize);
  return files;
}

describe("buildPkpassesBundle", () => {
  const a = { name: "409523.pkpass", bytes: bytes("PASS-ONE-CONTENT") };
  const b = { name: "63000000000021716.pkpass", bytes: bytes("PASS-TWO-DIFFERENT-LENGTH") };

  it("writes a readable central directory with every entry", () => {
    const files = readCentralDirectory(buildPkpassesBundle([a, b]));
    expect(files.map((f) => f.name)).toEqual([a.name, b.name]);
  });

  it("stores each pass byte-for-byte — a re-packed pass loses its signature", () => {
    const buf = buildPkpassesBundle([a, b]);
    const files = readCentralDirectory(buf);

    for (const [i, entry] of [a, b].entries()) {
      const f = files[i];
      expect(f.size).toBe(entry.bytes.length);
      expect(f.crc >>> 0).toBe(crc32(Buffer.from(entry.bytes)) >>> 0);

      // Walk the local header and compare the payload itself.
      const lh = f.localOffset;
      expect(buf.readUInt32LE(lh)).toBe(0x04034b50);
      const nameLen = buf.readUInt16LE(lh + 26);
      const extraLen = buf.readUInt16LE(lh + 28);
      const start = lh + 30 + nameLen + extraLen;
      expect(buf.subarray(start, start + f.size).equals(Buffer.from(entry.bytes))).toBe(true);
    }
  });

  it("is deterministic — same passes, identical bytes", () => {
    // Fixed DOS timestamps, so a diff between two bundles means a real change.
    expect(buildPkpassesBundle([a, b]).equals(buildPkpassesBundle([a, b]))).toBe(true);
  });

  it("handles a single pass and a large party", () => {
    expect(readCentralDirectory(buildPkpassesBundle([a]))).toHaveLength(1);
    const many = Array.from({ length: 8 }, (_, i) => ({
      name: `racer-${i}.pkpass`,
      bytes: bytes(`CONTENT-${i}`.repeat(i + 1)),
    }));
    const files = readCentralDirectory(buildPkpassesBundle(many));
    expect(files).toHaveLength(8);
    expect(files.map((f) => f.size)).toEqual(many.map((m) => m.bytes.length));
  });

  it("uses the PLURAL mime — the singular one does not trigger multi-add", () => {
    expect(PKPASSES_CONTENT_TYPE).toBe("application/vnd.apple.pkpasses");
  });
});

describe("looksLikePkpass — the check that was missing", () => {
  const zip = (n = 2000) => {
    const b = new Uint8Array(n);
    b.set([0x50, 0x4b, 0x03, 0x04]);
    return b;
  };

  it("accepts a real pass", () => {
    expect(looksLikePkpass(zip())).toBe(true);
  });

  it("REJECTS the HTML page PassKit serves with a 200 while rendering", () => {
    // Live 2026-08-06: HTTP 200, `<!doctype html>`, ~11KB. `res.ok` was true,
    // so this page went into the bundle and iOS refused all four passes.
    const html = new Uint8Array(Buffer.from("<!doctype html>" + "x".repeat(11000), "utf8"));
    expect(looksLikePkpass(html)).toBe(false);
  });

  it("rejects empty and truncated bodies", () => {
    expect(looksLikePkpass(new Uint8Array(0))).toBe(false);
    expect(looksLikePkpass(zip(50))).toBe(false);
  });
});

describe("fetchPkpass — waits for the render", () => {
  const zip = () => {
    const b = new Uint8Array(2000);
    b.set([0x50, 0x4b, 0x03, 0x04]);
    return b;
  };
  const reply = (body: Uint8Array, ok = true) =>
    ({ ok, arrayBuffer: async () => body.buffer.slice(0) }) as unknown as Response;

  it("retries past the HTML placeholder and returns the pass", async () => {
    const html = new Uint8Array(Buffer.from("<!doctype html>".padEnd(11000, "x"), "utf8"));
    let call = 0;
    const fake = (async () => {
      call++;
      return call < 3 ? reply(html) : reply(zip());
    }) as unknown as typeof fetch;

    const out = await fetchPkpass("https://example.invalid/x.pkpass", fake);

    expect(out).not.toBeNull();
    expect(looksLikePkpass(out!)).toBe(true);
    expect(call).toBe(3);
  });

  it("gives up rather than returning junk that would poison the bundle", async () => {
    const html = new Uint8Array(Buffer.from("<!doctype html>".padEnd(11000, "x"), "utf8"));
    const fake = (async () => reply(html)) as unknown as typeof fetch;
    expect(await fetchPkpass("https://example.invalid/x.pkpass", fake)).toBeNull();
    // Walks the whole 14.5s backoff on purpose — that patience is the fix.
  }, 30_000);
});
