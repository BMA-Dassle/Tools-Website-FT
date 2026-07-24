"use client";

/**
 * Camera scanner for the back of a Game Zone card. Reads EITHER printed code:
 *  - the QR code — a web redirect; we extract the account id
 *  - the 1D barcode — the straight account number
 *
 * The QR isn't always a bare `?id=` URL: current card stock carries an
 * Intercard shortlink (`icardinc.net/<code>`) that only reveals the id after a
 * redirect. `cardNumberFromScan` decodes the local cases (bare number,
 * `?id=` URL); when it can't, we hand the raw payload to /api/game-cards/
 * resolve-scan, which follows the redirect server-side and returns the account.
 *
 * Uses the native BarcodeDetector where the browser ships it (Android Chrome:
 * QR + 1D barcodes), falling back to jsQR (pure JS, QR only — covers iPhone
 * Safari with no wasm and no CSP exposure). The QR is on every card, so every
 * phone can scan *something*; the barcode is a bonus on supported browsers.
 */

import { useEffect, useRef, useState } from "react";
import { IconQrcode } from "@tabler/icons-react";
import Modal from "~/components/ui/Modal";
import ErrorBox from "~/components/ui/ErrorBox";
import { cardNumberFromScan } from "~/features/game-cards/scan";
import { apiPost } from "~/features/game-cards/api";

/** A scanned payload we can't decode locally but might resolve via redirect. */
function looksLikeHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

/** Formats we ask the native detector for (superset — filtered by support). */
const WANTED_FORMATS = ["qr_code", "code_128", "code_39", "itf", "ean_13", "upc_a", "codabar"];

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

type DetectFn = (video: HTMLVideoElement, canvas: HTMLCanvasElement) => Promise<string | null>;

async function makeDetect(): Promise<DetectFn> {
  const BD = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (BD) {
    try {
      const supported = await BD.getSupportedFormats();
      const formats = WANTED_FORMATS.filter((f) => supported.includes(f));
      if (formats.length > 0) {
        const det = new BD({ formats });
        return async (video) => {
          const found = await det.detect(video);
          return found[0]?.rawValue ?? null;
        };
      }
    } catch {
      /* fall through to jsQR */
    }
  }
  // Fallback (iPhone Safari + any browser without BarcodeDetector): ZXing.
  // Pure JS/TS — no wasm, no CSP exposure (the same property that drove the
  // original jsQR choice) — but it reads 1D barcodes too and localizes far
  // better than jsQR's single-shot QR decode. One decode per tick off a
  // downscaled canvas frame, so it slots into the existing polling loop.
  const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
    import("@zxing/browser"),
    import("@zxing/library"),
  ]);
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.QR_CODE,
    BarcodeFormat.CODE_128,
    BarcodeFormat.CODE_39,
    BarcodeFormat.ITF,
    BarcodeFormat.EAN_13,
    BarcodeFormat.UPC_A,
    BarcodeFormat.CODABAR,
  ]);
  const reader = new BrowserMultiFormatReader(hints);
  return async (video, canvas) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    // Downscale before decode — full-res frames burn phone CPU for no accuracy win.
    const scale = Math.min(1, 640 / w);
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      return reader.decodeFromCanvas(canvas).getText() || null;
    } catch {
      return null; // NotFoundException — nothing in this frame; keep scanning
    }
  };
}

export default function CardScanner({
  onScan,
  onClose,
}: {
  /** Called once with the normalized account number; parent closes the modal. */
  onScan: (accountNumber: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [badCode, setBadCode] = useState(false);
  const doneRef = useRef(false);
  // Distinct URL payloads we've already sent to the redirect resolver (one shot
  // each) + an in-flight guard, so the 5-per-second tick doesn't spam the API.
  const resolvedRef = useRef<Set<string>>(new Set());
  const resolvingRef = useRef(false);
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let cancelled = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch {
        if (!cancelled) {
          setError(
            "Couldn't open the camera. Allow camera access and try again, or type the number instead.",
          );
        }
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        /* playsInline + muted below — iOS still needs the attributes, not this call */
      }
      const detect = await makeDetect();
      const tick = async () => {
        if (cancelled || doneRef.current) return;
        try {
          const raw =
            videoRef.current && canvasRef.current
              ? await detect(videoRef.current, canvasRef.current)
              : null;
          if (raw != null) {
            const acct = cardNumberFromScan(raw);
            if (acct) {
              doneRef.current = true;
              onScanRef.current(acct);
              return;
            }
            // Couldn't decode locally. A card QR is an Intercard shortlink whose
            // id only appears after a redirect — resolve it server-side. Try
            // each distinct URL once; keep scanning while it's in flight.
            if (looksLikeHttpUrl(raw)) {
              if (!resolvingRef.current && !resolvedRef.current.has(raw)) {
                resolvedRef.current.add(raw);
                resolvingRef.current = true;
                apiPost<{ accountNumber: string }>("/api/game-cards/resolve-scan", { raw })
                  .then((r) => {
                    if (doneRef.current) return;
                    if (r?.accountNumber) {
                      doneRef.current = true;
                      onScanRef.current(r.accountNumber);
                    } else {
                      setBadCode(true);
                    }
                  })
                  .catch(() => {
                    if (!doneRef.current) setBadCode(true);
                  })
                  .finally(() => {
                    resolvingRef.current = false;
                  });
              }
            } else {
              setBadCode(true);
            }
          }
        } catch {
          /* transient decode failure — keep scanning */
        }
        timer = window.setTimeout(() => void tick(), 200);
      };
      void tick();
    })();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <Modal title="Scan your card" onClose={onClose}>
      {error ? (
        <ErrorBox>{error}</ErrorBox>
      ) : (
        <>
          <div className="relative overflow-hidden rounded-xl bg-black">
            {/* Live camera preview — no audio track, nothing to caption. */}
            <video ref={videoRef} playsInline muted autoPlay className="h-64 w-full object-cover" />
            {/* Aiming guide — shows guests it's the QR code they're centering. */}
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
              aria-hidden="true"
            >
              <IconQrcode className="h-28 w-28 text-white/70 drop-shadow-[0_1px_6px_rgba(0,0,0,0.8)]" />
            </div>
          </div>
          <canvas ref={canvasRef} className="hidden" />
          <p className="mt-3 flex items-center justify-center gap-2 text-sm text-white/60">
            <IconQrcode className="h-4 w-4 shrink-0" aria-hidden="true" />
            Center the QR code on the back of your card.
          </p>
          {badCode && (
            <p className="mt-2 text-xs text-amber-300">
              That code doesn&apos;t look like a game card — scan the QR code on the back, or type
              the number instead.
            </p>
          )}
        </>
      )}
      <button className="mt-4 w-full text-center text-xs text-white/40 underline" onClick={onClose}>
        Type the number instead
      </button>
    </Modal>
  );
}
