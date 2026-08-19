"use client";

/**
 * ONE PANEL OF A VIDEO WALL — the shared chrome the three front-desk scenes paint on.
 *
 * The whole design is "the wall wears the kiosk attract screen's visual language":
 * the same scrim, the same bloom, the same centred stack and the same two headline
 * treatments (see AttractHeadline.tsx and attract/billboard.ts). This component is
 * where that language lives, so the VIP showcase, the menu board and the how-to
 * cannot drift apart from each other — five panels that disagree by a few pixels
 * of padding is the one mistake a wall makes visible and a laptop preview hides.
 *
 * LAYOUT IS CHOSEN BY THE PANEL'S JOB. `WallPoster` is the kiosk's centred stack,
 * for a statement or a price; `WallCard` is the bottom-left block, for a leg of an
 * itinerary or an inclusion that needs a supporting line. A centred poster cannot
 * hold detail and a corner card cannot carry a statement, which is why both exist
 * rather than one compromise.
 *
 * AUTHORED IN CANVAS PIXELS. TvStage gives every scene a fixed 1920×1080 canvas
 * that is transform-scaled to the panel, so these are absolute px and not vw/cqw —
 * the design's `cqw` figures are simply px ÷ 19.2.
 *
 * GOLD IS AN EVENT, not a theme. `gold` paints the wash and the two hairlines that
 * read as ONE line running the length of the wall — the move a four-foot gap could
 * never make, and the reason it is reserved for the moments that earn it (the VIP
 * showcase and the one resting slide in five). Gold that were always on would stop
 * meaning All Access, which is the only thing it is allowed to mean.
 */
import { withAlpha } from "../color";
import { TvBrandLogo } from "./TvBrandLogo";
import type { RailCell } from "../wall-content";
import { WALL_ACCENT } from "../wall-content";

/* ── the ground ───────────────────────────────────────────────────────── */

export function WallGround({
  photo,
  accent,
  gold = false,
  deepScrim = false,
  kenburns = false,
}: {
  photo?: string;
  accent: string;
  /** Paint the gold wash and the wall-long hairlines. */
  gold?: boolean;
  /** The stronger scrim, for a panel carrying 165px type over a busy photo. */
  deepScrim?: boolean;
  kenburns?: boolean;
}) {
  return (
    <>
      {photo && (
        /* Overdrawn 6% so a ken-burns pan can never reveal an edge — the same
           inset SceneAdRotation uses, for the same reason. */
        <div
          aria-hidden
          className={kenburns ? "tv-kenburns" : undefined}
          style={{
            position: "absolute",
            inset: "-6%",
            backgroundImage: `url(${photo})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            filter: "saturate(0.78) brightness(0.82)",
          }}
        />
      )}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: deepScrim
            ? "linear-gradient(to top, #000418 6%, rgba(2,10,34,0.88) 46%, rgba(4,14,44,0.5))"
            : "linear-gradient(to top, #000418 8%, rgba(2,10,34,0.80) 55%, rgba(4,14,44,0.6))",
        }}
      />
      {/* The activity's own colour, pooled behind where the headline sits. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(62% 38% at 50% 30%, ${withAlpha(accent, 0.22)}, transparent 68%)`,
        }}
      />
      {gold && (
        <>
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              background: `linear-gradient(to top, ${withAlpha(WALL_ACCENT.vip, 0.2)}, transparent 62%)`,
              mixBlendMode: "soft-light",
            }}
          />
          <GoldHairline edge="top" />
          <GoldHairline edge="bottom" />
        </>
      )}
      {/* One light pass across the panel, phase-locked to the shared clock by
          syncGlowPhase — which is what makes the pass travel ALONG the wall
          instead of five panels each glinting on their own schedule. */}
      <div aria-hidden className="tv-sweep" style={{ position: "absolute", inset: 0 }} />
    </>
  );
}

/** A hairline that, at six inches of gap, reads as one gold line running the
 *  length of the wall. Faded at both ends so panel-to-panel joins are not visible
 *  as bright seams. */
function GoldHairline({ edge }: { edge: "top" | "bottom" }) {
  const g = WALL_ACCENT.vip;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        [edge]: 0,
        height: 4,
        background: `linear-gradient(90deg, ${withAlpha(g, 0.15)}, ${g} 22%, ${g} 78%, ${withAlpha(g, 0.15)})`,
        boxShadow: `0 0 27px ${withAlpha(g, 0.55)}`,
        zIndex: 3,
      }}
    />
  );
}

/* ── the two layouts ──────────────────────────────────────────────────── */

/** The kiosk's centred stack: an optional mark, a headline, an optional gold rule
 *  and caption. What a statement or a price wants. */
export function WallPoster({
  bigBrand = null,
  smallBrand,
  word,
  accent,
  rule,
  railed = false,
  /** Staggers the entrance a beat per panel, so the words light along the wall
   *  left to right rather than all at once. */
  delayMs = 0,
}: {
  /** Render this panel as a full-width lockup of THIS brand. Null = no lockup. */
  bigBrand?: "fasttrax" | "headpinz" | null;
  smallBrand?: "fasttrax" | "headpinz";
  word?: string;
  accent: string;
  rule?: string;
  railed?: boolean;
  delayMs?: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 40,
        padding: 65,
        paddingBottom: railed ? RAIL_H + 50 : 65,
      }}
    >
      {smallBrand && (
        <div className="tv-rise" style={{ animationDelay: `${delayMs}ms` }}>
          <BrandMark brand={smallBrand} height={84} glow />
        </div>
      )}
      <div
        className="tv-rise"
        style={{
          animationDelay: `${delayMs}ms`,
          minHeight: 365,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          gap: 29,
        }}
      >
        {bigBrand && <BrandMark brand={bigBrand} height={0} width={998} glow />}
        {word && (
          <div
            className="tv-display"
            style={{
              // A shorter size when a caption shares the slot, so the pair reads
              // as one block instead of the number crowding its own explanation.
              fontSize: rule ? 142 : 165,
              lineHeight: 0.95,
              textAlign: "center",
              color: "#fff",
              whiteSpace: "pre-line",
              textShadow: `0 0 10px rgba(255,255,255,0.88), 0 0 64px ${accent}`,
            }}
          >
            {word}
          </div>
        )}
        {rule && (
          <>
            <div
              aria-hidden
              style={{
                width: 499,
                height: 5,
                background: `linear-gradient(90deg, transparent, ${WALL_ACCENT.vip}, transparent)`,
                boxShadow: `0 0 23px ${withAlpha(WALL_ACCENT.vip, 0.6)}`,
              }}
            />
            <div
              className="tv-display"
              style={{
                fontSize: 40,
                letterSpacing: "0.2em",
                color: WALL_ACCENT.vipSoft,
                textShadow: `0 0 31px ${withAlpha(WALL_ACCENT.vip, 0.5)}`,
                textAlign: "center",
              }}
            >
              {rule}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The bottom-left block: eyebrow, headline, supporting line, accent rule. What a
 *  leg of an itinerary or an inclusion wants — detail a centred poster can't hold. */
export function WallCard({
  eyebrow,
  word,
  line,
  accent,
  bottomInset = 96,
  delayMs = 0,
}: {
  eyebrow?: string;
  word: string;
  line?: string;
  accent: string;
  /** Room for whatever band sits under this card — the rail or the arrow band. */
  bottomInset?: number;
  delayMs?: number;
}) {
  return (
    <div
      className="tv-rise"
      style={{
        animationDelay: `${delayMs}ms`,
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        padding: "77px 96px",
        paddingBottom: bottomInset,
        gap: 25,
      }}
    >
      {eyebrow && (
        <div className="tv-display" style={{ fontSize: 28, letterSpacing: "0.3em", color: accent }}>
          {eyebrow}
        </div>
      )}
      <div
        className="tv-display"
        style={{
          fontSize: 88,
          lineHeight: 0.92,
          color: "#fff",
          whiteSpace: "pre-line",
          textShadow: `0 0 8px rgba(255,255,255,0.82), 0 0 56px ${accent}`,
        }}
      >
        {word}
      </div>
      {line && (
        <div
          style={{
            fontSize: 37,
            lineHeight: 1.24,
            color: "rgba(245,236,238,0.88)",
            whiteSpace: "pre-line",
          }}
        >
          {line}
        </div>
      )}
      <div
        aria-hidden
        style={{
          height: 5,
          width: 219,
          borderRadius: 3,
          background: `linear-gradient(90deg, ${accent}, ${withAlpha(accent, 0)})`,
        }}
      />
    </div>
  );
}

/* ── the identity rail ────────────────────────────────────────────────── */

/** Height of the rail in canvas px. Exported so a layout can leave room for it
 *  rather than restating the number and drifting from it. */
export const RAIL_H = 104;

/**
 * The gold band naming the product on EVERY slide of the showcase.
 *
 * Read across the wall it is one sentence; read alone, each panel's cell is
 * complete. See `identityRail` in wall-content.ts for why the name and the price
 * each have to land whole on a single panel.
 */
export function WallIdentityRail({ cell }: { cell: RailCell }) {
  const g = WALL_ACCENT.vip;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: RAIL_H,
        zIndex: 2,
        background: "linear-gradient(to right, rgba(0,4,24,0.95), rgba(8,12,34,0.9))",
        borderTop: `2px solid ${withAlpha(g, 0.55)}`,
        display: "flex",
        alignItems: "center",
        padding: "0 96px",
        gap: 18,
        whiteSpace: "nowrap",
      }}
    >
      <span
        className="tv-display"
        style={{
          fontSize: cell.isName ? 37 : 29,
          letterSpacing: cell.isName ? "0.14em" : "0.2em",
          color: cell.isName || cell.isPrice ? g : "rgba(245,236,238,0.74)",
        }}
      >
        {cell.text}
      </span>
      {cell.glyph && (
        <span className="tv-display" style={{ fontSize: 29, color: g }}>
          {cell.glyph}
        </span>
      )}
      {cell.quiet && (
        <span
          className="tv-display"
          style={{ fontSize: 29, letterSpacing: "0.18em", color: "rgba(245,236,238,0.5)" }}
        >
          {cell.quiet}
        </span>
      )}
    </div>
  );
}

/* ── brand marks ──────────────────────────────────────────────────────── */

/**
 * A brand lockup for a wall panel.
 *
 * Wraps TvBrandLogo, which is keyed by SignageVenue rather than by brand, because
 * the wall speaks in BRANDS: "two locations" is FastTrax Fort Myers and HeadPinz
 * Fort Myers — two venues that share the `fort-myers` center slug and are told
 * apart only by brand, which is exactly the center-namespace trap constants.ts
 * warns about. Both map to Fort Myers; only the mark differs.
 */
function BrandMark({
  brand,
  height,
  width,
  glow = false,
}: {
  brand: "fasttrax" | "headpinz";
  height: number;
  width?: number;
  glow?: boolean;
}) {
  const venue = brand === "fasttrax" ? "FT" : "HPFM";
  return (
    <div
      style={{
        filter: glow ? `drop-shadow(0 0 35px ${withAlpha(WALL_ACCENT.vip, 0.45)})` : undefined,
        // A big mark is sized by WIDTH (it is the whole composition); a small one
        // by height (it sits in a stack above the words).
        width: width ? width : undefined,
      }}
    >
      <TvBrandLogo venue={venue} height={width ? Math.round(width * 0.28) : height} />
    </div>
  );
}

export { BrandMark };
