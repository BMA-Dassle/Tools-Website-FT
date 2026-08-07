"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/**
 * Per-racer QR images pointing at the wallet hand-off page.
 *
 * ── The one rule these encode ───────────────────────────────────────────────
 * They target `/passes/…`, NEVER `/r/{code}/wallet`. The wallet route redirects
 * straight at the signed pass file, and a pass PassKit has not finished
 * rendering is served as an HTML landing page — so a guest who scans early gets
 * something they cannot install. `/passes/…` runs prepare → poll → hand off
 * behind the branded loader instead. The kiosk shipped the direct redirect
 * first and had to be fixed; this exists so the next surface inherits the fix
 * rather than repeating it.
 *
 * Shared by the kiosk and waiver offers, which had byte-for-byte copies of this
 * effect differing only in the URL they built.
 */

/** Both callers render the code on a white plate against a dark panel; the ink
 *  is the pass's own navy so a printed and an on-screen code look alike. */
const QR_OPTS = {
  width: 320,
  margin: 1,
  color: { dark: "#04252b", light: "#ffffff" },
} as const;

/** Stable identity: a fresh `{}` each render would retrigger consumers. */
const EMPTY: Record<string, string> = {};

/**
 * @param base     `/passes/{billId}` or `/passes/w?g=…` — the pack's landing page
 * @param personIds who to render a code for
 * @returns personId → data URI. Missing while a code is still rendering.
 */
export function usePassQrs(base: string | null, personIds: readonly string[]): Record<string, string> {
  const [qrs, setQrs] = useState<Record<string, string>>({});
  // Join to a primitive: a fresh array identity every render would restart the
  // effect on every render and never settle.
  const ids = personIds.join(",");

  useEffect(() => {
    // No synchronous setState here — the empty case is DERIVED on return, which
    // keeps this out of the cascading-render path the hooks lint flags.
    if (!base || !ids) return;
    let cancelled = false;
    const sep = base.includes("?") ? "&" : "?";

    void Promise.all(
      ids.split(",").map(async (pid) => {
        const url = `${base}${sep}p=${encodeURIComponent(pid)}`;
        const img = await QRCode.toDataURL(url, QR_OPTS).catch(() => null);
        return [pid, img] as const;
      }),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const [pid, img] of pairs) if (img) next[pid] = img;
      setQrs(next);
    });

    return () => {
      cancelled = true;
    };
  }, [base, ids]);

  return !base || !ids ? EMPTY : qrs;
}

/** The whole-party code — one scan puts every licence on the phone that
 *  scanned it. Same destination, no `?p=`. */
export function useGroupQr(base: string | null, enabled: boolean): string | null {
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!base || !enabled) return;
    let cancelled = false;
    QRCode.toDataURL(base, { ...QR_OPTS, width: 360 })
      .then((url) => {
        if (!cancelled) setQr(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [base, enabled]);

  return !base || !enabled ? null : qr;
}
