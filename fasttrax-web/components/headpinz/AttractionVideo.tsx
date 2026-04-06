"use client";

import { useState, useRef, useEffect } from "react";

interface AttractionVideoProps {
  videoUrl: string;
  accent: string;
}

export default function AttractionVideo({ videoUrl, accent }: AttractionVideoProps) {
  const [open, setOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!open && videoRef.current) {
      videoRef.current.pause();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* Play button */}
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-6 py-2.5 rounded-full transition-all hover:scale-105 border"
        style={{
          color: accent,
          borderColor: `${accent}60`,
          backgroundColor: `${accent}15`,
        }}
      >
        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
          <path d="M8 5v14l11-7z" />
        </svg>
        Watch Video
      </button>

      {/* Modal overlay */}
      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative w-full max-w-4xl mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close button */}
            <button
              onClick={() => setOpen(false)}
              className="absolute -top-10 right-0 text-white/60 hover:text-white transition-colors text-sm font-[var(--font-hp-body)] uppercase tracking-wider flex items-center gap-1"
            >
              Close
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            {/* Video player */}
            <div className="rounded-lg overflow-hidden" style={{ border: `1.78px solid ${accent}40` }}>
              <video
                ref={videoRef}
                controls
                autoPlay
                playsInline
                className="w-full"
                style={{ maxHeight: "80vh" }}
              >
                <source src={videoUrl} type="video/mp4" />
              </video>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
