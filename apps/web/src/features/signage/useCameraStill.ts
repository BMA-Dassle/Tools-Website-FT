"use client";

/**
 * One camera still on a timer — the estate's only way to watch a camera.
 *
 * Shared by the TV camera-monitor scene and the check-in desk's room previews
 * (they grew the same code independently, and both grew the same leaks). The
 * contract is the one both callers already lived by:
 *
 * DOUBLE-BUFFERED. Each frame is fetched and decoded OFF-SCREEN and only
 * swapped in when ready, so the picture never blanks or flickers between
 * pulls. A run of failures greys the last good frame ("offline") rather than
 * showing a broken-image icon.
 *
 * THE FRAME CARRIES THE CAMERA IT CAME FROM (owner 2026-08-12: "when you
 * switch between rooms on that page we need loading, it just holds the last
 * camera"). `src` is null the instant `baseUrl` changes, and a frame from the
 * previous camera can never render under the new camera's heading.
 *
 * ROUND-TRIP BOUNDED: the next pull is only queued once the previous frame has
 * decoded or failed, so a slow relay throttles the poll naturally instead of
 * piling requests up.
 *
 * WHY fetch + blob, NOT a throwaway `new Image()` per tick. The old shape
 * minted a unique cache-busted URL into a fresh Image element every second —
 * 86,400 distinct decoded frames a day entering the renderer's caches on a
 * page that runs for weeks, plus a SECOND network fetch per frame when the
 * visible <img> re-requested a no-store URL. Here one blob is alive at a time
 * (the previous object URL is revoked on swap), one decoder element is reused
 * for the hook's lifetime, and the visible <img> reads the already-decoded
 * blob from memory.
 *
 * THE WATCHDOG IS THE FREEZE FIX. A request that neither loaded nor errored —
 * a hung socket, a stalled serverless relay — left the old code's timer
 * permanently un-armed: the board froze on its last frame, forever, with no
 * "Reconnecting" and no recovery. Every path through this hook re-arms the
 * timer; a hung fetch is aborted at FRAME_TIMEOUT_MS and lands in the error
 * path like any other failure.
 */
import { useEffect, useRef, useState } from "react";

/** A frame that has neither loaded nor failed after this long is HUNG, not
 *  slow — abort it and let the retry path have it. Generous on purpose: a
 *  cold serverless relay on venue internet can legitimately take seconds. */
const FRAME_TIMEOUT_MS = 15_000;

/** Back off on failure whatever the cadence — a camera that is down must not
 *  be hammered at viewer speed. Pure, so the policy is testable. */
export function nextCameraDelayMs(ok: boolean, cadenceMs: number): number {
  return ok ? cadenceMs : Math.max(2_000, cadenceMs);
}

export function useCameraStill(
  /** The proxy query WITHOUT the cache-buster, e.g. `/api/tv/camera?room=red&w=640`.
   *  Null disables the poll entirely (no camera configured). */
  baseUrl: string | null,
  cadenceMs: number,
  /** Lets a small preview stand down while a full-screen viewer polls the
   *  same camera. */
  enabled: boolean,
  /** How long frames may fail before the board admits it is reconnecting. */
  staleAfterMs: number,
): { src: string | null; offline: boolean } {
  const [frame, setFrame] = useState<{ key: string; src: string } | null>(null);
  const [offlineKey, setOfflineKey] = useState<string | null>(null);
  const lastOkRef = useRef(0);
  // ONE decoder element for the hook's lifetime — assigning a new src to it
  // cancels its previous load, so it can never accumulate.
  const decoderRef = useRef<HTMLImageElement | null>(null);
  // The object URL currently on screen, so the next swap can release it. An
  // already-rendered bitmap survives its URL's revocation; revoking only
  // forbids NEW loads, which is exactly right.
  const liveUrlRef = useRef<string | null>(null);

  // Derived, not reset in an effect: there is no moment, however brief, where
  // the wrong camera's picture is on screen.
  const src = frame !== null && frame.key === baseUrl ? frame.src : null;
  const offline = offlineKey !== null && offlineKey === baseUrl;

  useEffect(() => {
    if (!baseUrl || !enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight: AbortController | null = null;

    const tick = async () => {
      const ctrl = new AbortController();
      inflight = ctrl;
      const watchdog = setTimeout(() => ctrl.abort(), FRAME_TIMEOUT_MS);
      let ok = false;
      try {
        // Cache-bust every pull; the proxy sends no-store and dedupes upstream.
        const res = await fetch(`${baseUrl}&t=${Date.now()}`, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`camera frame ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        const objUrl = URL.createObjectURL(blob);
        try {
          const img = (decoderRef.current ??= new Image());
          img.src = objUrl;
          await img.decode();
        } catch (err) {
          URL.revokeObjectURL(objUrl);
          throw err;
        }
        if (cancelled) {
          URL.revokeObjectURL(objUrl);
          return;
        }
        if (liveUrlRef.current) URL.revokeObjectURL(liveUrlRef.current);
        liveUrlRef.current = objUrl;
        lastOkRef.current = Date.now();
        setFrame({ key: baseUrl, src: objUrl });
        setOfflineKey(null);
        ok = true;
      } catch {
        if (cancelled) return;
        if (Date.now() - lastOkRef.current > staleAfterMs) setOfflineKey(baseUrl);
      } finally {
        clearTimeout(watchdog);
        inflight = null;
      }
      // EVERY path re-arms — success, HTTP error, abort, hung-and-timed-out.
      timer = setTimeout(() => void tick(), nextCameraDelayMs(ok, cadenceMs));
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      inflight?.abort();
      if (decoderRef.current) decoderRef.current.src = "";
      if (liveUrlRef.current) {
        URL.revokeObjectURL(liveUrlRef.current);
        liveUrlRef.current = null;
      }
    };
  }, [baseUrl, cadenceMs, enabled, staleAfterMs]);

  return { src, offline };
}
