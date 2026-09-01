"use client";

/**
 * THE MENU BOARD — what is open, what it costs, and when the next one is.
 *
 * READ FROM ACROSS A LOBBY (owner 2026-09-01: "pricing is WAY too small… they're
 * not being noticed"). The price is now the composition rather than a figure at the
 * end of a row: 170px against the old 52px, on a panel that carries ONE subject and
 * at most TWO rows. Everything that had to go to buy that space — a third row, the
 * two-tiles-per-panel board before it, the six-subject rotation before that — was
 * detail nobody standing thirty feet away was ever going to read.
 *
 * AND NOTHING ROTATES ANY MORE. Four priced subjects sit on four panels
 * permanently, indexed by physical wall position, so the panel a guest looked at is
 * still showing the same thing when they look back. That also puts the last TV to
 * work: it used to sit on an idle signpost while prices took turns on the three
 * beside it, which is exactly the "a whole TV doing nothing" the owner called out.
 *
 * THE TIMES COME FROM THE CACHE THE KIOSKS SELL FROM. `feed.nextAvailable` is read
 * out of `kiosk:avail:v4:{center}` — the same three-minute entry behind
 * /api/kiosk/availability — never recomputed here. That is what guarantees this wall
 * and the machine two feet below it cannot disagree about whether there is a lane at
 * half nine. The screen must also have asked for it (`showNextAvailable`).
 *
 * THE BOWLING PRICES COME FROM THE FEED, not from this file. Bowling is the only
 * attraction here with no static price — lanes are dynamic through QAMF and
 * `ATTRACTIONS.bowling` carries `price: 0` on purpose — so tonight's regular and VIP
 * offers are read server-side out of the experience catalog (`feed.bowlingTonight`).
 * With that section null the panel sells availability instead of inventing a lane
 * price, which is the one thing it may never do.
 *
 * A PAUSED PRODUCT SHOWS NO PRICE AND NO TIME. Same `pausedProductIds` gate
 * SceneAdRotation honours, keyed on the SAME product ids the maintenance registry
 * uses — the row goes quiet and says where to ask, rather than quoting a price Guest
 * Services will then have to explain.
 */
import type { SceneProps } from "../director/types";
import { choreo } from "../wall";
import { menuPanelAt, splitPrice, WALL_ACCENT, type MenuRow } from "../wall-content";
import { WallGround } from "../components/WallPanel";
import { KioskCallout } from "../components/KioskCallout";
import { withAlpha } from "../color";

/** The callout band's own height, plus air. Everything above it stops here. */
const BAND_CLEARANCE = 150;

export function SceneOpenNow({ feed, nowMs, config }: SceneProps) {
  const { position, count, gapPct } = choreo(config);
  const panel = menuPanelAt(nowMs, position, feed?.bowlingTonight ?? null);
  const paused = new Set(feed?.pausedProductIds ?? []);
  const times = config.showNextAvailable ? (feed?.nextAvailable ?? null) : null;
  // Whether the availability cache answered AT ALL this poll. It matters because the
  // feed drops a product the cache marked unavailable, so "no entry" only means
  // "nothing left today" when we know the cache was warm — see rowStatus.
  const cacheWarm = times !== null;

  // A wall wider than the board leaves its extra panels on the ground alone. This
  // scene is authored for the five-panel front-desk wall, and a sixth panel
  // repeating "Bowling" would read as two bowling centres.
  if (!panel) {
    return (
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <WallGround accent={WALL_ACCENT.cyan} deepScrim wall={{ position, count, gapPct }} />
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <WallGround
        photo={panel.photo}
        accent={panel.accent}
        deepScrim
        wall={{ position, count, gapPct }}
      />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          padding: `88px 110px ${BAND_CLEARANCE}px`,
        }}
      >
        {/* THE SUBJECT, whole on this panel, with the place or the offer named above
            it. The eyebrow sits ABOVE rather than below because it is the smaller
            thing: the eye should land on the headline and pick up the qualifier on
            the way in, not have to travel back up for it. */}
        <div>
          {panel.eyebrow && (
            <div
              style={{
                fontSize: 32,
                fontWeight: 700,
                letterSpacing: "0.3em",
                textTransform: "uppercase",
                color: panel.accent,
              }}
            >
              {panel.eyebrow}
            </div>
          )}
          <div
            className="tv-display"
            style={{
              fontSize: 148,
              lineHeight: 0.94,
              marginTop: panel.eyebrow ? 18 : 0,
              color: "#fff",
              textShadow: `0 0 10px rgba(255,255,255,0.82), 0 0 70px ${panel.accent}`,
            }}
          >
            {panel.headline}
          </div>
        </div>

        {/* The rows sit at the BOTTOM of the panel, just above the band — the price
            is what a guest is looking for, and it should be at the same height on
            every panel of the wall rather than floating up when a subject has a
            shorter headline. */}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 36 }}>
          {panel.rows.map((row) => (
            <Row
              key={row.name}
              row={row}
              accent={panel.accent}
              paused={!!row.productId && paused.has(row.productId)}
              time={(row.productId && times?.[row.productId]) || null}
              cacheWarm={cacheWarm}
            />
          ))}
        </div>
      </div>

      {/* THE INSTRUCTION RIDES WITH THE PRICE. A guest reading a price eight feet up is
          not thereby told that the machine at waist height is how to buy it — and
          carrying it here costs no airtime, which is why the separate kiosk how-to
          scene was deleted rather than kept alongside. */}
      <KioskCallout accent={panel.accent} text={panel.band} />
    </div>
  );
}

function Row({
  row,
  accent,
  paused,
  time,
  cacheWarm,
}: {
  row: MenuRow;
  accent: string;
  paused: boolean;
  /** The availability line for this product, already formatted by the feed
   *  ("3 left · 9:30 PM"). Null when the cache had nothing for it. */
  time: string | null;
  /** The availability cache answered this poll (for some product, at least). */
  cacheWarm: boolean;
}) {
  // A paused row keeps its NAME and loses everything transactional. It stays on the
  // wall rather than being dropped: a guest who came for laser tag needs to learn it
  // is down, and a row that vanishes teaches them nothing.
  const ink = paused ? WALL_ACCENT.quiet : accent;

  return (
    <div
      style={{
        borderRadius: 30,
        // A drawn metal edge rather than a flat border: at this size a 1px line
        // disappears and a thick flat one reads as a box. The sheen is what makes the
        // card look lit from the same direction on all four panels.
        padding: 4,
        background: `linear-gradient(140deg, ${withAlpha("#ffffff", 0.72)}, ${ink} 38%, ${withAlpha(ink, 0.3)} 64%, ${withAlpha("#ffffff", 0.5)})`,
        boxShadow: paused ? undefined : `0 0 46px ${withAlpha(ink, 0.3)}`,
        opacity: paused ? 0.4 : 1,
      }}
    >
      <div
        style={{
          borderRadius: 26,
          background: "rgba(3,8,24,0.84)",
          padding: "40px 60px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 40,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="tv-display" style={{ fontSize: 62, color: "#fff", lineHeight: 1 }}>
            {row.name}
          </div>
          {!paused && row.note && (
            <div style={{ fontSize: 32, color: "rgba(245,236,238,0.68)", marginTop: 12 }}>
              {row.note}
            </div>
          )}
          {/* NEXT AVAILABLE, ON THE ROW'S OWN LINE. The time is what turns a price
              into a decision — "$12" is an advert, "$12, next at 9:15" is a plan
              (owner 2026-08-19). Labelled rather than left as a bare time, because an
              unlabelled clock on a price could be read as a closing time.
              WITH NO TIME THE LINE STILL RENDERS, carrying the status instead — that
              is the honesty guarantee (see rowStatus), and dropping it whenever the
              cache had no entry is exactly how a priced row with nothing left today
              would go on looking bookable. */}
          {!paused && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "baseline",
                gap: 14,
                marginTop: 20,
                borderRadius: 12,
                background: time ? "rgba(255,255,255,0.08)" : "transparent",
                padding: time ? "10px 22px" : "10px 0",
              }}
            >
              {time && (
                <span
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    letterSpacing: "0.2em",
                    textTransform: "uppercase",
                    color: "rgba(245,236,238,0.6)",
                  }}
                >
                  Next
                </span>
              )}
              <span
                className="tv-display"
                style={{
                  fontSize: time ? 38 : 30,
                  color: time ? WALL_ACCENT.gel : "rgba(245,236,238,0.62)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {time ?? rowStatus(row, cacheWarm)}
              </span>
            </div>
          )}
        </div>

        <Figure row={row} ink={ink} paused={paused} />
      </div>
    </div>
  );
}

/**
 * The number, at the size the owner asked for.
 *
 * THREE SHAPES, and which one is used says what the row is selling. A real price
 * splits its cents off so the dollars carry the weight — "$67.50" set whole at this
 * size makes the cheaper lane three feet away look dearer. A figure with a caption
 * ("600 tokens") gets the same treatment because it is also a number a guest is
 * comparing. Anything else is a sentence standing in for a number and is set small,
 * so it cannot outweigh the real prices along the wall.
 */
function Figure({ row, ink, paused }: { row: MenuRow; ink: string; paused: boolean }) {
  const glow = paused ? undefined : `0 0 14px rgba(255,255,255,0.8), 0 0 80px ${ink}`;
  const big = {
    fontSize: 170,
    color: paused ? "rgba(245,236,238,0.5)" : "#fff",
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums" as const,
    textShadow: glow,
  };

  if (paused) {
    return (
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div className="tv-display" style={{ fontSize: 60, color: WALL_ACCENT.quiet }}>
          Back soon
        </div>
        <div style={{ fontSize: 28, color: "rgba(245,236,238,0.32)", marginTop: 10 }}>
          See Guest Services
        </div>
      </div>
    );
  }

  if (row.price) {
    const { main, cents } = splitPrice(row.price);
    return (
      // THE WHOLE PRICE IS THE ACCESSIBLE NAME. Split across two elements it would be
      // read aloud as two numbers ("sixty-seven, fifty"), so the container carries the
      // original label and the halves are hidden — the split is a type-size decision,
      // not a change to what the row costs.
      <div
        aria-label={row.price}
        style={{ display: "flex", alignItems: "flex-start", flexShrink: 0 }}
      >
        <span aria-hidden className="tv-display" style={big}>
          {main}
        </span>
        {cents && (
          <span aria-hidden className="tv-display" style={{ ...big, fontSize: 90, marginTop: 16 }}>
            {cents}
          </span>
        )}
      </div>
    );
  }

  if (row.word && row.wordCaption) {
    return (
      <div
        style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}
      >
        <span className="tv-display" style={big}>
          {row.word}
        </span>
        <span
          style={{
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: ink,
            marginTop: 6,
          }}
        >
          {row.wordCaption}
        </span>
      </div>
    );
  }

  if (!row.word) return null;
  return (
    <div style={{ textAlign: "right", flexShrink: 0 }}>
      <div
        className="tv-display"
        style={{
          fontSize: 60,
          color: ink,
          lineHeight: 1,
          textShadow: `0 0 24px ${withAlpha(ink, 0.45)}`,
        }}
      >
        {row.word}
      </div>
    </div>
  );
}

/**
 * NEVER SAY "OPEN" WHEN WE DO NOT KNOW.
 *
 * The feed omits a product the availability cache has marked unavailable, so for a
 * row that tracks availability a WARM cache with no entry means there is nothing
 * bookable left today — and printing "Open" there sends a guest to a kiosk that will
 * refuse them. A COLD cache is different: we have no signal either way, and the
 * building is plainly open (the wall is lit), so the floor stays "Open" with no time
 * attached, which is the same posture the ad slides already take.
 */
function rowStatus(row: MenuRow, cacheWarm: boolean): string {
  if (row.tracksAvailability && cacheWarm) return "Ask at the desk";
  return "Open";
}
