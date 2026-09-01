"use client";

/**
 * The HP Arena check-in board: which session has just been called, and where to
 * walk. HeadPinz Fort Myers and Naples.
 *
 * THE ONE THING THIS SCREEN MUST GET RIGHT is the same thing the karting board
 * must get right — what the time on it MEANS. The time on an arena e-ticket is a
 * check-in CUT-OFF, not the start of the game, and a bare time on a wall reads
 * as "my session is at 7:45" to anybody who has not been here before. So every
 * time on this board is labelled as a deadline, and the countdown is counted from
 * the CALL rather than shown as a clock time: "6:42 left" moves people and
 * "check in by 7:45" does not.
 *
 * WHAT IT DELIBERATELY IS NOT (owner 2026-09-01: "we will not use a check in
 * board here — we simply call and check them in"). There is no scan rail, no
 * "8 of 12 checked in", no wrong-session notice and no handover to a briefing
 * room. All four of those exist on the track board because racers scan a licence
 * at a desk that records it. Nobody scans here: a marshal calls the session and
 * ticks people off by hand. A rail with no scans to put on it would be a
 * permanently empty strip, and a counter fed by nothing would read 0 of 12 all
 * night — which is exactly the bug the track board already had once.
 *
 * So this board reports the CALL, as large as the wall allows, and nothing else.
 *
 * BOTH ACTIVITIES AT ONCE IS NORMAL. Laser Tag and Gel Blaster run off the one
 * "HP Arena" resource and check in at the same desk; a busy Saturday calls both
 * inside a minute. Calls lay out as one panel each, in their own colour, so a
 * guest finds their own without reading a word — up to three, the third being a
 * birthday party booked as "either game" (see ArenaBoardActivity).
 */
import { useState } from "react";
import { fmtTime12, toEtWallClock } from "~/features/kiosk/checkin/itinerary";
import { withAlpha } from "../color";
import {
  ARENA_ACTIVITY_ACCENTS,
  ARENA_ACTIVITY_DESTINATIONS,
  ARENA_ACTIVITY_LABELS,
  ARENA_HOLD_DEFAULT_MS,
  activeArenaCalls,
  arenaCheckinRemainingMs,
  formatArenaCountdown,
  type ArenaCall,
} from "../arena/arena-board";
import type { SceneProps } from "../director/types";

/** TV-safe margins — 5% side, 5% top/bottom of a 1920×1080 frame. Same as every
 *  other board, so a guest's eye lands in the same place on all of them. */
const PAD_X = 96;
const PAD_Y = 54;

/**
 * How long a newly-called session gets the attention treatment.
 *
 * The same 45 seconds the track board uses, and for the same reason: this is the
 * only warning a group gets that their session is up, and somebody half-watching
 * from the bowling lanes has to catch it. It retires itself so the board is not
 * shouting all evening.
 */
const JUST_CALLED_MS = 45_000;

/** How much wall one panel has. Not a scale factor — see CallPanel. */
type PanelSize = "solo" | "duo" | "trio";

/** The frame's colour when no single activity may own it. Matches the `either`
 *  accent, so a lone birthday call and a mixed board read as one family. */
const NEUTRAL_ACCENT = "#8ab4ff";

export function SceneArenaCheckin({ feed, nowMs, config }: SceneProps) {
  const holdMs = config.arenaBoard?.holdMs ?? ARENA_HOLD_DEFAULT_MS;
  const active = activeArenaCalls(feed?.arena?.calls ?? [], nowMs, holdMs);

  /**
   * WHAT THE OUTGOING FRAME RENDERS.
   *
   * The director keeps a scene mounted for 500ms after its decision ends so it
   * can animate away under the wipe — and this scene's decision ends precisely
   * when `active` empties. Without this, the last half-second of every takeover
   * would render an empty board, which reads as a glitch rather than a hand-off.
   *
   * Adjusted DURING RENDER, React's documented "adjust state when a prop changes"
   * pattern and the same one SceneDirector uses to keep its own outgoing frame
   * alive. Keyed on the session ids rather than the array, because the feed hands
   * back a fresh array on every poll and comparing identity would set state on
   * every render.
   */
  const key = active.map((c) => c.sessionId).join("|");
  const [held, setHeld] = useState<{ key: string; calls: ArenaCall[] }>({ key, calls: active });
  if (active.length > 0 && held.key !== key) setHeld({ key, calls: active });
  const calls = active.length > 0 ? active : held.calls;
  if (calls.length === 0) return null;

  // The freshest call decides whether the WHOLE board is in its just-called
  // state. When two sessions are called a minute apart the second one arriving
  // should light the wall again — a group that has just been called does not
  // care that the other panel has been up for a while.
  const newestCalledAtMs = Math.max(...calls.map((c) => c.calledAtMs));
  const calledAgoMs = nowMs - newestCalledAtMs;
  const justCalled = calledAgoMs >= 0 && calledAgoMs < JUST_CALLED_MS;

  // One panel gets the full wall; two or three share it. Three is the ceiling —
  // `activeArenaCalls` keeps at most one call per kind, and there are three kinds
  // (Laser Tag, Gel Blaster, and a party booked as either).
  const size: PanelSize = calls.length === 1 ? "solo" : calls.length === 2 ? "duo" : "trio";
  // With one call the board wears that activity's colour outright. With more,
  // none of them may own the frame, so the ambient wash stays neutral and each
  // panel carries its own colour instead.
  const frameAccent = size === "solo" ? ARENA_ACTIVITY_ACCENTS[calls[0].activity] : NEUTRAL_ACCENT;

  const windowMins = config.showCheckinCountdown ? config.checkinWindowMins : null;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#000418" }}>
      {/* JUST CALLED. A full-frame flood breathing over everything plus a thick
          border — deliberately hard to ignore from the far side of a lobby, and
          it retires itself so the board is not shouting all night. */}
      {justCalled && (
        <>
          <div
            aria-hidden
            className="tv-breathe"
            style={{
              position: "absolute",
              inset: 0,
              background: `radial-gradient(80% 70% at 50% 50%, ${withAlpha(frameAccent, 0.5)}, transparent 75%)`,
              zIndex: 2,
              pointerEvents: "none",
            }}
          />
          <div
            aria-hidden
            className="tv-breathe"
            style={{
              position: "absolute",
              inset: 0,
              border: `14px solid ${frameAccent}`,
              boxShadow: `inset 0 0 120px ${withAlpha(frameAccent, 0.7)}`,
              zIndex: 3,
              pointerEvents: "none",
            }}
          />
        </>
      )}

      {/* IDENTITY BAR. With two calls it is split down the middle in the two
          activities' colours, in the same left-to-right order as the panels — so
          the top edge of the wall already answers "which side am I". */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 16,
          display: "flex",
          boxShadow: `0 0 60px ${withAlpha(frameAccent, 0.8)}`,
          zIndex: 1,
        }}
      >
        {calls.map((call) => (
          <div
            key={call.sessionId}
            style={{ flex: 1, background: ARENA_ACTIVITY_ACCENTS[call.activity] }}
          />
        ))}
      </div>

      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(75% 65% at 50% 40%, ${withAlpha(frameAccent, 0.3)}, transparent 74%)`,
        }}
      />
      <div aria-hidden className="tv-sweep" style={{ position: "absolute", inset: 0 }} />

      <div
        style={{
          position: "absolute",
          inset: `${PAD_Y}px ${PAD_X}px`,
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <span
            aria-hidden
            className={justCalled ? "tv-blink" : undefined}
            style={{
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: frameAccent,
              boxShadow: `0 0 24px ${frameAccent}`,
            }}
          />
          <span
            className={justCalled ? "tv-eyebrow tv-blink" : "tv-eyebrow"}
            style={{ color: justCalled ? "#fff" : frameAccent, fontSize: justCalled ? 46 : 36 }}
          >
            {justCalled ? "Your session is called" : "Now checking in"}
          </span>
        </header>

        <div
          style={{
            flex: 1,
            display: "flex",
            gap: 40,
            alignItems: "stretch",
            minHeight: 0,
          }}
        >
          {calls.map((call, i) => (
            <CallPanel
              key={call.sessionId}
              call={call}
              size={size}
              nowMs={nowMs}
              windowMins={windowMins}
              // Each panel arrives a beat after the last, so two calls landing
              // together read as a sequence rather than a jump.
              delayMs={i * 120}
            />
          ))}
        </div>

        {/* THE ONE THING STAFF SAY TO EVERY GROUP, on the wall they are already
            reading. Closed-toe shoes and no phones in the arena are the two
            questions the desk answers on repeat; putting them here does not
            replace the marshal's briefing, it just means the group has already
            heard it once. */}
        <footer
          style={{
            display: "flex",
            alignItems: "center",
            gap: 28,
            paddingTop: 18,
            borderTop: `2px solid ${withAlpha("#f5ecee", 0.16)}`,
          }}
        >
          <span style={{ fontSize: 36, color: "rgba(245,236,238,0.72)" }}>
            Have your e-ticket ready
          </span>
          <span aria-hidden style={{ fontSize: 36, color: "rgba(245,236,238,0.3)" }}>
            ·
          </span>
          <span style={{ fontSize: 36, color: "rgba(245,236,238,0.72)" }}>
            Closed-toe shoes required
          </span>
        </footer>
      </div>
    </div>
  );
}

/* ── one called session ───────────────────────────────────────────────── */

/**
 * Type sizes per panel width.
 *
 * NOT A SCALE FACTOR APPLIED TO A BASE. A panel with a third of the wall needs a
 * different set of proportions, not the same ones shrunk — scale the solo sizes
 * down and "Session 25" stops being the headline and becomes a subheading, which
 * is the one thing on this board that has to be readable from across a lobby. So
 * each width gets its own hand-set pair, with the session number kept as large as
 * the column allows and the supporting lines giving way instead.
 */
const PANEL_TYPE: Record<
  PanelSize,
  { label: number; session: number; go: number; when: number; cue: number; count: number }
> = {
  solo: { label: 96, session: 210, go: 62, when: 40, cue: 50, count: 92 },
  duo: { label: 68, session: 132, go: 44, when: 32, cue: 36, count: 64 },
  trio: { label: 48, session: 96, go: 34, when: 26, cue: 28, count: 46 },
};

/** A single called session, sized for however much wall it has. */
function CallPanel({
  call,
  size,
  nowMs,
  windowMins,
  delayMs,
}: {
  call: ArenaCall;
  size: PanelSize;
  nowMs: number;
  /** Null = the countdown is switched off in admin. */
  windowMins: number | null;
  delayMs: number;
}) {
  const accent = ARENA_ACTIVITY_ACCENTS[call.activity];
  const label = ARENA_ACTIVITY_LABELS[call.activity];
  const destination = ARENA_ACTIVITY_DESTINATIONS[call.activity];
  const type = PANEL_TYPE[size];
  const solo = size === "solo";
  // Z-stamped UTC from Pandora. toEtWallClock converts it to ET wall-clock and
  // fmtTime12 renders those components verbatim — the pairing feed.ts already
  // uses, and the one that does NOT re-shift an already-correct time (the 4am
  // "next available" bug, lesson 51a47370).
  const startLabel = fmtTime12(toEtWallClock(call.scheduledStart));

  return (
    <section
      className="tv-rise"
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: solo ? 18 : 12,
        padding: solo ? "0" : "0 32px",
        borderRadius: 28,
        border: solo ? "none" : `3px solid ${withAlpha(accent, 0.55)}`,
        background: solo ? "none" : withAlpha(accent, 0.12),
        boxShadow: solo ? "none" : `0 0 70px ${withAlpha(accent, 0.28)}`,
        animationDelay: `${delayMs}ms`,
      }}
    >
      <div
        className="tv-display"
        style={{
          fontSize: type.label,
          color: accent,
          lineHeight: 1.02,
          textShadow: `0 0 40px ${withAlpha(accent, 0.65)}`,
        }}
      >
        {label}
      </div>

      <div
        className="tv-display"
        style={{
          fontSize: type.session,
          color: "#fff",
          lineHeight: 0.9,
          textShadow: `0 0 70px ${withAlpha(accent, 0.55)}`,
        }}
      >
        {/* A session with no heat number is a real possibility on a vendor feed,
            and "Session —" would be worse than the activity name standing alone.
            The instruction below is correct either way. */}
        {call.heatNumber != null ? `Session ${call.heatNumber}` : "Now"}
      </div>

      {/* WHERE TO GO. The board's actual purpose — everything above it is who
          this is for. */}
      <div className="tv-display" style={{ fontSize: type.go, color: "#fff", lineHeight: 1.05 }}>
        Come to {destination}
      </div>

      {startLabel && (
        <div style={{ fontSize: type.when, color: "rgba(245,236,238,0.6)" }}>
          {/* NAMED AS A DEADLINE, never as a bare time — see the note at the top
              of this file. */}
          Be checked in by {startLabel}
        </div>
      )}

      {windowMins != null && (
        <Countdown call={call} nowMs={nowMs} windowMins={windowMins} accent={accent} type={type} />
      )}
    </section>
  );
}

/**
 * How long they have, counted from the call.
 *
 * Never shows a negative number or a hard zero: staff will still check somebody
 * in at 8:01, and a wall announcing they have missed it would be both unkind and
 * untrue. It becomes an instruction instead.
 */
function Countdown({
  call,
  nowMs,
  windowMins,
  accent,
  type,
}: {
  call: ArenaCall;
  nowMs: number;
  windowMins: number;
  accent: string;
  type: (typeof PANEL_TYPE)[PanelSize];
}) {
  const remaining = arenaCheckinRemainingMs(call, nowMs, windowMins);
  const expired = remaining <= 0;
  // Amber inside the last minute: urgent without being a failure state.
  const urgent = remaining < 60_000;
  const color = expired || urgent ? "#f0b341" : "#fff";

  return (
    <div style={{ marginTop: 10, display: "flex", alignItems: "baseline", gap: 20 }}>
      <span className="tv-display" style={{ fontSize: type.cue, color: accent }}>
        {expired ? "Check in now" : "Check in within"}
      </span>
      {expired ? (
        <span style={{ fontSize: type.when, color: "rgba(245,236,238,0.75)" }}>see the desk</span>
      ) : (
        <span
          className={`tv-display tv-num${urgent ? " tv-blink" : ""}`}
          style={{
            fontSize: type.count,
            color,
            textShadow: `0 0 44px ${withAlpha(accent, 0.5)}`,
          }}
        >
          {formatArenaCountdown(remaining)}
        </span>
      )}
    </div>
  );
}
