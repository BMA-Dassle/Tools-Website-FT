"use client";

/**
 * Camera scanner for the back of a Game Zone card. Reads EITHER printed code:
 *  - the QR code — a web redirect (`swflpassport.com/?id=<n>`); we extract `id`
 *  - the 1D barcode — the straight account number
 *
 * Uses the native BarcodeDetector where the browser ships it (Android Chrome:
 * QR + 1D barcodes), falling back to jsQR (pure JS, QR only — covers iPhone
 * Safari with no wasm and no CSP exposure). The QR is on every card, so every
 * phone can scan *something*; the barcode is a bonus on supported browsers.
 */

import { useEffect, useRef, useState } from "react";
import Modal from "~/components/ui/Modal";
import ErrorBox from "~/components/ui/ErrorBox";
import { cardNumberFromScan } from "~/features/game-cards/scan";

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
  const jsQR = (await import("jsqr")).default;
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
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height)?.data ?? null;
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
            setBadCode(true);
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
          <div className="overflow-hidden rounded-xl bg-black">
            {/* Live camera preview — no audio track, nothing to caption. */}
            <video ref={videoRef} playsInline muted autoPlay className="h-64 w-full object-cover" />
          </div>
          <canvas ref={canvasRef} className="hidden" />
          <p className="mt-3 text-sm text-white/60">
            Point the camera at the QR code or barcode on the back of your card.
          </p>
          {badCode && (
            <p className="mt-2 text-xs text-amber-300">
              That code doesn&apos;t look like a game card — try the QR code on the back.
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
