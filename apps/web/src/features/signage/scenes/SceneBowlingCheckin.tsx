"use client";

/**
 * THE CHECK-IN STORY, IN TWO COLUMNS — the front-desk wall's left panel.
 *
 * Left: whose LANE IS AVAILABLE, so they can check in this minute. Right: who already
 * has, and which lane they got.
 *
 * Both halves, because either alone only speaks to half the lobby. The "checked in" list
 * answers what a guest asks AFTER they have worked out what to do; the "lane available"
 * list tells someone walking through the door that their lane is waiting and they can go
 * straight to a kiosk instead of queueing at the desk. Read left to right it is the whole
 * journey, which is what earns this a panel of its own rather than a turn in the rotation.
 *
 * THE LEFT COLUMN IS A FILTER, NOT A LIST OF EVERYONE DUE. Self check-in only completes
 * when QAMF reports the lane ready, so a guest listed without a ready lane walks to a
 * kiosk and is refused — and the board that sent them is the last thing they will trust
 * afterwards (owner 2026-08-19). Readiness is decided once a minute by the
 * `bowling-lane-ready` cron and cached; this scene never asks a vendor anything.
 *
 * A guest who checked in at a kiosk was never told a lane number by a person, so the
 * right column is the only place they learn it — and it answers what they ask next,
 * standing: self check-in does not hand out shoes, so the board says theirs are
 * coming rather than making them queue to ask.
 *
 * FIRST NAMES ONLY. Printed a foot tall in a public lobby, so it follows the same PII
 * posture as every other board: the server reduces to a first name before this sees it.
 *
 * A WING IS A COMPOSITION OF ONE. This scene never spans, so it takes no position from
 * `choreo()` — which is what makes it safe for its content to come and go with the
 * data while the middle three carry on unchanged. See SceneSpan.
 */
import type { SceneProps } from "../director/types";
import { WALL_ACCENT } from "../wall-content";
import { TV_PHOTOS } from "../assets";
import { WallGround } from "../components/WallPanel";
import { withAlpha } from "../color";

/** How many fit per column before the rows get too short to read across a lobby. The
 *  server asks for eight of each; this is the visual ceiling. */
const MAX_ROWS = 5;

/** "12" -> "Lane 12", "12, 13" -> "Lanes 12, 13". One spelling for both columns. */
function laneWords(lanes: string): string {
  return lanes.includes(",") ? `Lanes ${lanes}` : `Lane ${lanes}`;
}

const READY = WALL_ACCENT.cyan;
const WAITING = WALL_ACCENT.arcade;

export function SceneBowlingCheckin({ feed }: SceneProps) {
  const available = (feed?.bowlingCheckins?.available ?? []).slice(0, MAX_ROWS);
  const checkedIn = (feed?.bowlingCheckins?.checkedIn ?? []).slice(0, MAX_ROWS);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <WallGround photo={TV_PHOTOS.bowl} accent={READY} deepScrim />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          gap: 30,
          padding: "70px 74px 80px",
        }}
      >
        <div
          className="tv-display"
          style={{
            fontSize: 66,
            lineHeight: 0.94,
            color: "#fff",
            textShadow: `0 0 8px rgba(255,255,255,0.82), 0 0 56px ${READY}`,
          }}
        >
          Bowling check-in
        </div>

        {/* TWO COLUMNS, EQUAL WIDTH, with a hairline between them. Equal because
            neither side is the subordinate one — a lobby has both kinds of guest in
            it at once — and a rule rather than a gap because the two lists are the
            same story in two states, not two unrelated boards. */}
        <div
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: "1fr 1px 1fr",
            gap: 34,
            minHeight: 0,
          }}
        >
          <Column
            // EVERY NAME HERE CAN ACTUALLY CHECK IN. Not "everyone due": self check-in
            // only completes when QAMF reports the lane ready, so listing a guest whose
            // lane is not ready sends them to a kiosk that turns them away — and the
            // board that sent them is the last thing they trust afterwards (owner
            // 2026-08-19). The column is a filter, not a badge.
            heading="Lane available"
            accent={WAITING}
            // Not an error, and the normal state for most of an evening. It says what to
            // do rather than what is missing.
            empty="No lanes ready to check in just yet."
            footer={available.length > 0 ? "Check in on your phone or at any kiosk below." : null}
            rows={available.map((g) => ({
              key: `${g.name}-${g.timeLabel}`,
              name: g.name,
              // The LANE is the invitation — "Lane 12, go ahead" beats "you may check in".
              // The booked time sits underneath so a guest can pick their own line out of
              // several with the same lane free.
              value: g.lanes ? laneWords(g.lanes) : "Ready",
              status: g.timeLabel,
            }))}
          />

          <div aria-hidden style={{ background: "rgba(255,255,255,0.14)" }} />

          <Column
            heading="Checked in"
            accent={READY}
            empty="No lanes assigned yet."
            footer={checkedIn.length > 0 ? "Your shoes are being brought out to you." : null}
            rows={checkedIn.map((g) => ({
              key: `${g.name}-${g.lanes}`,
              name: g.name,
              value: laneWords(g.lanes),
              // A lane physically READY reads differently from one merely assigned:
              // the first means walk over now, the second means nearly. The pit boards
              // draw the same distinction for the same reason.
              status: g.laneReady ? "Ready now" : "Getting it ready",
            }))}
          />
        </div>

        {/* Under BOTH columns, and true of both: the left column's guests are about to
            check in, the right column's have. Shoes are the thing self check-in cannot
            hand over, so it is the one promise worth making standing. */}
        <div style={{ fontSize: 30, color: "rgba(245,236,238,0.72)", lineHeight: 1.3 }}>
          We&rsquo;ll bring your shoes out to you.
        </div>
      </div>
    </div>
  );
}

function Column({
  heading,
  accent,
  rows,
  empty,
  footer,
}: {
  heading: string;
  accent: string;
  rows: { key: string; name: string; value: string; status: string | null }[];
  /** What the column says with nothing in it. NOT a blank space: an empty half of a
   *  two-column board reads as a fault, whereas a sentence reads as "nobody yet". */
  empty: string;
  footer?: string | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
      <div
        className="tv-display"
        style={{ fontSize: 30, letterSpacing: "0.2em", color: accent, flexShrink: 0 }}
      >
        {heading}
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 27, color: "rgba(245,236,238,0.45)", lineHeight: 1.3 }}>
          {empty}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {rows.map((r) => (
            <div
              key={r.key}
              style={{
                borderLeft: `6px solid ${accent}`,
                background: "rgba(3,8,24,0.74)",
                borderRadius: "0 14px 14px 0",
                padding: "18px 22px",
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 16,
              }}
            >
              <span
                className="tv-display"
                style={{ fontSize: 42, color: "#fff", lineHeight: 1, minWidth: 0 }}
              >
                {r.name}
              </span>
              <span style={{ textAlign: "right", flexShrink: 0 }}>
                <span
                  className="tv-display"
                  style={{
                    fontSize: 38,
                    color: accent,
                    lineHeight: 1,
                    fontVariantNumeric: "tabular-nums",
                    textShadow: `0 0 20px ${withAlpha(accent, 0.45)}`,
                  }}
                >
                  {r.value}
                </span>
                {r.status && (
                  <span
                    style={{
                      display: "block",
                      fontSize: 22,
                      fontWeight: 600,
                      marginTop: 8,
                      color: r.status === "Ready now" ? WALL_ACCENT.gel : "rgba(245,236,238,0.5)",
                    }}
                  >
                    {r.status}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {footer && (
        <div style={{ fontSize: 24, color: "rgba(245,236,238,0.6)", lineHeight: 1.3 }}>
          {footer}
        </div>
      )}
    </div>
  );
}
