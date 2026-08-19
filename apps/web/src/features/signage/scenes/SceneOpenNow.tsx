"use client";

/**
 * THE MENU BOARD — what is open, what it costs, and when the next one is.
 *
 * ONE SUBJECT PER PANEL (owner 2026-08-18). The board used to be two tiles on every
 * panel, which made the wall a list that happened to be split five ways; now each
 * panel is about one thing — Bowling, Gel Blasters & Laser Tag, Game Zone, At
 * FastTrax, the VIP Experience — with the subject as the headline and its offers
 * underneath. A guest reading any single panel gets a complete answer instead of a
 * fragment of a menu, which matters on a wall where a player can be down.
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
import { menuPanelAt, WALL_ACCENT, type MenuRow } from "../wall-content";
import { WallGround } from "../components/WallPanel";
import { KioskCallout } from "../components/KioskCallout";
import { withAlpha } from "../color";

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
          justifyContent: "flex-end",
          gap: 26,
          // Room for the callout band, which is permanent chrome here rather than a
          // scene of its own (owner 2026-08-19).
          padding: "77px 78px 173px",
        }}
      >
        {/* THE SUBJECT, whole on this panel. The rows beneath it are its offers, so
            the headline is what makes the panel legible on its own. */}
        <div>
          <div
            className="tv-display"
            style={{
              fontSize: 78,
              lineHeight: 0.94,
              color: "#fff",
              textShadow: `0 0 8px rgba(255,255,255,0.82), 0 0 56px ${panel.accent}`,
            }}
          >
            {panel.headline}
          </div>
          {panel.subhead && (
            <div
              className="tv-display"
              style={{
                fontSize: 32,
                letterSpacing: "0.2em",
                color: panel.accent,
                marginTop: 14,
              }}
            >
              {panel.subhead}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
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
  const figure = paused ? "Back soon" : (row.price ?? row.word);

  return (
    <div
      style={{
        borderLeft: `8px solid ${ink}`,
        background: "rgba(3,8,24,0.76)",
        borderRadius: "0 17px 17px 0",
        padding: "24px 30px",
        opacity: paused ? 0.4 : 1,
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 22,
      }}
    >
      <div>
        <div className="tv-display" style={{ fontSize: 46, color: "#fff", lineHeight: 1 }}>
          {row.name}
        </div>
        {!paused && row.note && (
          <div style={{ fontSize: 26, color: "rgba(245,236,238,0.6)", marginTop: 10 }}>
            {row.note}
          </div>
        )}
      </div>

      <div style={{ textAlign: "right", flexShrink: 0 }}>
        {figure && (
          <div
            className="tv-display"
            style={{
              // A word where a price would be ("Any amount", "Open now") is set
              // smaller: it is a sentence doing a number's job, and at full size it
              // would outweigh the real prices either side of it on the wall.
              fontSize: row.price && !paused ? 52 : 34,
              color: ink,
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1,
              textShadow: paused ? undefined : `0 0 24px ${withAlpha(ink, 0.45)}`,
            }}
          >
            {figure}
          </div>
        )}
        <div
          style={{
            fontSize: 26,
            fontWeight: 600,
            marginTop: 10,
            color: paused ? "rgba(245,236,238,0.32)" : WALL_ACCENT.gel,
          }}
        >
          {rowStatus(row, paused, time, cacheWarm)}
        </div>
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
function rowStatus(row: MenuRow, paused: boolean, time: string | null, cacheWarm: boolean): string {
  if (paused) return "See Guest Services";
  if (time) return time;
  if (row.tracksAvailability && cacheWarm) return "Ask at the desk";
  return "Open";
}
