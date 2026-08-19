"use client";

/**
 * The scores wall's frame: geometry, palette, header, footer, and the centred
 * Shell every "nothing to show" card is built from.
 *
 * EXTRACTED, NOT FORKED (2026-08-17). The `race-results` scene now has two
 * faces — the last race that came back in, and the top-times hall of fame —
 * and they hang on the same walls, often as a pair four feet apart. Copying the
 * header into the second one would have been quicker and would have gone stale
 * the first time the shipped board was touched: the extracted-component lesson
 * in tasks/lessons.md is exactly this failure. One frame, two boards inside it.
 *
 * Authored at 1920×1080, like every other TV canvas. Nothing here animates —
 * see the motion note at the top of SceneRaceResults.
 */
import { TRACK_ACCENTS, TRACK_LABELS, type TrackKey } from "../track";
import { withAlpha } from "../color";
import { TvBrandLogo } from "../components/TvBrandLogo";
import type { SignageVenue } from "../constants";

/* ── canvas geometry ──────────────────────────────────────────────────── */

export const PAD_X = 46;
export const HEADER_H = 168;
export const FOOTER_H = 92;

/* ── palette ──────────────────────────────────────────────────────────── */

/** Qualified / levelled-up green. */
export const GEL = "#46d68c";
/** Motorsport's purple for a fastest lap. The palette's own Mega violet rather
 *  than a new colour — see the tokens in app/tv/tv.css. */
export const FAST = "#a06bff";
export const GOLD = "#d4af37";
export const SILVER = "#cfd6e0";
export const BRONZE = "#d08a4a";
export const DIM = "rgba(245,236,238,0.58)";
export const LINE = "rgba(255,255,255,0.12)";
/** The canvas ground. Deep navy rather than black — see TRACK_ACCENTS. */
export const GROUND = "#000418";

export function Header({
  track,
  venue,
  title,
  rightLabel,
  rightValue,
}: {
  track: TrackKey;
  venue: SignageVenue;
  title: string;
  rightLabel: string;
  rightValue: string;
}) {
  const accent = TRACK_ACCENTS[track];
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: HEADER_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: `0 ${PAD_X}px`,
        boxSizing: "border-box",
        background: `linear-gradient(180deg, ${withAlpha(accent, 0.26)}, ${withAlpha(accent, 0.08)})`,
        borderBottom: `7px solid ${accent}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 28, minWidth: 0 }}>
        {/* The mark, not the word (owner 2026-08-11 "use actual logos") — and at
            TV distance a logo is recognised rather than read. TvBrandLogo falls
            back to a wordmark rather than a broken-image glyph. */}
        <TvBrandLogo venue={venue} height={78} />
        <div
          style={{ width: 14, height: 104, borderRadius: 7, background: accent, flex: "0 0 auto" }}
        />
        <div style={{ minWidth: 0 }}>
          <div className="tv-eyebrow">{TRACK_LABELS[track]}</div>
          <div
            className="tv-display"
            style={{
              fontSize: 72,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {title}
          </div>
        </div>
      </div>
      <div style={{ textAlign: "right", flex: "0 0 auto", paddingLeft: 24 }}>
        <div className="tv-eyebrow" style={{ color: DIM }}>
          {rightLabel}
        </div>
        <div className="tv-num" style={{ fontSize: 54, fontWeight: 700 }}>
          {rightValue}
        </div>
      </div>
    </div>
  );
}

export function Footer({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: FOOTER_H,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: `0 ${PAD_X}px`,
        boxSizing: "border-box",
        borderTop: `1px solid ${LINE}`,
        background: "rgba(7,16,39,0.5)",
        gap: 32,
      }}
    >
      <div
        style={{
          fontSize: 30,
          fontWeight: 600,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {left}
      </div>
      <div
        className="tv-num"
        style={{
          fontSize: 23,
          color: DIM,
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
        }}
      >
        {right}
      </div>
    </div>
  );
}

/** A full board whose middle is one centred message. Every "nothing to show
 *  yet" card on this wall is one of these, so they cannot drift apart. */
export function Shell({
  track,
  venue,
  title,
  rightLabel,
  rightValue,
  big,
  small,
  footLeft,
}: {
  track: TrackKey;
  venue: SignageVenue;
  title: string;
  rightLabel: string;
  rightValue: string;
  big: React.ReactNode;
  small: string;
  footLeft: string;
}) {
  return (
    <div style={{ position: "absolute", inset: 0, background: GROUND }}>
      <Header
        track={track}
        venue={venue}
        title={title}
        rightLabel={rightLabel}
        rightValue={rightValue}
      />
      <div
        style={{
          position: "absolute",
          top: HEADER_H,
          left: 0,
          right: 0,
          bottom: FOOTER_H,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "0 120px",
        }}
      >
        <div className="tv-display" style={{ fontSize: 92, marginBottom: 18 }}>
          {big}
        </div>
        <div style={{ fontSize: 34, color: DIM, maxWidth: 1200 }}>{small}</div>
      </div>
      <Footer left={footLeft} right={<TvBrandLogo venue={venue} height={44} />} />
    </div>
  );
}
