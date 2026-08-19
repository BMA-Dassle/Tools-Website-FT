"use client";

/**
 * THE MENU BOARD — what is open, what it costs, and when the next one is.
 *
 * Ten attraction tiles across the five panels, two each, so the wall is the venue's
 * menu and no two panels repeat. Split into CONTIGUOUS runs (`chunkAcrossWall`), so
 * the pairings the list was written with survive: the two headline attractions open
 * the wall and All Access lands at the far end, beside the HeadPinz mark.
 *
 * THE TIMES COME FROM THE CACHE THE KIOSKS SELL FROM. `feed.nextAvailable` is read
 * out of `kiosk:avail:v4:{center}` — the same three-minute entry behind
 * /api/kiosk/availability — never recomputed here. That is what guarantees this
 * wall and the machine two feet below it cannot disagree about whether there is a
 * lane at 7:30. A screen must also have asked for it (`showNextAvailable`), and
 * when the cache is cold there are simply no times: an advert promising a slot the
 * kiosk will then refuse is worse than one with no time on it.
 *
 * A PAUSED PRODUCT SHOWS NO PRICE AND NO TIME. Same `pausedProductIds` gate
 * SceneAdRotation honours, keyed on the SAME product ids the maintenance registry
 * uses — the tile goes quiet and says when it is back, rather than quoting a price
 * for something Guest Services will have to explain.
 *
 * BOWLING SHOWS AVAILABILITY, NOT A PRICE. Lane pricing is dynamic through QAMF and
 * the static catalogue carries `price: 0`; inventing a lane price is exactly the
 * displayed-vs-charged mismatch the house pricing rule exists to prevent.
 */
import type { SceneProps } from "../director/types";
import { choreo } from "../wall";
import { menuTilesFor, WALL_ACCENT, type MenuTile } from "../wall-content";
import { TV_PHOTOS } from "../assets";
import { WallGround } from "../components/WallPanel";
import { withAlpha } from "../color";

/** A quiet ground per panel — the tiles are the content, so the photograph is
 *  atmosphere and stays well back. */
const PANEL_PHOTO = [
  TV_PHOTOS.bowl,
  TV_PHOTOS.laser,
  TV_PHOTOS.raceAction,
  TV_PHOTOS.duck,
  TV_PHOTOS.arcade,
];

export function SceneOpenNow({ feed, nowMs, config }: SceneProps) {
  const { position, count } = choreo(config);
  const tiles = menuTilesFor(nowMs, position, count);
  const paused = new Set(feed?.pausedProductIds ?? []);
  const times = config.showNextAvailable ? (feed?.nextAvailable ?? null) : null;
  // Whether the availability cache answered AT ALL this poll. It matters because
  // the feed drops a product the cache marked unavailable, so "no entry" only
  // means "nothing left today" when we know the cache was warm — see the Tile.
  const cacheWarm = times !== null;
  const photo = PANEL_PHOTO[position % PANEL_PHOTO.length];

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <WallGround photo={photo} accent={WALL_ACCENT.cyan} deepScrim />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 27,
          padding: "58px 65px",
        }}
      >
        {tiles.map((tile) => (
          <Tile
            key={tile.productId}
            tile={tile}
            paused={paused.has(tile.productId)}
            time={times?.[tile.productId] ?? null}
            cacheWarm={cacheWarm}
          />
        ))}
      </div>
    </div>
  );
}

function Tile({
  tile,
  paused,
  time,
  cacheWarm,
}: {
  tile: MenuTile;
  paused: boolean;
  /** The availability line for this product, already formatted by the feed
   *  ("3 left · 7:30 PM"). Null when the cache had nothing for it. */
  time: string | null;
  /** The availability cache answered this poll (for some product, at least). */
  cacheWarm: boolean;
}) {
  // A paused tile keeps its NAME and loses everything transactional. It stays on
  // the wall rather than being dropped: a guest who came for laser tag needs to
  // learn it is down, and a tile that vanishes teaches them nothing.
  const accent = paused ? WALL_ACCENT.quiet : tile.accent;
  const figure = paused ? "Back soon" : (tile.price ?? tile.word);

  // NEVER SAY "OPEN" WHEN WE DO NOT KNOW. The feed omits a product the cache has
  // marked unavailable, so for a tile that tracks availability, a warm cache with
  // no entry means there is nothing bookable left today — and printing "Open"
  // there sends a guest to a kiosk that will refuse them. A COLD cache is
  // different: we have no signal either way, and the building is plainly open
  // (the wall is lit), so the floor stays "Open" with no time attached, which is
  // the same posture the ad slides already take.
  const status = paused
    ? "See Guest Services"
    : time
      ? time
      : tile.tracksAvailability && cacheWarm
        ? "Ask at the desk"
        : "Open";

  return (
    <div
      style={{
        borderLeft: `8px solid ${accent}`,
        background: "rgba(3,8,24,0.76)",
        borderRadius: "0 17px 17px 0",
        padding: "27px 31px",
        opacity: paused ? 0.4 : 1,
      }}
    >
      <div className="tv-display" style={{ fontSize: 55, color: "#fff", lineHeight: 1 }}>
        {tile.name}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 17,
          marginTop: 16,
        }}
      >
        <span
          className="tv-display"
          style={{
            // A word where a price would be ("Lanes open", "Load a card") is set
            // smaller: it is a sentence doing a number's job, and at 50px it would
            // outweigh the real prices either side of it on the wall.
            fontSize: tile.price && !paused ? 50 : 37,
            color: accent,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1,
            textShadow: paused ? undefined : `0 0 24px ${withAlpha(accent, 0.45)}`,
          }}
        >
          {figure}
        </span>
        <span
          style={{
            fontSize: 27,
            color: "rgba(245,236,238,0.6)",
            textAlign: "right",
            lineHeight: 1.26,
          }}
        >
          <b
            style={{
              display: "block",
              fontWeight: 600,
              color: paused ? "rgba(245,236,238,0.32)" : WALL_ACCENT.gel,
            }}
          >
            {status}
          </b>
          {!paused && tile.note}
        </span>
      </div>
    </div>
  );
}
