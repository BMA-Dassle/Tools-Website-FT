"use client";

/**
 * Mobile waiver-time photo — the /waiver counterpart to KioskWaiverPhoto. A
 * single front camera (no kiosk dual-camera rig / KioskConfigContext), phone
 * styled: live preview → 3-2-1 → snap → Use / Retake, output a PNG kept under
 * Pandora's 1MB cap. The party overlay uploads via the persist-first route and
 * advances, so capture never blocks the waiver on the network. Adults: expected,
 * with a broken-camera escape; minors: optional.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const SIZE_STEPS = [720, 560, 448, 360]; // capture widths tried until PNG ≤ cap
const MAX_PNG_BYTES = 950_000; // margin under Pandora's 1MB

const primaryBtn =
  "w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-base font-bold text-[#04252b] disabled:opacity-40";
const ghostBtn =
  "w-full rounded-xl border border-white/25 px-4 py-3 text-base font-bold text-white";

export function MobileWaiverPhoto({
  memberName,
  isMinor,
  onCaptured,
  onSkip,
}: {
  memberName: string;
  isMinor: boolean;
  /** Called with the PNG (base64, no data: prefix). Parent uploads + advances. */
  onCaptured: (pngBase64: string) => void;
  onSkip: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [shot, setShot] = useState<string | null>(null); // data URL preview

  // Mount-only: open the front camera; always stop tracks on unmount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
      } catch (err) {
        if (!cancelled) {
          const name = err instanceof DOMException ? err.name : "";
          setCamError(
            name === "NotAllowedError"
              ? "Camera access was blocked — allow it in your browser to add a photo, or skip."
              : "Camera unavailable — you can skip and we'll take your photo at check-in.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  /** Snap the current frame to a PNG data URL that fits the size cap. */
  const snap = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    for (const width of SIZE_STEPS) {
      const scale = Math.min(1, width / video.videoWidth);
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, w, h);
      const dataUrl = canvas.toDataURL("image/png");
      if ((dataUrl.length - "data:image/png;base64,".length) * 0.75 <= MAX_PNG_BYTES) {
        return dataUrl;
      }
    }
    return null;
  }, []);

  const startCountdown = () => {
    if (countdown != null) return;
    setCountdown(3);
    const tick = (n: number) => {
      if (n === 0) {
        setCountdown(null);
        const dataUrl = snap();
        if (dataUrl) setShot(dataUrl);
        else setCamError("Couldn't take the photo — try again.");
        return;
      }
      setTimeout(() => {
        setCountdown(n - 1);
        tick(n - 1);
      }, 800);
    };
    tick(3);
  };

  const usePhoto = () => {
    if (!shot) return;
    onCaptured(shot.slice(shot.indexOf(",") + 1));
  };

  return (
    <div className="mx-auto max-w-md">
      <h2 className="text-xl font-extrabold text-white">Quick photo for check-in</h2>
      <p className="mt-1 text-sm text-white/60">
        {isMinor
          ? `A photo for ${memberName} is optional — it speeds up check-in.`
          : `${memberName}, look at the camera — this verifies you at check-in.`}
      </p>

      <div className="relative mt-4 overflow-hidden rounded-2xl border border-white/15 bg-black">
        {shot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shot} alt="How you'll appear at check-in" className="block w-full" />
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="block w-full"
            style={{ transform: "scaleX(-1)" }}
          />
        )}
        {countdown != null && countdown > 0 && (
          <div className="absolute inset-0 grid place-items-center bg-black/40">
            <span className="text-7xl font-extrabold text-white">{countdown}</span>
          </div>
        )}
      </div>

      {camError && (
        <div className="mt-3 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          {camError}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2">
        {shot ? (
          <>
            <button type="button" onClick={usePhoto} className={primaryBtn}>
              Use this photo
            </button>
            <button type="button" onClick={() => setShot(null)} className={ghostBtn}>
              Retake
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={startCountdown}
            disabled={countdown != null || !!camError}
            className={primaryBtn}
          >
            Take photo
          </button>
        )}
        <button
          type="button"
          onClick={onSkip}
          className="mx-auto mt-1 text-sm text-white/40 underline-offset-4 hover:underline"
        >
          {isMinor ? "Skip the photo" : "Camera isn't working — take my photo at check-in"}
        </button>
      </div>
    </div>
  );
}
