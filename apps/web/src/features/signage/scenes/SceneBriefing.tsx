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
import { nextLevelTarget } from "~/features/racing/qualify";
import { TRACK_ACCENTS, TRACK_LABELS } from "../track";
import { briefingTimelineAt } from "../briefing/phase";
import { tierForRaceType, type BriefingInbound, type BriefingRoom } from "../briefing/types";
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

  /**
   * A ROOM MUST NEVER GO BLACK.
   *
   * If the film cannot be decoded here — an HEVC or ProRes master this player has no
   * decoder for — Edge paints a black rectangle and holds it (owner 2026-08-11: "in
   * blue I'm getting briefing starting then it blacks out… that's a .mov"). Black is
   * the worst possible output: a room full of people, staff assuming the briefing is
   * running, and nothing on the wall to say otherwise. On failure the scene hands the
   * wall back to the helmet board, which is at least useful.
   *
   * Keyed by src so a re-upload of a working film clears the failure with no reload,
   * and so one bad file cannot poison the other tier.
   *
   * DECLARED HERE, above the `!room` early return below — a hook behind a conditional
   * return is a rules-of-hooks crash, not a lint nit.
   */
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

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
  const videoUnplayable = !!videoSrc && failedSrc === videoSrc;

  const inbound = feed?.briefing?.inbound ?? null;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {timeline.phase === "waiting" ? (
        <TakeASeat
          accent={accent}
          heatNumber={state?.heatNumber ?? null}
          // The session's real level, NOT which film plays — a Pro grid must not
          // be told they are in a Starter race (owner 2026-08-11).
          raceType={state?.raceType ?? null}
          trackLabel={state?.track ? TRACK_LABELS[state.track] : null}
          target={state?.track ? nextLevelTarget(state.track, state.raceType) : null}
        />
      ) : timeline.phase === "video" && videoSrc && !videoUnplayable ? (
        <BriefingVideo
          // Keyed on the send, so a NEW briefing remounts the element and starts
          // its own playback — and a re-render inside one briefing does not.
          key={`${state?.sessionId ?? "none"}:${state?.triggeredAtMs ?? 0}`}
          src={videoSrc}
          seekToMs={timeline.videoOffsetMs}
          onUnplayable={() => setFailedSrc(videoSrc)}
        />
      ) : (
        <Board
          accent={accent}
          room={room}
          phase={timeline.phase === "video" ? "helmet" : timeline.phase}
          posterSrc={assets.posterSrc}
          inbound={inbound}
          heatNumber={state?.heatNumber ?? null}
          // The lap THIS room's group has to beat. They sit through the helmet and
          // next-race boards, which is when there is actually time to read it.
          target={state?.track ? nextLevelTarget(state.track, state.raceType) : null}
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
function BriefingVideo({
  src,
  seekToMs,
  onUnplayable,
}: {
  src: string;
  seekToMs: number;
  /** This player cannot decode the file — hand the wall back to the scene. */
  onUnplayable: () => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

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
          onUnplayable();
        }
      }
    };
    void play();

    // DECODING, not merely loading. A container Edge can parse but not decode
    // reports metadata happily and then paints black forever, so the real test is
    // whether a frame ever arrives: videoWidth stays 0 and readyState never reaches
    // HAVE_CURRENT_DATA. Checked shortly after play rather than on an error event,
    // because this failure mode raises no error at all.
    const decodeCheck = setTimeout(() => {
      const v = ref.current;
      if (!v) return;
      const noPicture = !v.videoWidth || !v.videoHeight;
      const noFrame = v.readyState < 2; // HAVE_CURRENT_DATA
      if (noPicture || noFrame) onUnplayable();
    }, 6_000);
    return () => clearTimeout(decodeCheck);
  }, [seekToMs, src, onUnplayable]);

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
      onError={onUnplayable}
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
  inbound,
  heatNumber,
  target,
}: {
  accent: string;
  room: BriefingRoom;
  phase: "helmet" | "idle";
  posterSrc: string | null;
  inbound: BriefingInbound | null;
  heatNumber: number | null;
  target: { level: string; ms: number } | null;
}) {
  // A FREE ROOM SHOWS WHAT IS COMING. Idle is the resting state: helmets are done,
  // the group has gone racing, and the useful thing on the wall is the next heat
  // inbound. Nothing inbound falls back to helmet sizing, which is always useful —
  // never an empty panel.
  const showNext = phase === "idle" && !!inbound && inbound.heatNumber != null;

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

      {showNext ? (
        <NextRaceBoard accent={accent} room={room} inbound={inbound!} target={target} />
      ) : (
        <HelmetBoard
          accent={accent}
          room={room}
          posterSrc={posterSrc}
          heatNumber={phase === "helmet" ? heatNumber : null}
          target={phase === "helmet" ? target : null}
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
  target,
}: {
  accent: string;
  room: BriefingRoom;
  posterSrc: string | null;
  heatNumber: number | null;
  target: { level: string; ms: number } | null;
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
        <div
          style={{
            position: "absolute",
            left: PAD_X,
            bottom: PAD_Y,
            display: "flex",
            alignItems: "center",
            gap: 20,
            flexWrap: "wrap",
            maxWidth: 1700,
            zIndex: 3,
          }}
        >
          {heatNumber != null && (
            <div
              className="tv-display"
              style={{
                fontSize: 44,
                color: "#fff",
                padding: "10px 28px",
                borderRadius: 999,
                background: withAlpha(accent, 0.55),
              }}
            >
              Session {heatNumber} · grab your helmet
            </div>
          )}
          {target && <QualifyTarget accent={accent} target={target} compact />}
        </div>
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
      {target && <QualifyTarget accent={accent} target={target} />}

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
 * WHAT IS COMING TO THIS ROOM NEXT — the third phase.
 *
 * This slot used to be a "who levelled up" board. That is PARKED (owner
 * 2026-08-11: "for qualifying just hold on that, there might be a better way…
 * instead of qualifying you could just show the inbound race to that room"), and
 * the probe backed the decision up: qualifying cutoffs exist per-track only, so
 * nobody can qualify off a Mega lap, and Pandora's records API was 503-ing.
 *
 * The inbound heat always has data, comes from the same warmed keys the track
 * boards read, and is what a room actually wants to know once the film has ended —
 * a group waiting to be called can see how close they are.
 */
function NextRaceBoard({
  accent,
  room,
  inbound,
  target,
}: {
  accent: string;
  room: BriefingRoom;
  inbound: BriefingInbound;
  target: { level: string; ms: number } | null;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: `${PAD_Y}px ${PAD_X}px`,
        display: "flex",
        flexDirection: "column",
        gap: 24,
        justifyContent: "center",
      }}
    >
      <span className="tv-eyebrow" style={{ color: accent, fontSize: 40 }}>
        {ROOM_LABEL[room]} · next up
      </span>

      <div
        className="tv-display tv-rise"
        style={{ fontSize: 176, color: "#fff", lineHeight: 0.92 }}
      >
        Session {inbound.heatNumber}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 28, flexWrap: "wrap" }}>
        {inbound.raceType && (
          <span className="tv-display" style={{ fontSize: 78, color: accent }}>
            {inbound.raceType}
          </span>
        )}
        {inbound.trackLabel && (
          <span style={{ fontSize: 52, color: "rgba(245,236,238,0.7)" }}>{inbound.trackLabel}</span>
        )}
      </div>

      {/* WHERE THE RESULTS ARE (owner 2026-08-11). A group leaving the briefing
          asks this immediately, and the answer is a walk, not a screen — so the
          board says it rather than leaving them to find a staff member. */}
      {target && <QualifyTarget accent={accent} target={target} />}

      <p style={{ fontSize: 44, color: "rgba(245,236,238,0.72)", margin: 0, maxWidth: 1500 }}>
        Race results are posted outside Red Track.
      </p>
    </div>
  );
}

/**
 * The holding board: sent here, film not started yet.
 *
 * A group walks in over a minute or two, so this is what they see while they find
 * seats — the session they are in, unmistakably, and an instruction. It exists
 * because rolling the safety film at send time meant the first arrivals watched
 * the opening while the rest were still in the corridor (owner 2026-08-11).
 */
function TakeASeat({
  accent,
  heatNumber,
  raceType,
  trackLabel,
  target,
}: {
  accent: string;
  heatNumber: number | null;
  raceType: string | null;
  trackLabel: string | null;
  /** The lap to beat for the next level, when there is one to aim for. */
  target: { level: string; ms: number } | null;
}) {
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
        }}
      />
      <div
        aria-hidden
        className="tv-breathe"
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(75% 65% at 50% 45%, ${withAlpha(accent, 0.42)}, transparent 74%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: `${PAD_Y}px ${PAD_X}px`,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 26,
        }}
      >
        {/* TRACK, then SESSION, then LEVEL — the three things a group walking in
            needs to confirm they are in the right room for the right race. */}
        <span className="tv-eyebrow" style={{ color: accent, fontSize: 44 }}>
          {trackLabel ?? "Your race"}
        </span>
        {heatNumber != null && (
          <div
            className="tv-display tv-rise"
            style={{ fontSize: 190, color: "#fff", lineHeight: 0.9 }}
          >
            Session {heatNumber}
          </div>
        )}
        {raceType && (
          <div className="tv-display" style={{ fontSize: 84, color: accent }}>
            {raceType}
          </div>
        )}
        <p style={{ fontSize: 50, color: "rgba(245,236,238,0.72)", margin: 0 }}>
          Take a seat — your briefing starts in a moment.
        </p>

        {target && <QualifyTarget accent={accent} target={target} />}
      </div>
    </div>
  );
}

/**
 * The lap to beat for the next level — one component, every board that shows it.
 *
 * It appears on three now (before the film, during helmet sizing, and on the
 * next-race board) because those are the phases a group is SITTING there with time
 * to read it (owner 2026-08-11: "we're also listing the qualification times so that
 * they know what they need to level up"). Extracted rather than repeated: a target
 * worded three slightly different ways would be three chances to disagree with
 * itself. The number comes from the same constants the level-up decision uses, so
 * what a racer is told to beat is the line they are judged against.
 */
function QualifyTarget({
  accent,
  target,
  compact,
}: {
  accent: string;
  target: { level: string; ms: number };
  /** Pill form, for sitting alongside other chrome rather than owning a row. */
  compact?: boolean;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: compact ? 14 : 20,
        alignSelf: "flex-start",
        padding: compact ? "10px 22px" : "18px 34px",
        borderRadius: compact ? 999 : 18,
        border: `3px solid ${withAlpha(accent, 0.75)}`,
        background: withAlpha(accent, 0.16),
      }}
    >
      <span style={{ fontSize: compact ? 26 : 34, color: "rgba(245,236,238,0.78)" }}>Beat</span>
      <span className="tv-display tv-num" style={{ fontSize: compact ? 44 : 92, color: "#fff" }}>
        {(target.ms / 1000).toFixed(3)}
      </span>
      <span style={{ fontSize: compact ? 26 : 34, color: "rgba(245,236,238,0.78)" }}>
        to qualify {target.level}
      </span>
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
