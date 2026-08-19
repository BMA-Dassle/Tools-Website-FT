"use client";

/**
 * THE CHECK-IN STORY, IN TWO COLUMNS — the front-desk wall's left panel.
 *
 * Left: who can check themselves in right now. Right: who has, and which lane.
 *
 * Both halves, because either alone only speaks to half the lobby. The "checked in"
 * list answers the question a guest has AFTER they have worked out what to do; the
 * "check in now" list is what tells someone walking through the door that they are
 * expected and can go straight to a kiosk instead of queueing at the desk. Read
 * left to right it is the whole journey, which is why it earns a panel of its own
 * rather than a turn in the rotation (owner 2026-08-19).
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

const READY = WALL_ACCENT.cyan;
const WAITING = WALL_ACCENT.arcade;

export function SceneBowlingCheckin({ feed }: SceneProps) {
  const eligible = (feed?.bowlingCheckins?.eligible ?? []).slice(0, MAX_ROWS);
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
            // NAMES THE TWO CHANNELS rather than saying "now" (owner 2026-08-19). It is
            // also the accurate heading for this list specifically: the query keeps only
            // `web` and `kiosk` bookings, so everyone on it either has the confirmation
            // link on their phone or booked at the machine they are standing next to.
            // A guest booked at the desk was already served and is filtered out.
            heading="Check in by phone or kiosk"
            accent={WAITING}
            empty="Nobody waiting to check in."
            rows={eligible.map((g) => ({
              key: `${g.firstName}-${g.timeLabel}`,
              name: g.firstName,
              value: g.timeLabel,
              status: null,
            }))}
          />

          <div aria-hidden style={{ background: "rgba(255,255,255,0.14)" }} />

          <Column
            heading="Checked in"
            accent={READY}
            empty="No lanes assigned yet."
            footer={checkedIn.length > 0 ? "Your shoes are being brought out to you." : null}
            rows={checkedIn.map((g) => ({
              key: `${g.firstName}-${g.lanes}`,
              name: g.firstName,
              value: g.lanes.includes(",") ? `Lanes ${g.lanes}` : `Lane ${g.lanes}`,
              // A lane physically READY reads differently from one merely assigned:
              // the first means walk over now, the second means nearly. The pit boards
              // draw the same distinction for the same reason.
              status: g.laneReady ? "Ready now" : "Getting it ready",
            }))}
          />
        </div>

        {/* The instruction sits under BOTH columns, because it is the answer to the
            left one and the reassurance for the right. Both channels named: a guest who
            booked online has the check-in link in their confirmation, and the kiosks are
            directly below this panel. */}
        <div style={{ fontSize: 30, color: "rgba(245,236,238,0.72)", lineHeight: 1.3 }}>
          Check in on your phone, or at any kiosk below — we&rsquo;ll bring your shoes out to you.
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
