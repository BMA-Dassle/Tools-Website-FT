"use client";

/**
 * THE VIP EXPERIENCE, ACROSS FIVE PANELS — one picture, held for the whole slot.
 *
 * The front-desk wall's anchor scene, and since 2026-09-01 it is the owner's
 * EXPORTED ARTWORK rather than a composition drawn in code. Each panel carries its
 * own transparent PNG over a venue photograph, and the five together read as one
 * sentence: the product is named on the left, the offer runs through the middle,
 * and the right-hand panel is the ask.
 *
 * IT NO LONGER CYCLES. The old showcase ran four sub-slides of 20s on every panel;
 * this is a single frame that holds for the full window. That is not a reduction —
 * the four slides said in TIME what the five panels now say in SPACE, which is the
 * one thing a wall can do that a single screen cannot, and a guest walking past
 * gets the whole offer in one look instead of a quarter of it.
 *
 * WHAT MOVES IS THE PHOTOGRAPH. The artwork is fixed; the picture behind it pans,
 * which is the whole reason the PNGs are transparent. A wall the owner told us
 * "isn't being noticed" needs life in it, and this is life that cannot smear the
 * words — the type is in the art and the art does not move.
 *
 * THE QR IS LIVE, NOT BAKED. Panel 5 ships with a code drawn into the export by the
 * design tool, pointing wherever it pointed the day it was made. This scene paints a
 * real one over that plate, generated from the ACTIVE pack's own booking URL, so the
 * wall can never send a lobby full of people to a dead link.
 *
 * THE PRICES ARE NOW PIXELS. Nothing here can read them, so `VIP_ART_CLAIMS` in
 * wall-content.ts writes them down and a test pins them to the live pack — including
 * the case where no pack is on sale at all, which must fail the build rather than
 * leave the wall advertising a retired product.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { SceneProps } from "../director/types";
import { choreo } from "../wall";
import { vipSlideArtAt, vipBookingUrl, VIP_QR_PLATE, WALL_ACCENT } from "../wall-content";
import { WallGround } from "../components/WallPanel";

export function SceneVipShowcase({ config }: SceneProps) {
  const { position, count, gapPct } = choreo(config);
  const slide = vipSlideArtAt(position);

  // A wall wider than the artwork leaves its extra panels on the bare gold ground.
  // The set is a sentence; a repeated fragment at the end of it reads as a stutter,
  // and a black panel reads as a dead player.
  if (!slide) {
    return (
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <WallGround accent={WALL_ACCENT.vip} gold underArt wall={{ position, count, gapPct }} />
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <WallGround
        photo={slide.photo}
        accent={WALL_ACCENT.vip}
        gold
        underArt
        kenburns
        wall={{ position, count, gapPct }}
      />

      {/* The artwork itself, at 1:1 on the 1920×1080 canvas. `tv-rise` is
          deliberately NOT used: five panels of one picture must land together, and a
          staggered entrance would tear the sentence apart at the joins. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={slide.art}
        alt={slide.alt}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", zIndex: 2 }}
      />

      {slide.qr && <BookingQr />}
    </div>
  );
}

/**
 * The live booking code, laid exactly on the artwork's own white plate.
 *
 * Painted opaque white across the whole plate before the code goes down, so the
 * baked-in QR underneath is covered rather than showed through — two QRs a few
 * pixels apart is a code that scans as neither.
 *
 * Renders NOTHING when no pack is on sale. That leaves the exported code showing,
 * which is the lesser wrong of two bad states and is unreachable in practice: the
 * copy-pin test fails the build if this wall is live with no active pack.
 */
function BookingQr() {
  const url = vipBookingUrl();
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    QRCode.toDataURL(url, {
      // Generated well above the rendered size so it stays crisp when the canvas is
      // scaled up onto a 4K panel.
      width: 1024,
      margin: 1,
      // Dark-on-white, always. A gold-tinted code would sit better in the artwork
      // and scan worse, and a code that does not scan is worse than no code.
      color: { dark: "#000418", light: "#ffffff" },
    })
      .then((d) => {
        if (alive) setDataUrl(d);
      })
      .catch(() => {
        // Leave the plate alone rather than painting a white hole in the artwork.
        if (alive) setDataUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [url]);

  if (!url || !dataUrl) return null;

  const inset = 30;
  return (
    <div
      style={{
        position: "absolute",
        left: VIP_QR_PLATE.left,
        top: VIP_QR_PLATE.top,
        width: VIP_QR_PLATE.width,
        height: VIP_QR_PLATE.height,
        // Above the artwork — this replaces part of it.
        zIndex: 3,
        background: "#ffffff",
        // MORE rounded than the artwork's own plate (~16px), never less. These bounds
        // are the plate's widest extent, so a squarer corner here would paint white
        // outside the artwork's white and onto its navy frame; a rounder one stays
        // inside it, and white drawn over white is invisible.
        borderRadius: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={dataUrl}
        alt="Scan to book the VIP Experience"
        style={{
          display: "block",
          width: VIP_QR_PLATE.width - inset * 2,
          height: VIP_QR_PLATE.width - inset * 2,
        }}
      />
    </div>
  );
}
