"use client";

/**
 * A briefing room's TV.
 *
 * One staff press starts a sequence this screen then runs on its own:
 *
 *     safety video (with sound)  →  helmet sizes ~30s  →  who levelled up
 *
 * EVERY PHASE IS DERIVED FROM THE CLOCK, never remembered (briefing/phase.ts).
 * The video seeks to `nowMs - triggeredAtMs`, so a player that reboots four
 * minutes into a five-minute briefing comes back four minutes in rather than
 * starting the safety film over on a room that has already watched it.
 *
 * SOUND IS ON. This is the one screen on the estate that must be heard — it is a
 * safety briefing, not signage. The generated player script already ships
 * `--autoplay-policy=no-user-gesture-required` (startup-script.ts), which is what
 * lets an unmuted video autoplay with nobody to click anything.
 *
 * IDLE IS A DESIGNED STATE, not a fallback. A briefing room between groups shows
 * helmet sizing, because the next group walks in and starts looking for their
 * size before anybody presses anything.
 */
import { useEffect, useRef, useState } from "react";
import { IconAlertTriangleFilled } from "@tabler/icons-react";
import { withAlpha } from "../color";
import { TRACK_ACCENTS } from "../track";
import { briefingTimelineAt } from "../briefing/phase";
import { tierForRaceType, type BriefingQualifier, type BriefingRoom } from "../briefing/types";
import { useBriefingAssets } from "../briefing/useBriefingAssets";
import { demoBriefingRooms } from "../demo";
import type { SceneProps } from "../director/types";

const PAD_X = 96;
const PAD_Y = 54;

/** Room identity colours. A briefing room is named for the track it serves, so
 *  it borrows that track's accent — someone glancing in from the corridor should
 *  know which room they are looking into. */
const ROOM_ACCENT: Record<BriefingRoom, string> = {
  red: TRACK_ACCENTS.red,
  blue: TRACK_ACCENTS.blue,
};

const ROOM_LABEL: Record<BriefingRoom, string> = { red: "Red Briefing", blue: "Blue Briefing" };

export function SceneBriefing({ feed, nowMs, config, demo }: SceneProps) {
  const room = config.briefingRoom;
  const assets = useBriefingAssets(feed?.briefing ?? null, !!room);

  // A screen configured as a briefing TV with no room chosen cannot know which
  // of the two states is addressed to it. Say so, quietly, rather than adopting
  // a room at random — this is a setup mistake and a staff member needs to see
  // it, but guests may be in the room, so it stays calm.
  if (!room) return <Unconfigured />;

  const accent = ROOM_ACCENT[room];
  // BOTH briefing previews substitute a room state — `briefing-quals` too, which
  // is the one staff reach for most (it skips the five-minute film).
  const previewing = demo === "briefing" || demo === "briefing-quals";
  const rooms = previewing ? demoBriefingRooms(nowMs, feed, demo) : feed?.briefingRooms;
  const state = rooms?.[room] ?? null;
  const timeline = briefingTimelineAt(state, nowMs);

  const tier = state?.tier ?? tierForRaceType(null);
  const videoSrc = assets.srcFor(tier);
  const quals = feed?.briefing?.quals ?? null;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {timeline.phase === "video" && videoSrc ? (
        <BriefingVideo
          // Keyed on the send, so a NEW briefing remounts the element and starts
          // its own playback — and a re-render inside one briefing does not.
          key={`${state?.sessionId ?? "none"}:${state?.triggeredAtMs ?? 0}`}
          src={videoSrc}
          seekToMs={timeline.videoOffsetMs}
        />
      ) : (
        <Board
          accent={accent}
          room={room}
          phase={timeline.phase === "video" ? "helmet" : timeline.phase}
          posterSrc={assets.posterSrc}
          quals={quals}
          heatNumber={state?.heatNumber ?? null}
        />
      )}
    </div>
  );
}

/* ── the video ────────────────────────────────────────────────────────── */

/**
 * The safety film, full-bleed, with sound.
 *
 * Seeks once on mount and then leaves playback alone. Continuously correcting
 * against the clock would be wrong here: unlike the kiosk billboard (where two
 * screens must show the same frame), a briefing room has ONE screen and the
 * audience is watching content, so a mid-video seek would be a visible stutter
 * for no benefit. The seek exists purely so a reboot rejoins in the right place.
 */
function BriefingVideo({ src, seekToMs }: { src: string; seekToMs: number }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only seek a genuine rejoin. Seeking to ~0 on a normal start can cost a
    // keyframe decode for nothing.
    if (seekToMs > 2_000) {
      try {
        el.currentTime = seekToMs / 1000;
      } catch {
        /* not seekable yet — playback simply starts from the beginning */
      }
    }
    const play = async () => {
      try {
        await el.play();
      } catch {
        // Autoplay refused (a browser without the player's autoplay flag, e.g.
        // a laptop previewing the screen). Fall back to muted, which every
        // browser allows, so a reviewer still sees the film.
        try {
          el.muted = true;
          await el.play();
        } catch {
          setFailed(true);
        }
      }
    };
    void play();
  }, [seekToMs, src]);

  if (failed) {
    return (
      <Centered>
        <span className="tv-display" style={{ fontSize: 92, color: "#fff" }}>
          Briefing starting…
        </span>
      </Centered>
    );
  }

  return (
    /* CAPTIONS: no caption file exists for the briefing films yet. Worth having —
       this is the one video on the estate a guest is required to absorb — but a
       <track> pointing at nothing is worse than none, because it advertises
       captions that never appear. Add the VTT and the track in the same change.
       Staff brief deaf guests in person in the meantime. */
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      ref={ref}
      src={src}
      autoPlay
      playsInline
      // NOT muted, NOT looping. It is a briefing: it is heard once, and it ends.
      controls={false}
      onError={() => setFailed(true)}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
    />
  );
}

/* ── the boards ───────────────────────────────────────────────────────── */

function Board({
  accent,
  room,
  phase,
  posterSrc,
  quals,
  heatNumber,
}: {
  accent: string;
  room: BriefingRoom;
  phase: "helmet" | "quals" | "idle";
  posterSrc: string | null;
  quals: {
    heatNumber: number | null;
    raceType: string | null;
    qualifiers: BriefingQualifier[];
  } | null;
  heatNumber: number | null;
}) {
  // The qualification board only earns the wall when it has names. Reaching the
  // quals phase with nobody to congratulate falls back to helmet sizing, which is
  // always useful — never an empty "no qualifiers" panel in front of a group.
  const showQuals = phase === "quals" && (quals?.qualifiers.length ?? 0) > 0;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 16,
          background: accent,
          boxShadow: `0 0 60px ${accent}`,
          zIndex: 2,
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(75% 65% at 50% 35%, ${withAlpha(accent, 0.4)}, transparent 74%)`,
        }}
      />

      {showQuals ? (
        <QualsBoard accent={accent} room={room} quals={quals!} />
      ) : (
        <HelmetBoard
          accent={accent}
          room={room}
          posterSrc={posterSrc}
          heatNumber={phase === "helmet" ? heatNumber : null}
        />
      )}
    </div>
  );
}

/**
 * Helmet sizing — the poster the owner supplies, full-bleed.
 *
 * `contain`, not `cover`: this is an information graphic and cropping it would
 * cut a size off the chart. Until a poster is uploaded the board shows a plain
 * sizing instruction rather than a black rectangle, so a room is never blank.
 */
function HelmetBoard({
  accent,
  room,
  posterSrc,
  heatNumber,
}: {
  accent: string;
  room: BriefingRoom;
  posterSrc: string | null;
  heatNumber: number | null;
}) {
  if (posterSrc) {
    return (
      <>
        {/* eslint-disable-next-line @next/next/no-img-element -- the poster is
            usually a blob: object URL served from the player's own cache, which
            next/image cannot take as a source. Same reason the kiosk's own media
            bypasses the optimizer (features/kiosk/assets.ts). */}
        <img
          src={posterSrc}
          alt=""
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            background: "#000418",
          }}
        />
        {heatNumber != null && (
          <div
            className="tv-display"
            style={{
              position: "absolute",
              left: PAD_X,
              bottom: PAD_Y,
              fontSize: 44,
              color: "#fff",
              padding: "10px 28px",
              borderRadius: 999,
              background: withAlpha(accent, 0.55),
              zIndex: 3,
            }}
          >
            Session {heatNumber} · grab your helmet
          </div>
        )}
      </>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: `${PAD_Y}px ${PAD_X}px`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 24,
      }}
    >
      <span className="tv-eyebrow" style={{ color: accent, fontSize: 38 }}>
        {ROOM_LABEL[room]}
      </span>
      <div className="tv-display" style={{ fontSize: 150, color: "#fff", lineHeight: 0.95 }}>
        Helmet sizes
      </div>
      <p style={{ fontSize: 46, color: "rgba(245,236,238,0.66)", margin: 0, maxWidth: 1300 }}>
        Find your size on the rack, then take a seat. Staff will fit you before you head out to the
        karts.
      </p>
      <div
        aria-hidden
        style={{
          width: 260,
          height: 5,
          borderRadius: 3,
          background: `linear-gradient(90deg, ${accent}, ${withAlpha(accent, 0)})`,
        }}
      />
    </div>
  );
}

/**
 * Who levelled up in the session that just finished.
 *
 * The reason this board exists: a racer's level-up text arrives on their phone,
 * which is in a locker. Putting it on the wall of the room they walk back into
 * means the group sees it together — and the room they walk back into is the room
 * they briefed in, which is exactly why the send is recorded.
 */
function QualsBoard({
  accent,
  room,
  quals,
}: {
  accent: string;
  room: BriefingRoom;
  quals: { heatNumber: number | null; raceType: string | null; qualifiers: BriefingQualifier[] };
}) {
  const names = quals.qualifiers;
  // Sized so a full grid still reads from the back of the room.
  const nameSize = names.length > 8 ? 62 : names.length > 4 ? 78 : 96;

  return (
    <div
      style={{
        position: "absolute",
        inset: `${PAD_Y}px ${PAD_X}px`,
        display: "flex",
        flexDirection: "column",
        gap: 26,
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
        <span className="tv-eyebrow" style={{ color: accent, fontSize: 38 }}>
          {ROOM_LABEL[room]}
        </span>
        {quals.heatNumber != null && (
          <span style={{ fontSize: 34, color: "rgba(245,236,238,0.6)" }}>
            Session {quals.heatNumber}
            {quals.raceType ? ` · ${quals.raceType}` : ""}
          </span>
        )}
      </header>

      <div
        className="tv-display tv-rise"
        style={{ fontSize: 118, color: "#fff", lineHeight: 0.95 }}
      >
        Levelled up
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexWrap: "wrap",
          alignContent: "flex-start",
          gap: 18,
        }}
      >
        {names.map((q, i) => (
          <span
            key={`${q.firstName}-${i}`}
            className="tv-display tv-rise"
            style={{
              fontSize: nameSize,
              color: "#fff",
              padding: "12px 34px",
              borderRadius: 999,
              border: `2px solid ${withAlpha(accent, 0.6)}`,
              background: withAlpha(accent, 0.2),
              whiteSpace: "nowrap",
              display: "inline-flex",
              alignItems: "baseline",
              gap: 18,
            }}
          >
            {q.firstName}
            <span className="tv-num" style={{ fontSize: nameSize * 0.42, color: accent }}>
              {q.level} · {q.bestLap}s
            </span>
          </span>
        ))}
      </div>

      <p style={{ fontSize: 40, color: "rgba(245,236,238,0.6)", margin: 0 }}>
        See the desk to book your next race at the new level.
      </p>
    </div>
  );
}

/* ── setup states ─────────────────────────────────────────────────────── */

function Unconfigured() {
  return (
    <Centered>
      <div style={{ textAlign: "center", display: "grid", gap: 18, justifyItems: "center" }}>
        <IconAlertTriangleFilled size={96} color="#f0b341" />
        <span className="tv-display" style={{ fontSize: 84, color: "#fff" }}>
          Briefing screen
        </span>
        <span style={{ fontSize: 40, color: "rgba(245,236,238,0.66)" }}>
          Pick Red or Blue for this screen on the Lobby TVs admin page.
        </span>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#000418",
        padding: PAD_X,
      }}
    >
      {children}
    </div>
  );
}
