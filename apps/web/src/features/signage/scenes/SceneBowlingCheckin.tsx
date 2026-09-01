"use client";

/**
 * THE CHECK-IN STORY, IN TWO COLUMNS — the front-desk wall's left panel.
 *
 * Left: who is DUE IN THE NEXT HOUR, and whether their lane is ready. Right: who has
 * just checked themselves in, and which lane they got.
 *
 * Both halves, because either alone only speaks to half the lobby. The "checked in" list
 * answers what a guest asks AFTER they have worked out what to do; the left-hand list
 * tells someone walking through the door that we have them, and whether they can go
 * straight to a kiosk instead of queueing at the desk. Read left to right it is the whole
 * journey, which is what earns this a panel of its own rather than a turn in the rotation.
 *
 * THE LEFT COLUMN LISTS EVERYONE DUE, AND SAYS WHICH LANES ARE READY (owner 2026-09-01).
 * It used to be a FILTER — only guests whose lane QAMF had reported ready, because self
 * check-in cannot complete without one, and a guest sent to a kiosk that refuses them
 * never trusts the board again (owner 2026-08-19). That rule still holds; what changed is
 * where it is kept. Omitting a guest who is standing in the lobby reads as "we have no
 * record of you", so the row is drawn instead — greyed, with NO lane number and no
 * invitation, saying "Lane not ready yet" where a ready row says "Check in now". The
 * number is the invitation, so the number is what a not-ready row must not have.
 *
 * Readiness is decided once a minute by the `bowling-lane-ready` cron and cached; this
 * scene never asks a vendor anything.
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

/**
 * How many fit per column before the rows get too short to read across a lobby. The
 * server asks for eight of each; this is the visual ceiling.
 *
 * FOUR, not five (owner 2026-09-01: "the lanes ready board can be bigger text too").
 * Every size on this panel went up by roughly half, and the height had to come from
 * somewhere — a name at 62px in a row that also carries a lane and a status is ~130px
 * tall, so five of them no longer fit between the headline and the footer. Showing the
 * four most recent large beats five nobody can read from the door, and the window on
 * the query is now tight enough that a fifth is rarely waiting.
 */
const MAX_ROWS = 4;

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
            fontSize: 104,
            lineHeight: 0.94,
            color: "#fff",
            textShadow: `0 0 10px rgba(255,255,255,0.82), 0 0 64px ${READY}`,
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
            // EVERYONE DUE IN THE NEXT HOUR, each saying whether their lane is ready
            // (owner 2026-09-01). It used to list only the ready ones, on the rule that a
            // guest sent to a kiosk which refuses them never trusts the board again
            // (2026-08-19) — that rule is kept HERE instead, in how a not-ready row is
            // drawn: no lane number, no invitation, and "Lane not ready yet" where the
            // ready rows say "Check in now". Hiding a guest who is standing in the lobby
            // reads as "we have no record of you", which is its own kind of wrong.
            heading="Next hour"
            accent={WAITING}
            // Not an error, and the normal state for a quiet stretch. It says what to do
            // rather than what is missing.
            empty="No reservations due in the next hour."
            rows={available.map((g) => ({
              key: `${g.name}-${g.timeLabel}`,
              name: g.name,
              // The LANE is the invitation — "Lane 12, go ahead" beats "you may check in"
              // — so it appears ONLY when the lane is genuinely ready. Otherwise the
              // guest gets their booked time, which is what tells them they are in the
              // right place and simply early.
              value: g.laneReady && g.lanes ? laneWords(g.lanes) : g.timeLabel,
              status: g.laneReady ? "Check in now" : "Lane not ready yet",
              muted: !g.laneReady,
            }))}
          />

          <div aria-hidden style={{ background: "rgba(255,255,255,0.14)" }} />

          <Column
            heading="Just checked in"
            accent={READY}
            empty="Nobody checked in just yet."
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

        {/* SKIP THE DESK — the point of the whole panel (owner 2026-09-01: "encourage
            mobile and kiosk check in more"). It was a quiet grey line under one column
            saying where you *could* check in; it is now the band the panel ends on,
            naming both ways in and the reason to bother. Shoes get the second half
            because they are the one thing self check-in cannot hand over, and a guest
            who does not know they are coming will queue at the desk to ask — which is
            the very queue this is trying to empty. */}
        <div
          style={{
            flexShrink: 0,
            borderRadius: 20,
            border: `3px solid ${withAlpha(READY, 0.5)}`,
            background: "rgba(3,8,24,0.72)",
            padding: "24px 30px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            className="tv-display"
            style={{
              fontSize: 46,
              color: "#fff",
              lineHeight: 1,
              textShadow: `0 0 22px ${withAlpha(READY, 0.5)}`,
            }}
          >
            Skip the desk — check in on your phone or the kiosk below
          </div>
          <div style={{ fontSize: 32, color: "rgba(245,236,238,0.72)", lineHeight: 1.25 }}>
            We&rsquo;ll bring your shoes out to your lane.
          </div>
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
  rows: {
    key: string;
    name: string;
    value: string;
    status: string | null;
    /** This row is NOT an invitation — the lane is not ready. Drawn back so it cannot
     *  be mistaken across a lobby for one that is. */
    muted?: boolean;
  }[];
  /** What the column says with nothing in it. NOT a blank space: an empty half of a
   *  two-column board reads as a fault, whereas a sentence reads as "nobody yet". */
  empty: string;
  footer?: string | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
      <div
        className="tv-display"
        style={{ fontSize: 40, letterSpacing: "0.2em", color: accent, flexShrink: 0 }}
      >
        {heading}
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 34, color: "rgba(245,236,238,0.5)", lineHeight: 1.3 }}>{empty}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {rows.map((r) => {
            // A muted row keeps its NAME at full strength — the guest must still find
            // themselves on the board — and loses the colour, the glow and the lane. It
            // is the same posture the pricing board takes for a paused product.
            const ink = r.muted ? WALL_ACCENT.quiet : accent;
            const go = r.status === "Ready now" || r.status === "Check in now";
            return (
              <div
                key={r.key}
                style={{
                  borderLeft: `9px solid ${ink}`,
                  background: "rgba(3,8,24,0.74)",
                  borderRadius: "0 18px 18px 0",
                  padding: "22px 26px",
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 18,
                  opacity: r.muted ? 0.62 : 1,
                }}
              >
                <span
                  className="tv-display"
                  style={{ fontSize: 62, color: "#fff", lineHeight: 1, minWidth: 0 }}
                >
                  {r.name}
                </span>
                <span style={{ textAlign: "right", flexShrink: 0 }}>
                  <span
                    className="tv-display"
                    style={{
                      fontSize: 56,
                      color: ink,
                      lineHeight: 1,
                      fontVariantNumeric: "tabular-nums",
                      textShadow: r.muted ? undefined : `0 0 24px ${withAlpha(accent, 0.45)}`,
                    }}
                  >
                    {r.value}
                  </span>
                  {r.status && (
                    <span
                      style={{
                        display: "block",
                        fontSize: 30,
                        fontWeight: 600,
                        marginTop: 10,
                        color: go ? WALL_ACCENT.gel : "rgba(245,236,238,0.55)",
                      }}
                    >
                      {r.status}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {footer && (
        <div style={{ fontSize: 30, color: "rgba(245,236,238,0.62)", lineHeight: 1.3 }}>
          {footer}
        </div>
      )}
    </div>
  );
}
