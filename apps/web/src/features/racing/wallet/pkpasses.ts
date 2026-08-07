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

/** Every ZIP — and therefore every `.pkpass` — starts with these four bytes. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * Is this actually a pass, or an HTML page wearing a 200?
 *
 * PASSKIT ANSWERS 200 WITH HTML while a newly created pass is still rendering —
 * observed live 2026-08-06: `HTTP 200`, `<!doctype html>`, 11 KB. Checking
 * `res.ok` is therefore worthless here, and embedding that page as a `.pkpass`
 * produced a bundle iOS refused with "Sorry, your pass cannot be installed at
 * this time" — an error that says nothing about which of the four was bad.
 */
export function looksLikePkpass(bytes: Uint8Array): boolean {
  if (bytes.length < 1000) return false; // a real pass is hundreds of KB
  return ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * PassKit serves the pass file or an HTML landing page for the SAME URL, and it
 * decides on the USER-AGENT. Measured 2026-08-06 against a known-good pass:
 *
 *     (no UA / undici default)  → 200 text/html            11 KB   landing page
 *     curl/8.0.1                → 200 vnd.apple.pkpass    590 KB   the pass
 *     iPhone Safari             → 200 vnd.apple.pkpass    590 KB   the pass
 *
 * An `Accept: application/vnd.apple.pkpass` header does NOT change it — only the
 * UA does. Server-side fetch sends undici's default, so every download we made
 * silently received a web page, which we then zipped into the bundle and handed
 * to iOS as a pass. That is the whole reason "add all" failed, and it looked
 * like a render delay because a browser hitting the same URL always worked.
 *
 * So we present as the device the pass is FOR — the request a phone would make,
 * and the only one that is handed the artefact.
 */
const PASS_FETCH_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile Safari/604.1";

/**
 * Download a signed pass.
 *
 * Retries remain as cheap insurance against a genuinely slow render, but the
 * failure we actually hit was never timing — see the UA note above.
 */
export async function fetchPkpass(
  url: string,
  fetchImpl: typeof fetch = fetch,
  /** Wait schedule in ms. `[0]` = ask once, which is what the client-driven
   *  prepare loop wants: the ASK is what triggers the render, so a single look
   *  still makes progress even when it answers "not yet". */
  delays: readonly number[] = [0, 1500, 3000, 4000, 6000],
): Promise<Uint8Array | null> {
  for (const wait of delays) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetchImpl(url, {
        cache: "no-store",
        headers: { "User-Agent": PASS_FETCH_UA, Accept: "application/vnd.apple.pkpass" },
      });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (looksLikePkpass(bytes)) return bytes;
    } catch {
      // network blip — the next attempt is the retry
    }
  }
  return null;
}
