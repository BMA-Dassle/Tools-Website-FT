"use client";

/**
 * Waiver-time guest photo capture (owner 2026-07-18): live camera preview →
 * 3-2-1 countdown → snap → Retake / Use photo. Runs BEFORE the signature in
 * the kiosk waiver overlay — required for adults, optional for minors.
 *
 * Dual-camera kiosks (UPPER = adult height, LOWER = kids/wheelchair) get a
 * "Switch camera" toggle; the default follows the guest's age bucket. Output
 * is a PNG kept under Pandora's 1MB cap by stepping the capture size down
 * until it fits. The parent uploads (persist-first route) — capture never
 * blocks the waiver on network.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useKioskConfig } from "../KioskConfigContext";
import { useT } from "../i18n";

const SIZE_STEPS = [720, 560, 448, 360]; // capture widths tried until PNG ≤ cap
const MAX_PNG_BYTES = 950_000; // margin under Pandora's 1MB

export function KioskWaiverPhoto({
  memberName,
  isMinor,
  onCaptured,
  onSkip,
}: {
  memberName: string;
  isMinor: boolean;
  /** Called with the PNG (base64, no data: prefix). Parent uploads + advances. */
  onCaptured: (pngBase64: string) => void;
  /** Minors: "Skip photo". Adults: the broken-camera escape (labeled so). */
  onSkip: () => void;
}) {
  const t = useT();
  const { config } = useKioskConfig();
  const upper = config?.cameraUpperId ?? null;
  const lower = config?.cameraLowerId ?? null;
  const hasBoth = !!(upper && lower);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Default camera follows the age bucket; guests can switch.
  const [activeCam, setActiveCam] = useState<string | null>(
    isMinor ? (lower ?? upper) : (upper ?? lower),
  );
  const [camError, setCamError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [shot, setShot] = useState<string | null>(null); // data URL preview

  // Open (and re-open on switch) the camera stream; always stop the old one.
  useEffect(() => {
    let cancelled = false;
    const open = async () => {
      setCamError(null);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: activeCam ? { deviceId: { exact: activeCam } } : true,
            audio: false,
          });
        } catch {
          // Saved device id gone (unplugged/re-enumerated) — any camera beats none.
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
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
              ? t("waiverPhoto.err.blocked")
              : name === "NotReadableError"
                ? t("waiverPhoto.err.inUse")
                : err instanceof Error
                  ? t("waiverPhoto.err.unavailableMsg", { msg: err.message })
                  : t("waiverPhoto.err.unavailable"),
          );
        }
      }
    };
    void open();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [activeCam, t]);

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
      // base64 → bytes ≈ len × 0.75
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
        else setCamError(t("waiverPhoto.err.snapFail"));
        return;
      }
      setTimeout(() => {
        setCountdown(n - 1);
        tick(n - 1);
      }, 900);
    };
    tick(3);
  };

  const usePhoto = () => {
    if (!shot) return;
    const base64 = shot.slice(shot.indexOf(",") + 1);
    onCaptured(base64);
  };

  return (
    <div className="mx-auto max-w-[900px]">
      <div className="k-display text-[52px]">{t("waiverPhoto.title")}</div>
      <p className="mt-[10px] text-[26px] text-white/60">
        {isMinor
          ? t("waiverPhoto.sub.minor", { name: memberName })
          : t("waiverPhoto.sub.adult", { name: memberName })}
      </p>

      <div className="relative mt-[24px] overflow-hidden rounded-[28px] border-2 border-white/15 bg-black">
        {/* Live preview (mirrored — guests expect a mirror) or the captured shot */}
        {shot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shot} alt={t("waiverPhoto.previewAlt")} className="block w-full" />
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
            <span className="k-display text-[220px] text-white">{countdown}</span>
          </div>
        )}
      </div>

      {camError && (
        <div className="mt-[16px] rounded-2xl border border-amber-400/40 bg-amber-400/10 px-[24px] py-[16px] text-[24px] text-amber-100">
          {camError}
        </div>
      )}

      <div className="mt-[24px] flex flex-col gap-[14px]">
        {shot ? (
          <>
            <button
              type="button"
              onClick={usePhoto}
              className="k-btn-primary k-tap"
              style={{ flex: "0 0 auto" }}
            >
              {t("waiverPhoto.use")}
            </button>
            <button
              type="button"
              onClick={() => setShot(null)}
              className="k-btn-ghost k-tap"
              style={{ flex: "0 0 auto" }}
            >
              {t("waiverPhoto.retake")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={startCountdown}
              disabled={countdown != null || !!camError}
              className="k-btn-primary k-tap"
              style={{ flex: "0 0 auto" }}
            >
              {t("waiverPhoto.take")}
            </button>
            {hasBoth && (
              <button
                type="button"
                onClick={() => setActiveCam((c) => (c === upper ? lower : upper))}
                className="k-btn-ghost k-tap"
                style={{ flex: "0 0 auto" }}
              >
                {t("waiverPhoto.switch")}
              </button>
            )}
          </>
        )}
        {/* Minors: photo is optional. Adults: broken-hardware escape only —
            the front desk takes the photo at check-in instead. */}
        <button
          type="button"
          onClick={onSkip}
          className="mx-auto mt-[4px] text-[22px] text-white/40 underline-offset-4 hover:underline"
        >
          {isMinor ? t("waiverPhoto.skip.minor") : t("waiverPhoto.skip.adult")}
        </button>
      </div>
    </div>
  );
}
