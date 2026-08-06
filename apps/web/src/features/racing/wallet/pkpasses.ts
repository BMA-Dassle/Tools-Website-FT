import { crc32 } from "node:zlib";

/**
 * Bundle several `.pkpass` files into one `.pkpasses`, so a phone adds a whole
 * party's licences in a single tap.
 *
 * Apple's multi-pass format is just a ZIP of `.pkpass` files served as
 * `application/vnd.apple.pkpasses`; iOS then offers "Add N passes". There is no
 * manifest and nothing to sign — each inner pass carries its own signature,
 * which is exactly why the bytes must be copied VERBATIM.
 *
 * ── Why this is hand-rolled rather than a zip dependency ────────────────────
 * A `.pkpass` is itself a compressed ZIP, so re-compressing it saves nothing and
 * costs CPU on every tap. All we need is the STORED (method 0) path — copy the
 * bytes, record a CRC — which is about sixty lines of a well-specified format
 * against a new dependency in a repo that is deliberately strict about them.
 * `zlib.crc32` has been in Node since 20.15 and this app requires 22+.
 *
 * Deterministic on purpose: a fixed DOS timestamp means the same passes produce
 * byte-identical bundles, which makes a difference debuggable.
 */

/** 1980-01-01 00:00, the DOS epoch — the conventional "no meaningful time". */
const DOS_TIME = 0;
const DOS_DATE = 33; // (1980-1980)<<9 | 1<<5 | 1

export interface BundleEntry {
  /** File name inside the bundle. Apple only requires uniqueness + .pkpass. */
  name: string;
  bytes: Uint8Array;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/**
 * @throws never — an empty list yields an empty (but valid) archive, which the
 * caller should avoid serving; check `entries.length` first.
 */
export function buildPkpassesBundle(entries: readonly BundleEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.bytes);
    const sum = crc32(data);

    // Local file header + the stored bytes.
    const header = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed (2.0 — stored/deflate)
      u16(0), // general purpose flags
      u16(0), // method 0 = STORED
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(sum),
      u32(data.length), // compressed size == uncompressed for STORED
      u32(data.length),
      u16(name.length),
      u16(0), // extra field length
      name,
    ]);
    local.push(header, data);

    central.push(
      Buffer.concat([
        u32(0x02014b50), // central directory header signature
        u16(20), // version made by
        u16(20), // version needed
        u16(0),
        u16(0), // STORED
        u16(DOS_TIME),
        u16(DOS_DATE),
        u32(sum),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk number start
        u16(0), // internal attributes
        u32(0), // external attributes
        u32(offset), // offset of local header
        name,
      ]),
    );

    offset += header.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // this disk
    u16(0), // disk with central directory
    u16(entries.length),
    u16(entries.length),
    u32(centralBuf.length),
    u32(offset),
    u16(0), // comment length
  ]);

  return Buffer.concat([...local, centralBuf, end]);
}

/** Apple's MIME for the multi-pass bundle. The singular `.pkpass` type will NOT
 *  trigger the multi-add sheet. */
export const PKPASSES_CONTENT_TYPE = "application/vnd.apple.pkpasses";
