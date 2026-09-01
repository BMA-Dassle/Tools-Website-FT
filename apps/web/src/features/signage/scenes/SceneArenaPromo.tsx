"use client";

/**
 * The arena's own films, full-bleed — the moving half of what the check-in board
 * plays between calls (owner 2026-09-01: "with video and static ads of laser tag
 * running in its dead time").
 *
 * IT IS THE WHOLE OF THE DEAD TIME NOW, not half of it. The board used to run this
 * and then the house `ads` slides; the owner took the slides off these screens
 * (2026-09-01: "I didn't want the normal ad rotation on those check in screens").
 * What is left is the arena selling the arena — which is the only thing a guest
 * standing at the arena desk can act on.
 *
 * THERE IS ALWAYS A FILM. `useArenaFilms` falls back to the house Nexus cut when a
 * venue has uploaded none, which is what makes dropping the slides safe: a
 * `requiresData` promo with nothing to play would close over and the rotation would
 * fall straight back to the slides that were just removed.
 *
 * WHICH FILM IS SHOWING is derived from the shared clock — the segment's own
 * start, which every screen computes identically — so two arena boards never
 * play different reels, and a board that reboots lands on the right one.
 *
 * NO SOUND, EVER. `muted` is not a default here, it is the requirement: this is
 * a lobby wall a few feet from a desk where staff are talking to guests, and an
 * autoplaying film with audio would be turned off by the second evening. (It is
 * also what makes autoplay legal without a user gesture, which matters on a
 * screen nobody ever touches.)
 */
import { useEffect, useRef, useState } from "react";
import { SLOT_MS } from "../director/schedule";
import { withAlpha } from "../color";
import { TV_PHOTOS } from "../assets";
import { ARENA_ACTIVITY_ACCENTS, ARENA_ACTIVITY_LABELS } from "../arena/arena-board";
import { useArenaFilms } from "../arena/useArenaFilms";
import type { ArenaActivity } from "~/features/arena-tickets/types";
import type { SceneProps } from "../director/types";

/** Stills to fall back to, keyed the way the films are. Already the exact
 *  photographs the house ad slides use for these two products, re-optimised for
 *  the 1920-wide canvas — so a film that will not decode degrades to the same
 *  picture the next slide is about to show, not to a black rectangle. */
const FALLBACK_PHOTO: Record<ArenaActivity, string> = {
  "laser-tag": TV_PHOTOS.laser,
  "gel-blaster": TV_PHOTOS.gel,
};

const ORDER: ArenaActivity[] = ["laser-tag", "gel-blaster"];

export function SceneArenaPromo(props: SceneProps) {
  const { feed, decision } = props;
  const films = useArenaFilms(feed?.arena ?? null, true);

  // BOTH ACTIVITIES ALWAYS, because `useArenaFilms` falls back to the house Nexus reel
  // when a venue has uploaded nothing — so there is no such thing as an activity with
  // no film any more. The strip still names them in turn, and neither label is a lie:
  // the house cut is arena footage of both games.
  const available = ORDER;

  // Off the SEGMENT'S start, not off `nowMs`: the start is constant for the whole
  // segment (rotationAt derives it from the slot boundary), so the reel cannot
  // swap halfway through itself, and every board in the building agrees on which
  // one is up without any messaging.
  const activity =
    available.length > 0
      ? available[Math.floor(decision.startedAtMs / SLOT_MS) % available.length]
      : null;

  // The scene requiresData, so the director should never select it with nothing
  // to play — but a feed can go null between the decision and the render, and a
  // wall must never be blank because of a race.
  if (!activity) return null;

  const src = films.srcFor(activity);
  if (!src) return null;

  return (
    <FilmStage
      // Keyed on the file, not the activity: a re-upload is a new URL, and the
      // <video> element has to be rebuilt rather than asked to change `src`
      // underneath itself.
      key={src}
      src={src}
      activity={activity}
    />
  );
}

/* ── the film ─────────────────────────────────────────────────────────── */

function FilmStage({ src, activity }: { src: string; activity: ArenaActivity }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const accent = ARENA_ACTIVITY_ACCENTS[activity];
  const label = ARENA_ACTIVITY_LABELS[activity];

  /**
   * AUTOPLAY CAN STILL BE REFUSED even when muted — a throttled background tab,
   * a policy quirk, a player that came up before the profile settled. The
   * element's own `autoPlay` attribute gives no way to notice, so the play is
   * also requested explicitly and its rejection swallowed: a refused play must
   * degrade to the still below, never to an unhandled rejection on a wall.
   */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    void el.play().catch(() => setFailed(true));
  }, [src]);

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {failed ? (
        <div
          aria-hidden
          className="tv-kenburns"
          style={{
            // Overdrawn 6% so the ken-burns pan and the burn-in drift can never
            // reveal an edge — same as the ad rotation's backdrop.
            position: "absolute",
            inset: "-6%",
            backgroundImage: `url(${FALLBACK_PHOTO[activity]})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            filter: "saturate(0.78) brightness(0.82)",
          }}
        />
      ) : (
        <video
          ref={videoRef}
          src={src}
          // LOOP, because a segment outlasts a promo. The rotation gives this
          // scene about eighty seconds and a reel is typically half that; without
          // looping the wall would hold a frozen last frame for the remainder.
          loop
          muted
          autoPlay
          playsInline
          preload="auto"
          onError={() => setFailed(true)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            // COVER, not contain: a 16:9 panel showing a 16:9 reel is unaffected,
            // and anything else fills the wall rather than sitting in pillarbox
            // bars. A promo is atmosphere — losing an edge of it costs nothing,
            // where black bars on a lobby TV read as a broken player.
            objectFit: "cover",
          }}
        />
      )}

      {/* Scrim under the strip only. The film is the message here, unlike the ad
          slides where the photograph is atmosphere behind copy — so the frame
          stays clean and only the bottom band is darkened enough to carry type. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 220,
          background: "linear-gradient(to top, rgba(0,4,24,0.92), transparent)",
        }}
      />

      <div
        style={{
          position: "absolute",
          left: 96,
          right: 96,
          bottom: 54,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          gap: 40,
        }}
      >
        <div
          className="tv-display"
          style={{
            fontSize: 104,
            color: "#fff",
            lineHeight: 1,
            textShadow: `0 0 40px ${withAlpha(accent, 0.7)}`,
          }}
        >
          {label}
        </div>
        {/* WHERE TO BUY IT, and it is the desk rather than a kiosk on purpose:
            this screen hangs at the arena, not over a bank of machines, and
            pointing at a kiosk somebody would have to go and find is worse than
            pointing at the person standing in front of them. */}
        <div
          style={{
            fontSize: 42,
            color: "rgba(245,236,238,0.88)",
            paddingBottom: 14,
            whiteSpace: "nowrap",
          }}
        >
          Ask at the desk to play
        </div>
      </div>

      {/* A thin accent rule along the bottom edge ties the reel to the colour
          this activity's call will arrive in. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 8,
          background: accent,
          boxShadow: `0 0 40px ${accent}`,
        }}
      />
    </div>
  );
}
