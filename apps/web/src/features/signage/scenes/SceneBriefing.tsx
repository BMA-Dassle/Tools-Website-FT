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
import { useCallback, useEffect, useRef, useState } from "react";
import { IconAlertTriangleFilled } from "@tabler/icons-react";
import { withAlpha } from "../color";
import { formatLap, nextLevelTarget } from "~/features/racing/qualify";
import { TRACK_ACCENTS, TRACK_LABELS } from "../track";
import { briefingTimelineAt } from "../briefing/phase";
import { tierForRaceType, type BriefingRoom } from "../briefing/types";
import { LiveSessionChip } from "../live-session";
import { useTrackStatus } from "@/hooks/useTrackStatus";
import { useBriefingAssets } from "../briefing/useBriefingAssets";
import { demoBriefingRooms } from "../demo";
import { CameraReturnBar, cameraBarHeight } from "../components/CameraReturnBar";
import type { SceneProps } from "../director/types";

const PAD_X = 96;
const PAD_Y = 54;

/**
 * How long a film may make NO progress at all before the room gives up on it.
 *
 * Deliberately generous. The failure being caught is a codec the player cannot
 * decode, which never recovers — so waiting costs nothing in the real failure case,
 * while being impatient costs a working briefing (see the note in BriefingVideo).
 * Measured from the last sign of life, not from the start of playback.
 */
const STALL_GIVE_UP_MS = 40_000;

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

  // Which track this room's live clock follows: its own on a normal day, the
  // combined circuit on a Mega day — the same effective-track rule every other
  // board uses. Polled at the website's cadence; the clock itself is a direct
  // websocket to the timing system (see live-session.tsx).
  const trackStatus = useTrackStatus();
  const megaEnabled = trackStatus?.trackStatus.megaTrackEnabled ?? false;
  const liveTrack = room ? (megaEnabled ? ("mega" as const) : room) : null;

  // Room state is read BEFORE the assets hook, because whether a film is playing
  // right now decides whether we may use the link to download one.
  const previewRooms = demo === "briefing" || demo === "briefing-return";
  const roomsNow = previewRooms ? demoBriefingRooms(nowMs, feed, demo) : feed?.briefingRooms;
  const stateNow = room ? (roomsNow?.[room] ?? null) : null;
  // Downloads hold during "waiting" too: the group is walking over, Start is
  // seconds-to-minutes away, and preload="auto" is using the link to get the
  // element ahead. A prefetch there would be competing with the very play it is
  // trying to make instant.
  const phaseNow = briefingTimelineAt(stateNow, nowMs).phase;
  const playingNow = phaseNow === "video" || phaseNow === "waiting";

  // Downloading a film while that same film is streaming starves the player — see
  // the note on `paused` in useBriefingAssets.
  const assets = useBriefingAssets(feed?.briefing ?? null, !!room, playingNow);

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
  // Stable for the component's life — takes the offending src as an argument
  // instead of closing over it, so BriefingVideo's effect can depend on it
  // honestly rather than hiding it behind a ref or a lint suppression.
  const markUnplayable = useCallback((badSrc: string) => setFailedSrc(badSrc), []);

  // A screen configured as a briefing TV with no room chosen cannot know which
  // of the two states is addressed to it. Say so, quietly, rather than adopting
  // a room at random — this is a setup mistake and a staff member needs to see
  // it, but guests may be in the room, so it stays calm.
  if (!room) return <Unconfigured />;

  const accent = ROOM_ACCENT[room];
  const state = stateNow;
  const timeline = briefingTimelineAt(state, nowMs);

  const tier = state?.tier ?? tierForRaceType(null);
  const videoSrc = assets.srcFor(tier);
  const videoUnplayable = !!videoSrc && failedSrc === videoSrc;

  /**
   * The strip is on the rail unless the kill switch is off. Preview modes get it
   * too, from demo data, so it can be reviewed off a laptop.
   *
   * The band it occupies is 104 px with cameras out and a 44 px whisper when
   * everything is accounted for (cameraBarHeight owns that decision, so the
   * reserve below and the bar itself cannot disagree). Every phase lays out above
   * it, the safety film included: the group about to be handed kit is the one
   * sitting in front of the film.
   */
  const cameraReturn = feed?.briefing?.cameraReturn ?? null;
  const barH = cameraBarHeight(cameraReturn);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {/* EVERY PHASE LIVES INSIDE THIS BOX, which is the whole canvas minus the
          camera strip. One wrapper rather than a bottom-inset threaded through
          four boards: each branch keeps its own `inset: PAD_Y PAD_X` and is
          shifted up for free, the accent bars and radial washes stay bounded to
          the picture area instead of bleeding under the strip, and the film's
          `objectFit: cover` simply crops to the smaller box. */}
      <div style={{ position: "absolute", inset: 0, bottom: barH, overflow: "hidden" }}>
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
            onUnplayable={markUnplayable}
          />
        ) : timeline.phase === "idle" && feed?.briefing?.welcomeBack ? (
          // THE GROUP IS BACK (owner 2026-08-11): their session's actualEnd is
          // stamped and the room is idle, so the wall greets them — kit return,
          // who levelled up and who didn't (from the end-of-race capture), the
          // qualifying time, where scores are posted. Strictly idle-only: a
          // playing video, a take-a-seat hold and the helmet phase all outrank
          // it, and it stays up until the next briefing occupies the room.
          <WelcomeBack accent={accent} room={room} info={feed.briefing.welcomeBack} />
        ) : (
          <Board
            accent={accent}
            room={room}
            phase={timeline.phase === "video" ? "helmet" : timeline.phase}
            posterSrc={assets.posterSrc}
            heatNumber={state?.heatNumber ?? null}
            // The lap THIS room's group has to beat. They sit through the helmet and
            // next-race boards, which is when there is actually time to read it.
            target={state?.track ? nextLevelTarget(state.track, state.raceType) : null}
          />
        )}
      </div>

      {/* WHICH POV CAMERAS ARE STILL OUT — every phase, the film included, for
          the same reason the clock is: the group about to be handed kit is the
          one sitting in front of the film (owner 2026-08-12). Venue-wide, so
          both rooms show the identical strip. */}
      {cameraReturn && (
        <CameraReturnBar
          boxes={cameraReturn.boxes}
          outCount={cameraReturn.outCount}
          stale={cameraReturn.stale}
          padX={PAD_X}
        />
      )}

      {/* THE LIVE SESSION CLOCK — at all times, every phase, the film included.
          TOP-RIGHT (owner 2026-08-11: "move on track timer to top right") — the
          bottom edge is where subtitle tracks burn into the film, and the
          helmet board's own chips now cluster left so this corner is the
          clock's on every board. Renders nothing when no heat is live. */}
      <div style={{ position: "absolute", right: PAD_X, top: 40, zIndex: 6 }}>
        <LiveSessionChip track={liveTrack} accent={accent} />
      </div>
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
  /** This player cannot decode the file — hand the wall back to the scene. Takes
   *  the src so the parent needs no per-render closure. */
  onUnplayable: (src: string) => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  /**
   * THE SEEK OFFSET AND THE CALLBACK ARE HELD IN REFS, and that is the whole fix
   * for the bug that made a briefing never play at all.
   *
   * `seekToMs` is derived from the shared clock, so it changes on every director
   * tick — about four times a second. `onUnplayable` was a fresh closure each
   * render. Both were in this effect's dependency array, so the effect re-ran ~4×/s,
   * and past the two-second mark each run RE-SEEKED the element. The media pipeline
   * was reset four times a second: new range requests, aborted reads, and a picture
   * that could never start. Three HARs off the Blue player show exactly that
   * (owner 2026-08-11).
   *
   * The effect now depends only on `src` and a STABLE callback — one mount, one
   * seek, one play. The offset is captured on first render, which is the only moment
   * it means anything: "where should this film start", asked once. A remount for a
   * genuinely new briefing is handled by the `key` on the element in the scene above.
   */
  const seekOnceToMs = useRef(seekToMs);
  /**
   * The src is CAPTURED AT MOUNT and never follows the prop. The cache can finish
   * adopting mid-film (adoption deliberately runs during playback), which flips
   * srcFor's answer from the network URL to a blob: URL — and rewriting the src
   * attribute of a playing element resets it to frame zero. The cached copy is for
   * the NEXT play; this one finishes on the pipe it started on. A genuinely new
   * briefing remounts via the element's key, which re-captures.
   */
  const [mountSrc] = useState(src);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fail = () => onUnplayable(mountSrc);
    // Only seek a genuine rejoin. Seeking to ~0 on a normal start can cost a
    // keyframe decode for nothing.
    const startAtMs = seekOnceToMs.current;
    if (startAtMs > 2_000) {
      try {
        el.currentTime = startAtMs / 1000;
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
          fail();
        }
      }
    };
    void play();

    /**
     * IS IT STUCK, OR IS IT JUST SLOW? — and the difference matters enormously.
     *
     * A container Edge can parse but not decode paints black forever and raises NO
     * error, so something has to notice. But the first version of this check gave up
     * after six seconds flat, which condemned a perfectly good film that was merely
     * loading: these are 220 MB files, the .mov's index sits at the END so the
     * demuxer fetches the tail before it can start, and venue internet is what it is.
     * That turned a slow start into a permanent fallback to the helmet board.
     *
     * So this watches for PROGRESS rather than checking a stopwatch once. Any of a
     * decoded frame, a growing buffer, or advancing playback counts as alive, and the
     * clock only runs while nothing at all is happening. A film that is downloading
     * is never declared broken.
     */
    let lastProgressAt = Date.now();
    let lastBuffered = 0;
    const poll = setInterval(() => {
      const v = ref.current;
      if (!v) return;

      const buffered = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
      const decoded = v.readyState >= 2 && v.videoWidth > 0; // HAVE_CURRENT_DATA + a picture
      if (decoded || buffered > lastBuffered || v.currentTime > 0.1) {
        lastBuffered = buffered;
        lastProgressAt = Date.now();
      }

      // Playing happily — nothing more to watch for.
      if (decoded && v.currentTime > 0.1) {
        clearInterval(poll);
        return;
      }

      if (Date.now() - lastProgressAt > STALL_GIVE_UP_MS) {
        clearInterval(poll);
        fail();
      }
    }, 2_000);
    return () => clearInterval(poll);
    // NO clock-derived value in this list — that is what caused the reseek loop —
    // and mountSrc never changes, so this runs exactly once per element.
  }, [mountSrc, onUnplayable]);

  return (
    /* CAPTIONS: no caption file exists for the briefing films yet. Worth having —
       this is the one video on the estate a guest is required to absorb — but a
       <track> pointing at nothing is worse than none, because it advertises
       captions that never appear. Add the VTT and the track in the same change.
       Staff brief deaf guests in person in the meantime. */
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      ref={ref}
      src={mountSrc}
      autoPlay
      playsInline
      // Buffer ahead rather than stopping at metadata: by the time staff press
      // Start, the group has usually been walking for a minute and the element has
      // had that whole time to get ahead.
      preload="auto"
      // NOT muted, NOT looping. It is a briefing: it is heard once, and it ends.
      controls={false}
      onError={() => onUnplayable(mountSrc)}
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
  heatNumber,
  target,
}: {
  accent: string;
  room: BriefingRoom;
  phase: "helmet" | "idle";
  posterSrc: string | null;
  heatNumber: number | null;
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

      {/* A BRIEFING SCREEN SAYS NOTHING ABOUT A RACE UNTIL THAT RACE IS SENT HERE.
          An earlier pass put the next called heat on the idle board, which on a Mega
          day announced "NEXT UP Session 32" in BOTH rooms for a session that could
          only go to one of them (owner 2026-08-11: "this shouldn't show on briefing
          screen till the race is assigned to that room"). A session that HAS been
          assigned already has its own board — the take-a-seat one — so there was
          never a moment this belonged. Idle is helmet sizes. */}
      <HelmetBoard
        accent={accent}
        room={room}
        posterSrc={posterSrc}
        heatNumber={phase === "helmet" ? heatNumber : null}
        target={target}
      />
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
        {/* Overlay chips ride the BOTTOM edge, below the poster's own title band
            (owner 2026-08-12: "move the grab your helmet and qualification to
            under the helmet size text").

            This reverses the 2026-08-11 placement, and the reason it does is the
            artwork. Back then the chips sat on top of the poster's title and read
            as part of it gone wrong ("grab your helmet looks out of place"), so
            they were moved to the top edge. The current poster ends its title band
            well above the frame and leaves clear ground under it — so the chips now
            sit in that band, reading as a caption to the chart rather than as
            something stuck over it. A poster whose art runs to the bottom edge would
            put this back in play; judge it against the poster on the wall, not
            against this comment.

            THE 40 px IS ABOVE THE CAMERA STRIP, not above the panel edge: every
            phase renders inside the scene's `bottom: barH` box (see the wrapper in
            SceneBriefing), so this cluster and the strip can never overlap however
            the strip resizes. The poster is `contain` inside that same box, so its
            bottom edge and this cluster's ground are the one line.

            Solid dark chip backgrounds rather than backdrop blur: these players are
            mini PCs and a blur over a full-screen image is compositor work they can
            feel. */}
        {/* Chips cluster LEFT — the right-hand corner above them belongs to the
              live session clock on every board. */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            left: PAD_X,
            right: PAD_X,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            gap: 20,
            flexWrap: "wrap",
            zIndex: 3,
          }}
        >
          {heatNumber != null ? (
            <div
              className="tv-display"
              style={{
                fontSize: 40,
                color: "#fff",
                padding: "10px 30px",
                borderRadius: 999,
                background: "rgba(0, 4, 24, 0.82)",
                border: `2px solid ${withAlpha(accent, 0.8)}`,
              }}
            >
              Session {heatNumber} · grab your helmet
            </div>
          ) : (
            <span />
          )}
          {target && <QualifyTarget accent={accent} target={target} compact solid />}
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
      {/* Where results are (owner 2026-08-11). A group leaving the briefing asks it
          immediately, and the answer is a walk rather than a screen. */}
      <p style={{ fontSize: 40, color: "rgba(245,236,238,0.6)", margin: 0 }}>
        Race scores are posted outside the briefing room, near check-in and Red Track.
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
        {/* The instruction that matters in the hold: groups were suiting up
            before anyone briefed them (owner 2026-08-11). */}
        <p style={{ fontSize: 50, color: "rgba(245,236,238,0.72)", margin: 0 }}>
          Please do not get geared up. We&rsquo;ll help you after the briefing video.
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
  solid,
}: {
  accent: string;
  target: { level: string; ms: number };
  /** Pill form, for sitting alongside other chrome rather than owning a row. */
  compact?: boolean;
  /** Opaque dark ground — for riding on top of poster artwork, where the
   *  translucent accent fill vanishes into whatever is behind it. */
  solid?: boolean;
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
        border: `${solid ? 2 : 3}px solid ${withAlpha(accent, solid ? 0.8 : 0.75)}`,
        background: solid ? "rgba(0, 4, 24, 0.82)" : withAlpha(accent, 0.16),
      }}
    >
      <span style={{ fontSize: compact ? 26 : 34, color: "rgba(245,236,238,0.78)" }}>Beat</span>
      <span className="tv-display tv-num" style={{ fontSize: compact ? 44 : 92, color: "#fff" }}>
        {formatLap(target.ms)}
      </span>
      <span style={{ fontSize: compact ? 26 : 34, color: "rgba(245,236,238,0.78)" }}>
        to qualify {target.level}
      </span>
    </div>
  );
}

/**
 * WELCOME BACK — the group has raced and is walking in to return kit.
 *
 * Everything on it is something they need in the next two minutes: where the
 * helmets and cameras go, and — when the end-of-race capture landed — WHO
 * LEVELLED UP AND WHO DIDN'T, with the time to beat (owner 2026-08-11,
 * superseding the earlier "park who qualified"). Names verbatim from the
 * timing system. No capture → the name-less board, exactly as before. No
 * timers either way: it holds until the next briefing occupies the room.
 */
function WelcomeBack({
  accent,
  room,
  info,
}: {
  accent: string;
  room: BriefingRoom;
  info: {
    heatNumber: number | null;
    raceType: string | null;
    track: "blue" | "red" | "mega";
    results: {
      levelledUp: Array<{ name: string; bestMs: number }>;
      keepPushing: Array<{ name: string; bestMs: number | null }>;
    } | null;
  };
}) {
  const target = nextLevelTarget(info.track, info.raceType);
  const results = info.results;
  // The name board only exists where qualification exists: no target (a Pro
  // grid — nothing above it) means no split to show, so the plain welcome
  // board renders instead. NO LAP TIMES on this screen either way (owner
  // 2026-08-11: "I don't want race times on here — who qualified and who
  // didn't"); times live on the score screens outside.
  const hasNames =
    target !== null &&
    results !== null &&
    results.levelledUp.length + results.keepPushing.length > 0;
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
          background: `radial-gradient(75% 65% at 50% 40%, ${withAlpha(accent, 0.4)}, transparent 74%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: `${PAD_Y}px ${PAD_X}px`,
          display: "flex",
          flexDirection: "column",
          // With names the board owns the whole panel: header at the top, the
          // name area absorbing the slack, chip and scores anchored at the
          // bottom (owner 2026-08-11: "utilize full screen").
          justifyContent: hasNames ? "flex-start" : "center",
          gap: hasNames ? 30 : 26,
        }}
      >
        <span className="tv-eyebrow" style={{ color: accent, fontSize: 40 }}>
          {ROOM_LABEL[room]}
          {info.heatNumber != null ? ` · Session ${info.heatNumber}` : ""}
        </span>
        <div
          className="tv-display tv-rise"
          style={{ fontSize: hasNames ? 130 : 170, color: "#fff", lineHeight: 0.92 }}
        >
          Welcome back!
        </div>

        {/* Kit return — the two things staff otherwise repeat to every group.
            One line when the name board needs the vertical room. */}
        {hasNames ? (
          <p style={{ fontSize: 46, color: "rgba(245,236,238,0.85)", margin: 0 }}>
            Return helmets to the shelves — cameras go back to the attendant.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            <p style={{ fontSize: 54, color: "rgba(245,236,238,0.85)", margin: 0 }}>
              Return helmets to the shelves.
            </p>
            <p style={{ fontSize: 54, color: "rgba(245,236,238,0.85)", margin: 0 }}>
              Cameras go back to the attendant.
            </p>
          </div>
        )}

        {hasNames && (
          <div style={{ flex: 1, minHeight: 0 }}>
            <ResultsBoard accent={accent} target={target!} results={results!} />
          </div>
        )}

        {target && <QualifyTarget accent={accent} target={target} />}

        {/* Blinking on purpose (owner 2026-08-11: "blink the race-results line
            so they pay attention") — the one animated element on the board. */}
        <p
          className="tv-blink"
          style={{
            fontSize: hasNames ? 46 : 42,
            fontWeight: 600,
            color: "rgba(245,236,238,0.92)",
            margin: 0,
          }}
        >
          Race scores are posted outside the briefing room, near check-in and Red Track.
        </p>
      </div>
    </div>
  );
}

/**
 * The name board: WHO QUALIFIED and WHO DIDN'T — names only, no lap times
 * (owner 2026-08-11: "I don't want race times on here"). The split is decided
 * server-side against the same qualify.ts cutoffs the level-up texts use; the
 * bestMs the payload carries is deliberately not rendered here.
 */
function ResultsBoard({
  accent,
  target,
  results,
}: {
  accent: string;
  target: { level: string; ms: number };
  results: {
    levelledUp: Array<{ name: string; bestMs: number }>;
    keepPushing: Array<{ name: string; bestMs: number | null }>;
  };
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 44, height: "100%" }}>
      {results.levelledUp.length > 0 ? (
        <NameColumn
          heading={`Qualified for ${target.level}`}
          headingColor="#46d68c"
          pillBorder="rgba(70, 214, 140, 0.65)"
          names={results.levelledUp.map((d) => d.name)}
        />
      ) : (
        <div
          style={{
            alignSelf: "start",
            padding: "22px 28px",
            borderRadius: 18,
            border: `2px solid ${withAlpha(accent, 0.5)}`,
            background: "rgba(0, 4, 24, 0.6)",
            fontSize: 38,
            color: "rgba(245,236,238,0.75)",
          }}
        >
          Nobody beat {formatLap(target.ms)} this race — the time to beat stands.
        </div>
      )}
      {results.keepPushing.length > 0 && (
        <NameColumn
          heading="Didn't qualify — next time!"
          headingColor="rgba(245,236,238,0.65)"
          pillBorder="rgba(245,236,238,0.25)"
          names={results.keepPushing.map((d) => d.name)}
        />
      )}
    </div>
  );
}

/** A heading and a wrap of name pills — scales from 2 racers to a full grid of
 *  10 without the column outgrowing the screen the way timed rows did. */
function NameColumn({
  heading,
  headingColor,
  pillBorder,
  names,
}: {
  heading: string;
  headingColor: string;
  pillBorder: string;
  names: string[];
}) {
  return (
    <div style={{ display: "grid", gap: 18, alignContent: "start", height: "100%" }}>
      <span className="tv-eyebrow" style={{ fontSize: 32, color: headingColor }}>
        {heading}
      </span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignContent: "start" }}>
        {names.map((name) => (
          <span
            key={name}
            style={{
              padding: "12px 30px",
              borderRadius: 999,
              border: `2px solid ${pillBorder}`,
              background: "rgba(0, 4, 24, 0.6)",
              fontSize: 44,
              color: "#fff",
              whiteSpace: "nowrap",
              maxWidth: 780,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {name}
          </span>
        ))}
      </div>
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
