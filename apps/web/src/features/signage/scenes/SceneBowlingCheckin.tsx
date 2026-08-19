"use client";

/**
 * WHO CHECKED THEMSELVES IN, AND WHICH LANE — the front-desk wall's left panel.
 *
 * A guest who checked in at a kiosk was never told a lane number by a person. This
 * board is the only place they learn it, which is why it exists and why it sits at
 * the end of the wall nearest the lanes rather than taking a turn in the rotation.
 *
 * IT ALSO ANSWERS THE QUESTION THEY ASK NEXT. Self check-in doesn't hand out shoes,
 * so every guest on this list is about to wonder about them — the board says their
 * shoes are being brought out, standing, so nobody has to queue at the desk to ask.
 *
 * FIRST NAMES ONLY. Printed a foot tall in a public lobby, so it follows the same PII
 * posture as every other board on the estate: the server reduces to a first name
 * before this ever sees it.
 *
 * A WING IS A COMPOSITION OF ONE. This scene never spans, so it takes no position
 * from `choreo()` — which is also what makes it safe for it to appear and disappear
 * with the data while the middle three carry on unchanged. See SceneSpan.
 */
import type { SceneProps } from "../director/types";
import { WALL_ACCENT } from "../wall-content";
import { TV_PHOTOS } from "../assets";
import { WallGround } from "../components/WallPanel";
import { withAlpha } from "../color";

/** How many fit legibly before the rows get too short to read from across a lobby.
 *  The server asks for eight; this is the visual ceiling. */
const MAX_ROWS = 6;

export function SceneBowlingCheckin({ feed }: SceneProps) {
  const rows = (feed?.bowlingCheckins ?? []).slice(0, MAX_ROWS);
  const accent = WALL_ACCENT.cyan;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <WallGround photo={TV_PHOTOS.bowl} accent={accent} deepScrim />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          gap: 26,
          padding: "77px 78px 88px",
        }}
      >
        <div>
          <div
            className="tv-display"
            style={{
              fontSize: 78,
              lineHeight: 0.94,
              color: "#fff",
              textShadow: `0 0 8px rgba(255,255,255,0.82), 0 0 56px ${accent}`,
            }}
          >
            Checked in
          </div>
          <div
            className="tv-display"
            style={{ fontSize: 32, letterSpacing: "0.2em", color: accent, marginTop: 14 }}
          >
            Your lane is ready
          </div>
        </div>

        {rows.length > 0 ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {rows.map((r) => (
                <Row key={`${r.firstName}-${r.lanes}`} row={r} accent={accent} />
              ))}
            </div>
            {/* STANDING, not per-row: it is true of everyone on the list, and repeating
                it six times would crowd out the lanes, which are the reason to look. */}
            <div style={{ fontSize: 30, color: "rgba(245,236,238,0.72)", lineHeight: 1.3 }}>
              Your shoes are being brought out to you.
            </div>
          </>
        ) : (
          // NOT AN ERROR, and not a blank panel. Nobody has self-checked in yet, which
          // is the normal state early in the evening — so the panel says what to do
          // instead of what is missing. The wall never widens to cover this; a quiet
          // wing is still a wing (see SceneSpan).
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ fontSize: 40, color: "rgba(245,236,238,0.9)", lineHeight: 1.25 }}>
              Check in at any kiosk below and your lane will show up here.
            </div>
            <div style={{ fontSize: 30, color: "rgba(245,236,238,0.62)", lineHeight: 1.3 }}>
              We&rsquo;ll bring your shoes out to you.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  row,
  accent,
}: {
  row: { firstName: string; lanes: string; laneReady: boolean };
  accent: string;
}) {
  // A lane that is physically READY reads differently from one that is merely
  // assigned — the first means "walk over now", the second means "nearly". Staff
  // asked for that distinction on the pit boards for the same reason.
  const ink = row.laneReady ? accent : "rgba(245,236,238,0.72)";
  return (
    <div
      style={{
        borderLeft: `8px solid ${ink}`,
        background: "rgba(3,8,24,0.76)",
        borderRadius: "0 17px 17px 0",
        padding: "24px 30px",
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 22,
      }}
    >
      <span className="tv-display" style={{ fontSize: 52, color: "#fff", lineHeight: 1 }}>
        {row.firstName}
      </span>
      <span style={{ textAlign: "right", flexShrink: 0 }}>
        <span
          className="tv-display"
          style={{
            fontSize: 52,
            color: ink,
            lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
            textShadow: row.laneReady ? `0 0 24px ${withAlpha(accent, 0.5)}` : undefined,
          }}
        >
          {row.lanes.includes(",") ? `Lanes ${row.lanes}` : `Lane ${row.lanes}`}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 26,
            fontWeight: 600,
            marginTop: 10,
            color: row.laneReady ? WALL_ACCENT.gel : "rgba(245,236,238,0.45)",
          }}
        >
          {row.laneReady ? "Ready now" : "Getting it ready"}
        </span>
      </span>
    </div>
  );
}
