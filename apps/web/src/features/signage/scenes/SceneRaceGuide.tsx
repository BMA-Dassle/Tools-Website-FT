"use client";

/**
 * THE CHECK-IN GUIDE WALL — explains racing, then points at the door.
 *
 * Hangs between the check-in desk and the briefing rooms. Most of the time it
 * runs four cards over real track photography: the shoe rule, the lockers, the
 * qualifying ladder for its own track, and what happens next. Then a heat is
 * sent to a room and the whole wall floods with that track's colour behind a
 * very large arrow.
 *
 * THE TAKEOVER IS THE POINT. It fires on `raceCheckin.briefedAtMs` — the SAME
 * field the check-in board reacts to — so the two screens flip together rather
 * than a poll apart, and it holds longer than the desk's 60 seconds because
 * the desk is finished with a group once they turn around and this wall is not
 * finished until they are through the door.
 *
 * PHOTOGRAPHY FOLLOWS THE SCREEN'S OWN TRACK. A red-lit photo behind a blue
 * accent is the one thing this scene must never do: colour is how a guest
 * tells the two halves of the building apart, and it is the whole payload of
 * the takeover.
 *
 * The arrow is the only moving thing, at the house 1400ms beat (see the
 * rulebook at the top of app/tv/tv.css). The cards do not blink.
 */
import { formatLap } from "~/features/racing/qualify";
import { TRACK_ACCENTS, TRACK_LABELS, type TrackKey } from "../track";
import { withAlpha } from "../color";
import { TV_PHOTOS } from "../assets";
import { TvBrandLogo } from "../components/TvBrandLogo";
import {
  guideCardAt,
  guideCardKey,
  guideCardsFor,
  pickTakeover,
  qualifyBoardFor,
  type GuideCard,
  type GuideSend,
} from "../race-guide";
import type { SignageVenue } from "../constants";
import type { SceneProps } from "../director/types";

/* ── canvas geometry, authored at 1920×1080 ───────────────────────────── */

const PAD_L = 108;
const PAD_R = 96;
const DIM = "rgba(245,236,238,0.80)";

/** THE HOUSE ACCENT for the cards that belong to no track. This wall serves
 *  the whole check-in area, so shoes, lockers and the running order are not
 *  blue or red — only the qualifying cards, whose numbers genuinely differ,
 *  wear a track colour. */
const HOUSE = "#00e2e5";

/** Which photograph a card sits on.
 *
 *  Chosen per CARD rather than per screen now that one wall covers both
 *  tracks: a qualifying card sits on its own track's photo, and the rest
 *  alternate so no two consecutive cards share a background. `raceAction` is
 *  the quiet banked corner — it goes under the cards carrying the most type. */
function plateFor(card: GuideCard): { src: string; position: string } {
  const quiet = TV_PHOTOS.raceAction;
  switch (card.kind) {
    case "shoes":
      return { src: TV_PHOTOS.race, position: "center" };
    case "lockers":
      return { src: quiet, position: "34% 60%" };
    case "qualify":
      return {
        src: card.track === "red" ? TV_PHOTOS.redTrack : TV_PHOTOS.race,
        position: "62% 50%",
      };
    case "night":
    default:
      return { src: quiet, position: "70% 40%" };
  }
}

export function SceneRaceGuide({ feed, nowMs, config, venue }: SceneProps) {
  const cfg = config.raceGuide;
  if (!cfg) return <SetupNotice />;

  // ONE WALL, BOTH TRACKS. The sends come from the guide section rather than
  // `raceCheckin`, which only ever describes the single track a screen is
  // scoped to and so could not serve a screen that belongs to the whole
  // check-in area.
  const sends: GuideSend[] = (feed?.raceGuide?.tracks ?? []).map((t) => ({
    track: t.track,
    // The ROOM is the destination and the TRACK is who is being addressed.
    // Never assumed from one another: on a Mega day both rooms serve one
    // circuit.
    room: t.briefedRoom,
    heatNumber: t.heatNumber,
    raceType: t.raceType,
    briefedAtMs: t.briefedAtMs,
  }));

  const { primary, also } = pickTakeover(sends, nowMs, cfg.holdMs);
  if (primary) {
    return <Takeover send={primary} also={also} venue={venue} arrow={cfg.arrow} />;
  }

  const cards = guideCardsFor(cfg.tracks);
  return <Card venue={venue} card={guideCardAt(nowMs, cards)} cards={cards} />;
}

/* ── the rotation ─────────────────────────────────────────────────────── */

function Card({
  venue,
  card,
  cards,
}: {
  venue: SignageVenue;
  card: GuideCard;
  cards: readonly GuideCard[];
}) {
  const accent = card.kind === "qualify" ? TRACK_ACCENTS[card.track] : HOUSE;
  const plate = plateFor(card);
  return (
    <div style={{ position: "absolute", inset: 0, background: "#000418", overflow: "hidden" }}>
      {/* Mounted at -4% so the Ken Burns drift can never reveal an edge. */}
      <div
        aria-hidden
        className="tv-kenburns"
        style={{
          position: "absolute",
          inset: "-4%",
          backgroundImage: `url(${plate.src})`,
          backgroundPosition: plate.position,
          backgroundSize: "cover",
        }}
      />
      {/* The type sits on the dark end of this, the photograph breathes on the
          light end. A flat scrim would either wash the picture out or leave the
          headline unreadable — the gradient is what lets both work. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(97deg, rgba(0,4,24,0.96) 0%, rgba(0,4,24,0.93) 34%," +
            " rgba(0,4,24,0.62) 58%, rgba(0,4,24,0.30) 78%, rgba(0,4,24,0.55) 100%)",
        }}
      />
      <div
        aria-hidden
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 12, background: accent }}
      />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          padding: `62px ${PAD_R}px 72px ${PAD_L}px`,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <TvBrandLogo venue={venue} height={64} />
          <Dots cards={cards} current={card} accent={accent} />
        </div>
        <div
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <CardBody card={card} accent={accent} />
        </div>
      </div>
    </div>
  );
}

function Dots({
  cards,
  current,
  accent,
}: {
  cards: readonly GuideCard[];
  current: GuideCard;
  accent: string;
}) {
  const currentKey = guideCardKey(current);
  return (
    <div style={{ display: "flex", gap: 12 }}>
      {cards.map((card) => {
        const c = guideCardKey(card);
        return (
          <span
            key={c}
            style={{
              width: 15,
              height: 15,
              borderRadius: 999,
              display: "block",
              background: c === currentKey ? accent : "rgba(255,255,255,0.24)",
              boxShadow: c === currentKey ? `0 0 18px ${accent}` : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

function Eyebrow({ accent, children }: { accent: string; children: React.ReactNode }) {
  return (
    <div className="tv-eyebrow" style={{ color: accent, fontSize: 28, letterSpacing: "0.32em" }}>
      {children}
    </div>
  );
}

function Rule({ accent }: { accent: string }) {
  return (
    <div
      aria-hidden
      style={{ width: 132, height: 8, background: accent, borderRadius: 4, marginBottom: 28 }}
    />
  );
}

/** Line breaks are AUTHORED, not left to the wrap. Two lines of near-equal
 *  length; a headline that orphans one word on its own line is what "the
 *  headlines don't look clean" meant (owner 2026-08-15). */
function CardBody({ card, accent }: { card: GuideCard; accent: string }) {
  if (card.kind === "shoes") {
    return (
      <>
        <Eyebrow accent={accent}>Before you race</Eyebrow>
        <div className="tv-display" style={{ fontSize: 138, margin: "22px 0 30px", color: "#fff" }}>
          Closed-toe shoes
          <br />
          required
        </div>
        <Rule accent={accent} />
        <p style={{ fontSize: 46, color: DIM, margin: 0, maxWidth: "22ch", lineHeight: 1.24 }}>
          No sandals, no flip-flops, no open heels &mdash;{" "}
          <b style={{ color: "#fff", fontWeight: 700 }}>every driver, every race.</b>
        </p>
      </>
    );
  }

  if (card.kind === "lockers") {
    return (
      <>
        <Eyebrow accent={accent}>Before you race</Eyebrow>
        <div className="tv-display" style={{ fontSize: 104, margin: "22px 0 30px", color: "#fff" }}>
          Lockers in the
          <br />
          briefing rooms
        </div>
        <Rule accent={accent} />
        <p style={{ fontSize: 46, color: DIM, margin: 0, maxWidth: "22ch", lineHeight: 1.24 }}>
          Leave bags, keys and loose items before you gear up.
        </p>
      </>
    );
  }

  if (card.kind === "qualify") return <QualifyCard track={card.track} accent={accent} />;

  return (
    <>
      <Eyebrow accent={accent}>What happens next</Eyebrow>
      <div className="tv-display" style={{ fontSize: 88, margin: "22px 0 26px", color: "#fff" }}>
        From here to
        <br />
        the green flag
      </div>
      <Steps accent={accent} />
      <p style={{ fontSize: 35, color: DIM, margin: "34px 0 0", maxWidth: "40ch" }}>
        Watch this screen &mdash; it points you to your briefing room when your session is ready.
      </p>
    </>
  );
}

/**
 * ONE CARD PER TRACK (owner 2026-08-15: "just need one for blue and one for
 * red when it comes to qualifications").
 *
 * The two adult steps are the card, big, because they are the only numbers
 * that differ between the Blue screen and the Red one. The junior ladder is a
 * single pair of numbers venue-wide, so it rides as a footnote rather than
 * pretending to be track-specific and doubling the height of the table.
 */
function QualifyCard({ track, accent }: { track: TrackKey; accent: string }) {
  const board = qualifyBoardFor(track);
  return (
    <>
      <Eyebrow accent={accent}>How you move up</Eyebrow>
      <div className="tv-display" style={{ fontSize: 88, margin: "22px 0 30px", color: "#fff" }}>
        Beat the time,
        <br />
        earn the class
      </div>
      <div style={{ display: "grid", gap: 16, maxWidth: 1240 }}>
        {board.adult.map((r) => (
          <div
            key={r.from}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 26,
              background: "rgba(0,4,24,0.62)",
              border: "1px solid rgba(255,255,255,0.14)",
              borderLeft: `7px solid ${accent}`,
              borderRadius: 18,
              padding: "24px 32px",
            }}
          >
            <span style={{ flex: "0 0 340px", fontSize: 48, fontWeight: 650, color: DIM }}>
              {r.from}
            </span>
            <span
              aria-hidden
              style={{ flex: "0 0 auto", fontSize: 36, color: "rgba(245,236,238,0.45)" }}
            >
              &rarr;
            </span>
            <span style={{ flex: "1 1 auto", fontSize: 50, fontWeight: 800, color: accent }}>
              {r.to}
            </span>
            <span
              className="tv-num"
              style={{ flex: "0 0 auto", fontSize: 62, fontWeight: 800, color: "#fff" }}
            >
              {formatLap(r.ms)}
            </span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 35, color: DIM, margin: "30px 0 0", maxWidth: "52ch" }}>
        Your best lap on the <b style={{ color: "#fff", fontWeight: 700 }}>{board.trackLabel}</b>{" "}
        &mdash; set it in any race.{" "}
        <span style={{ color: "rgba(245,236,238,0.62)" }}>
          Juniors:{" "}
          {board.junior.map((r, i) => (
            <span key={r.from}>
              {i > 0 ? " · " : ""}
              {r.to} at <span className="tv-num">{formatLap(r.ms)}</span>
            </span>
          ))}
        </span>
      </p>
    </>
  );
}

const NIGHT_STEPS = ["Check in", "Safety briefing", "Gear up", "Into the karts", "Green flag"];

function Steps({ accent }: { accent: string }) {
  return (
    <div style={{ display: "flex", gap: 14, maxWidth: 1420 }}>
      {NIGHT_STEPS.map((w, i) => (
        <div
          key={w}
          style={{
            flex: "1 1 0",
            minWidth: 0,
            background: i === 0 ? withAlpha(accent, 0.26) : "rgba(0,4,24,0.66)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderTop: `7px solid ${i === 0 ? accent : "rgba(255,255,255,0.18)"}`,
            borderRadius: 18,
            padding: "22px 20px",
          }}
        >
          <div
            className="tv-num"
            style={{
              fontSize: 23,
              fontWeight: 700,
              letterSpacing: "0.1em",
              color: i === 0 ? "#fff" : "rgba(245,236,238,0.6)",
            }}
          >
            {String(i + 1).padStart(2, "0")}
          </div>
          <div
            style={{ fontSize: 33, fontWeight: 700, color: "#fff", marginTop: 8, lineHeight: 1.1 }}
          >
            {w}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── the takeover ─────────────────────────────────────────────────────── */

/** How dark the far end of the wash goes, per track. Deep enough that white
 *  display type at 244px has a ground, saturated enough that the screen still
 *  reads as that track's colour from the other end of the building. */
const TRACK_DEEP: Record<TrackKey, string> = {
  blue: "#04173a",
  red: "#2a0604",
  mega: "#170538",
};

function Takeover({
  send,
  also,
  venue,
  arrow,
}: {
  send: GuideSend;
  /** Any other group also walking right now — named, never dropped. */
  also: GuideSend[];
  venue: SignageVenue;
  arrow: "left" | "right";
}) {
  const { track, room, heatNumber, raceType } = send;
  const accent = TRACK_ACCENTS[track];
  const deep = TRACK_DEEP[track];
  const photo = track === "red" ? TV_PHOTOS.redTrack : TV_PHOTOS.race;
  const pointsLeft = arrow !== "right";

  return (
    <div style={{ position: "absolute", inset: 0, background: deep, overflow: "hidden" }}>
      <div
        aria-hidden
        className="tv-kenburns"
        style={{
          position: "absolute",
          inset: "-4%",
          backgroundImage: `url(${photo})`,
          backgroundPosition: "center",
          backgroundSize: "cover",
        }}
      />
      {/* Bright under the arrow, deep under the words. One flat colour cannot
          hold both a white arrow and 244px of white type — one of them always
          loses. Mirrored when the arrow points right so the type keeps its
          dark ground. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `linear-gradient(${pointsLeft ? 100 : 260}deg, ${withAlpha(accent, 0.78)} 0%, ${withAlpha(accent, 0.52)} 42%, ${withAlpha(deep, 0.94)} 78%, ${deep} 100%)`,
        }}
      />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: pointsLeft ? "row" : "row-reverse",
          alignItems: "center",
          gap: 56,
          padding: "0 92px 96px",
          boxSizing: "border-box",
        }}
      >
        {/* THE FLIP IS ON THIS WRAPPER, never on the animated child — see the
            note by tv-arrow-nudge in tv.css. One node carrying both would have
            the mirror and the nudge fight over transform order, and the arrow
            would travel backwards on a right-pointing screen. */}
        <div
          style={{
            flex: "0 0 660px",
            display: "flex",
            justifyContent: "center",
            transform: pointsLeft ? undefined : "scaleX(-1)",
          }}
        >
          <svg
            className="tv-arrow-nudge"
            viewBox="0 0 100 62"
            aria-hidden="true"
            style={{ width: 660, height: 420, filter: "drop-shadow(0 0 60px rgba(0,0,0,0.45))" }}
          >
            <path d="M42 2 L3 31 L42 60 L42 41 L98 41 L98 21 L42 21 Z" fill="#ffffff" />
          </svg>
        </div>

        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          {/* WHO THIS IS FOR, before the instruction it is attached to. An
              instruction with no addressee is obeyed by everybody in the
              building, including the heat that has not been called — the
              check-in board already had to learn this. */}
          {heatNumber != null && (
            <div
              className="tv-num"
              style={{
                display: "inline-block",
                fontSize: 44,
                fontWeight: 800,
                color: "#fff",
                background: "rgba(0,0,0,0.30)",
                border: "2px solid rgba(255,255,255,0.32)",
                padding: "8px 26px",
                borderRadius: 999,
                marginBottom: 26,
              }}
            >
              Session {heatNumber}
              {raceType ? ` · ${raceType}` : ""}
            </div>
          )}
          <div
            className="tv-display"
            style={{ fontSize: 104, color: "rgba(255,255,255,0.86)", marginBottom: 8 }}
          >
            Proceed to the
          </div>
          <div
            className="tv-display"
            style={{
              fontSize: 244,
              color: "#fff",
              lineHeight: 0.86,
              textShadow: "0 0 90px rgba(0,0,0,0.4)",
            }}
          >
            {/* A room we could not resolve still gets an instruction — "see the
                desk" is useless, but "briefing room" at least moves them off
                the check-in point. */}
            {room ? `${room} room` : "briefing room"}
          </div>
          <div
            style={{
              fontSize: 48,
              color: "rgba(255,255,255,0.88)",
              marginTop: 30,
              fontWeight: 600,
            }}
          >
            Your safety briefing starts shortly
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 96,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 92px",
          boxSizing: "border-box",
          background: "rgba(0,0,0,0.42)",
          borderTop: "3px solid rgba(255,255,255,0.22)",
        }}
      >
        {/* ONE WALL, SOMETIMES TWO GROUPS. The newest send owns the screen;
            anyone else still walking is named here rather than dropped, so a
            group that was sent a minute ago is not abandoned by the wall the
            moment the other track goes. Falls back to the line staff repeat to
            every single group. */}
        {also.length > 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 18, minWidth: 0 }}>
            {also.map((s) => (
              <div
                key={s.track}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  fontSize: 30,
                  fontWeight: 700,
                  color: "#fff",
                  background: withAlpha(TRACK_ACCENTS[s.track], 0.32),
                  border: `2px solid ${TRACK_ACCENTS[s.track]}`,
                  borderRadius: 999,
                  padding: "6px 22px",
                  whiteSpace: "nowrap",
                }}
              >
                <span className="tv-num">
                  {s.heatNumber != null ? `Session ${s.heatNumber}` : "Also"}
                </span>
                <span aria-hidden style={{ opacity: 0.7 }}>
                  &rarr;
                </span>
                <span style={{ textTransform: "uppercase" }}>
                  {s.room ? `${s.room} room` : "briefing room"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 32, fontWeight: 700, color: "#fff" }}>
            Please do not put on helmets before the video
          </div>
        )}
        <TvBrandLogo venue={venue} height={46} />
      </div>
    </div>
  );
}

/** Provisioned but nobody has picked a track. Staff-facing, and it names the
 *  exact place to fix it rather than just refusing. */
function SetupNotice() {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#000418" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "0 160px",
        }}
      >
        <div className="tv-eyebrow">Check-in screen</div>
        <div className="tv-display" style={{ fontSize: 76, margin: "18px 0 20px" }}>
          Not set up yet
        </div>
        <div style={{ fontSize: 32, color: "rgba(245,236,238,0.62)", maxWidth: 1100 }}>
          Tick &ldquo;Check-in screen&rdquo; for this screen on the signage admin page. It covers
          both {TRACK_LABELS.blue} and {TRACK_LABELS.red} from one wall.
        </div>
      </div>
    </div>
  );
}
