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
import { useState } from "react";
import type { SceneProps } from "../director/types";
import { choreo } from "../wall";
import { menuPanelAt, panelFilmAt, splitPrice, WALL_ACCENT, type MenuRow } from "../wall-content";
import { WallGround } from "../components/WallPanel";
import { KioskCallout } from "../components/KioskCallout";
import { useWallFilms } from "../useWallFilms";
import { withAlpha } from "../color";

/** The callout band's own height, plus air. Everything above it stops here. */
const BAND_CLEARANCE = 150;

/**
 * How the panel MORPHS when a reel starts or ends (owner 2026-09-01: "need a nice
 * transition of those prices when this happens as well").
 *
 * A transition and not an animation, because the panel does NOT remount at a video
 * turn: `frameKey` is the scene name and `open-now` is still `open-now`, so React
 * simply re-renders with different numbers. Left alone that is a hard snap — the
 * headline jumps from 148px to 62px between two frames. Transitioning the properties
 * that actually change makes the prices glide down into the corner and back out again,
 * which is the same 620ms family the card entrances already use.
 */
const MORPH = "620ms cubic-bezier(0.2, 0.8, 0.2, 1)";

export function SceneOpenNow({ feed, nowMs, config }: SceneProps) {
  const { position, count, gapPct } = choreo(config);
  const panel = menuPanelAt(nowMs, position, feed?.bowlingTonight ?? null);
  // This panel's own reels, cached locally. Enabled only where there is something
  // filmed, so four of the five panels touch neither the network nor the disk.
  const films = useWallFilms(panel?.films ?? [], !!panel?.films?.length);
  const film = panel ? panelFilmAt(nowMs, position, panel) : null;
  /** A reel is playing, so the words make room for it — see the layout note below. */
  const compact = !!film;
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
      {/* THE REEL REPLACES THE PHOTOGRAPH, never sits over it — a still under a moving
          picture is a frame nobody sees and a decode nobody needs. The scrim, bloom and
          light pass stay either way, so the panel's words are laid on exactly the same
          treatment whether it is holding the video turn or not. */}
      {/* The still ground is ALWAYS painted; the reel fades up over it. That ordering
          is what makes the failure case free — if the video errors, refuses to autoplay
          or is simply not this panel's turn, the layer above is gone and the panel's own
          photograph is already underneath, with no fallback branch to get wrong. */}
      <WallGround
        photo={panel.photo}
        accent={panel.accent}
        deepScrim
        wall={{ position, count, gapPct }}
      />
      {film && <PanelFilm src={films.srcFor(film)} accent={panel.accent} />}

      {/* WHEN A REEL IS PLAYING, THE PRICES TUCK INTO THE CORNER (owner 2026-09-01:
          "maybe the pricing tiles go small into the corners while video plays?").
          That is a better answer than either of the two obvious ones. At full size the
          headline and two tiles leave barely a tenth of the frame actually showing
          video — "you really can't see the videos much behind price boards" — and
          dropping a tile to make room would have cost a price. Small and cornered keeps
          BOTH prices on the glass and gives the footage about sixty percent of the
          panel. The tiles keep their own dark card and gold edge, so they stay legible
          over moving pictures without needing the panel dimmed behind them. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          padding: compact ? "54px 72px 54px" : `88px 110px ${BAND_CLEARANCE}px`,
        }}
      >
        {/* THE SUBJECT, whole on this panel, with the place or the offer named above
            it. The eyebrow sits ABOVE rather than below because it is the smaller
            thing: the eye should land on the headline and pick up the qualifier on
            the way in, not have to travel back up for it.
            It shrinks rather than disappearing during a reel: the footage says
            "bowling" better than the word does, but a panel that names nothing is a
            panel a guest cannot ask about at the desk. */}
        <div style={{ flexShrink: 0 }}>
          {/* Kept MOUNTED and collapsed rather than unmounted, so it folds away with
              the rest instead of vanishing between two frames. */}
          {panel.eyebrow && (
            <div
              style={{
                overflow: "hidden",
                height: compact ? 0 : 42,
                opacity: compact ? 0 : 1,
                transition: `height ${MORPH}, opacity 380ms linear`,
              }}
            >
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
            </div>
          )}
          <div
            className="tv-display"
            style={{
              fontSize: compact ? 62 : 148,
              lineHeight: 0.94,
              marginTop: panel.eyebrow && !compact ? 18 : 0,
              color: "#fff",
              textShadow: `0 0 10px rgba(255,255,255,0.82), 0 0 ${compact ? 40 : 70}px ${panel.accent}`,
              transition: `font-size ${MORPH}, margin-top ${MORPH}`,
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
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: compact ? 14 : 36,
            // Cornered during a reel so the right half of the frame is picture.
            width: compact ? "48%" : "100%",
          }}
        >
          {panel.rows.map((row) => (
            <Row
              key={row.name}
              row={row}
              accent={panel.accent}
              paused={!!row.productId && paused.has(row.productId)}
              time={(row.productId && times?.[row.productId]) || null}
              cacheWarm={cacheWarm}
              compact={compact}
            />
          ))}
        </div>
      </div>

      {/* THE INSTRUCTION RIDES WITH THE PRICE. A guest reading a price eight feet up is
          not thereby told that the machine at waist height is how to buy it — and
          carrying it here costs no airtime, which is why the separate kiosk how-to
          scene was deleted rather than kept alongside.

          OFF WHILE A REEL PLAYS (owner 2026-09-01: "don't need the lower bar book on
          kiosk either while video plays"). It is the one piece of chrome that can go
          without losing anything: the band is permanent on the four panels that are
          NOT playing a reel at any moment, and the same panel carries it again for six
          of every eight minutes — so a guest is never more than a glance away from it.
          Dropping it hands the bottom 150px back to the picture, which is where the
          eye already is. */}
      {/* Slid out rather than unmounted, so it leaves the frame instead of blinking
          out of it — the same 620ms the tiles take to fold into the corner. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 120,
          transform: compact ? "translateY(105%)" : "none",
          opacity: compact ? 0 : 1,
          transition: `transform ${MORPH}, opacity 420ms linear`,
          pointerEvents: "none",
        }}
      >
        <KioskCallout accent={panel.accent} text={panel.band} />
      </div>
    </div>
  );
}

/**
 * The panel's reel, with the still photograph as its safety net.
 *
 * FALLS BACK RATHER THAN FAILS. Autoplay can be refused even when muted, a cached file
 * can be evicted between the plan and the play, and venue wifi can drop a stream — so
 * `onError` swaps to the photograph the panel would have shown anyway. A black rectangle
 * behind live prices is the one outcome worth this much defensiveness, and it is what
 * the arena promo board learned the same way.
 *
 * `muted` is a hard requirement and not a default: it is what makes gesture-free
 * autoplay legal, and this wall stands over a staff desk. `objectFit: cover` over
 * `contain` because pillarbox bars on a lobby TV read as a broken player.
 */
function PanelFilm({ src, accent }: { src: string | null; accent: string }) {
  const [failed, setFailed] = useState(false);
  /**
   * THE SOURCE IS FROZEN FOR THIS TURN, and that is what stops a visible restart.
   *
   * `srcFor` returns the local cache copy once it exists and the blob-store URL until
   * then, and the disk read that produces the local one is async — so on a cold mount
   * the element starts streaming from the network and then, a few hundred ms later, the
   * prop changed, the `key` changed, and the reel jumped back to frame 0. Every turn.
   * Taking the first value and holding it means a turn either streams or plays locally
   * from the first frame to the last; the next turn picks up the cached copy.
   */
  const [frozenSrc] = useState(src);

  // Nothing at all — the panel's own still is already painted underneath, so a refused
  // autoplay or a dead file costs a reel and never a black rectangle.
  if (!frozenSrc || failed) return null;

  return (
    <div className="tv-film-in" style={{ position: "absolute", inset: 0 }}>
      <video
        // No `key` needed: `frozenSrc` cannot change for the life of this mount, and a
        // new turn is a new mount.
        src={frozenSrc}
        loop
        muted
        autoPlay
        playsInline
        preload="auto"
        onError={() => setFailed(true)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          // Barely held back. It was brightness(0.7), which cost a third of the
          // picture before any scrim was painted over it — and the whole complaint
          // was that the reels could not be seen.
          filter: "saturate(0.95) brightness(0.92)",
        }}
      />
      {/* BARELY A SCRIM AT ALL, and only in the two corners that carry words.
          The photograph's scrim is heavy and even because a photograph is only
          atmosphere behind copy. A reel is the thing being watched — and with the
          prices tucked small into the bottom-left and the kiosk band off, there is
          almost nothing left to protect: the tiles carry their own 84% card and gold
          edge, so they are legible over anything. What is left is a soft wash into the
          bottom-left corner to seat them, and a faint one at the top for the subject.
          The middle and the whole right of the frame are picture. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(120% 85% at 0% 100%, rgba(0,4,24,0.82), rgba(0,4,24,0.28) 45%, transparent 70%)",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(to bottom, rgba(0,4,24,0.5), transparent 22%)",
        }}
      />
      {/* The activity's colour, much weaker than on a still: over moving footage a
          22% wash reads as a colour cast rather than as the panel's accent. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(70% 45% at 50% 20%, ${withAlpha(accent, 0.1)}, transparent 70%)`,
        }}
      />
    </div>
  );
}

function Row({
  row,
  accent,
  paused,
  time,
  cacheWarm,
  compact,
}: {
  row: MenuRow;
  accent: string;
  paused: boolean;
  /** A reel is playing — the tile shrinks into the corner and drops its status line. */
  compact: boolean;
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
        borderRadius: compact ? 22 : 30,
        // A drawn metal edge rather than a flat border: at this size a 1px line
        // disappears and a thick flat one reads as a box. The sheen is what makes the
        // card look lit from the same direction on all four panels.
        padding: compact ? 3 : 4,
        background: `linear-gradient(140deg, ${withAlpha("#ffffff", 0.72)}, ${ink} 38%, ${withAlpha(ink, 0.3)} 64%, ${withAlpha("#ffffff", 0.5)})`,
        boxShadow: paused ? undefined : `0 0 46px ${withAlpha(ink, 0.3)}`,
        opacity: paused ? 0.4 : 1,
        transition: `border-radius ${MORPH}, padding ${MORPH}`,
      }}
    >
      <div
        style={{
          borderRadius: compact ? 19 : 26,
          // A touch more opaque when it is sitting on moving footage.
          background: compact ? "rgba(3,8,24,0.9)" : "rgba(3,8,24,0.84)",
          padding: compact ? "18px 26px" : "40px 60px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: compact ? 22 : 40,
          transition: `padding ${MORPH}, border-radius ${MORPH}, gap ${MORPH}`,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            className="tv-display"
            style={{
              fontSize: compact ? 34 : 62,
              color: "#fff",
              lineHeight: 1,
              transition: `font-size ${MORPH}`,
            }}
          >
            {row.name}
          </div>
          {!paused && row.note && (
            <div
              style={{
                fontSize: compact ? 22 : 32,
                color: "rgba(245,236,238,0.68)",
                marginTop: compact ? 6 : 12,
                transition: `font-size ${MORPH}, margin-top ${MORPH}`,
              }}
            >
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
          {/* Dropped entirely while a reel plays: the tile is a corner label then, and
              a next-available time is detail for someone reading the board rather than
              watching it — it is back within two minutes. */}
          {!paused &&
            !compact &&
            (() => {
              const status = time ?? rowStatus(row, cacheWarm);
              if (!status) return null;
              return (
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
                    {status}
                  </span>
                </div>
              );
            })()}
        </div>

        <Figure row={row} ink={ink} paused={paused} compact={compact} />
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
function Figure({
  row,
  ink,
  paused,
  compact,
}: {
  row: MenuRow;
  ink: string;
  paused: boolean;
  compact: boolean;
}) {
  const glow = paused ? undefined : `0 0 14px rgba(255,255,255,0.8), 0 0 80px ${ink}`;
  const big = {
    // 76 is still half again the 52px this board had before tonight, so the corner
    // tile is not a retreat to the size nobody could read.
    fontSize: compact ? 76 : 170,
    color: paused ? "rgba(245,236,238,0.5)" : "#fff",
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums" as const,
    textShadow: glow,
    transition: `font-size ${MORPH}`,
  };

  if (paused) {
    return (
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div
          className="tv-display"
          style={{
            fontSize: compact ? 34 : 60,
            color: WALL_ACCENT.quiet,
            transition: `font-size ${MORPH}`,
          }}
        >
          Back soon
        </div>
        {!compact && (
          <div style={{ fontSize: 28, color: "rgba(245,236,238,0.32)", marginTop: 10 }}>
            See Guest Services
          </div>
        )}
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
          <span
            aria-hidden
            className="tv-display"
            style={{ ...big, fontSize: compact ? 40 : 90, marginTop: compact ? 7 : 16 }}
          >
            {cents}
          </span>
        )}
      </div>
    );
  }

  if (!row.word) return null;
  return (
    <div style={{ textAlign: "right", flexShrink: 0 }}>
      <div
        className="tv-display"
        style={{
          fontSize: compact ? 34 : 60,
          color: ink,
          lineHeight: 1,
          textShadow: `0 0 24px ${withAlpha(ink, 0.45)}`,
          transition: `font-size ${MORPH}`,
        }}
      >
        {row.word}
      </div>
    </div>
  );
}

/**
 * NEVER SAY "OPEN" WHEN WE DO NOT KNOW — and never say it when nobody asked.
 *
 * The feed omits a product the availability cache has marked unavailable, so for a
 * row that TRACKS availability a WARM cache with no entry means there is nothing
 * bookable left today — and printing "Open" there sends a guest to a kiosk that will
 * refuse them. That row gets "Ask at the desk".
 *
 * Everything else gets NOTHING. A row that tracks no availability (a Game Zone card,
 * a race) has no question to answer: "Open" under it is a word that cannot become any
 * other word, so it reads as a label rather than a status and it was cluttering every
 * card on the wall (owner screenshot, 2026-09-01 — two "OPEN"s on the Game Zone
 * panel). A cold cache is the same case: no signal either way, and the building is
 * plainly open because the wall is lit.
 *
 * Null means "print no status line at all".
 */
function rowStatus(row: MenuRow, cacheWarm: boolean): string | null {
  if (row.tracksAvailability && cacheWarm) return "Ask at the desk";
  return null;
}
