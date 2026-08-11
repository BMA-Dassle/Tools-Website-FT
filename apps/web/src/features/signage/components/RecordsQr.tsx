"use client";

/**
 * "Scan for track records" — a QR on the track boards.
 *
 * ALWAYS LABELLED (owner 2026-08-11). A bare QR on a wall is a dare, not an
 * invitation: nobody points a camera at a square that has not told them what it
 * does. The label carries equal weight to the code itself, says plainly what is
 * on the other side, and is readable from further away than the QR is scannable
 * — so the offer arrives before the ask.
 *
 * Sized for the distance. A phone camera needs roughly 10× the module size in
 * viewing distance; at 240px on a 55" panel this scans comfortably from the few
 * feet somebody stands while waiting to check in, which is exactly where the
 * audience for lap records already is.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { withAlpha } from "../color";

// A LOT smaller (owner 2026-08-11) — a corner invitation, not a poster.
const QR_PX = 128;

export function RecordsQr({ url, accent }: { url: string; accent: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, {
      // 2× the rendered size so it stays crisp on a 4K panel.
      width: QR_PX * 2,
      margin: 1,
      // Dark-on-white, always. An accent-tinted QR looks smarter and scans
      // worse, and a code that does not scan is worse than no code.
      color: { dark: "#000418", light: "#ffffff" },
    })
      .then((d) => {
        if (alive) setDataUrl(d);
      })
      .catch(() => {
        // No QR is fine — the label below still tells them where to look.
        if (alive) setDataUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [url]);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "12px 18px",
        borderRadius: 16,
        background: "rgba(7,16,39,0.72)",
        border: `2px solid ${withAlpha(accent, 0.45)}`,
      }}
    >
      {dataUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={dataUrl}
          alt=""
          width={QR_PX}
          height={QR_PX}
          style={{ display: "block", borderRadius: 8, background: "#fff", padding: 5 }}
        />
      )}
      <div>
        <div className="tv-eyebrow" style={{ color: accent, fontSize: 18 }}>
          Scan for
        </div>
        <div
          className="tv-display"
          style={{ fontSize: 34, color: "#fff", lineHeight: 1.02, marginTop: 4 }}
        >
          Track records
        </div>
      </div>
    </div>
  );
}
