"use client";

/**
 * THE EVENTS BOARD AT REST — the front-desk wall's right-hand panel on a night
 * with nothing booked.
 *
 * TV5 is the events wing: today's parties and the VIP greeting. On a quiet night
 * that board has nothing to say, and the honest thing for it to say instead is
 * where to check in (owner 2026-08-20: "when we have no events or VIPs upcoming,
 * lets put a big Event Check-In on it. For web reservation, please check in on a
 * kiosk").
 *
 * A SIGNPOST, NOT A LIST. That is what sets the layout apart from its neighbour
 * at the other end of the wall: SceneBowlingCheckin is two columns of names,
 * because it answers "is MY lane ready"; this answers "where do I go", which one
 * centred statement does better than any amount of detail. Hence the centred
 * poster stack rather than a corner card.
 *
 * WHY IT IS ITS OWN SCENE rather than an empty state inside SceneEventWelcome.
 * `event-welcome` is ALSO a rotation entry on HPFM:1 (the original kiosk-bank
 * TV), gated by `requiresData`. Making that scene claim data on a quiet night
 * would hand it three of HPFM:1's five slots — displacing the ad rotation that
 * is the whole point of a screen over a bank of kiosks. As a separate,
 * always-populated scene reached only through the wing understudy (see
 * `WING_IDLE` in schedule.ts), it lands on TV5 and nowhere else.
 *
 * A WING IS A COMPOSITION OF ONE. This scene never spans, so it takes no
 * position from `choreo()` — same as the check-in board at the other end.
 *
 * CAPABILITY COPY MATCHES THE CAPABILITY. The three things named below are
 * exactly what kiosk check-in does (`kioskCheckinEnabled` in kiosk/flags.ts:
 * find the reservation, finish the party's waivers, check the whole party in).
 * A board that sends a guest to a machine which then turns them away is the last
 * thing they trust afterwards — the same rule that makes TV1's left column a
 * filter rather than a list of everyone due.
 */
import type { SceneProps } from "../director/types";
import { WALL_ACCENT } from "../wall-content";
import { TV_PHOTOS } from "../assets";
import { WallGround } from "../components/WallPanel";
import { KioskCallout } from "../components/KioskCallout";
import { TvBrandLogo } from "../components/TvBrandLogo";

/**
 * Cyan, matching the welcome board this panel is the resting state of — and
 * matching TV1 at the other end, so both ends of the wall read as "check in
 * here" while the middle three carry each subject's own colour. Gold is not an
 * option: it means All Access and nothing else (see WallPanel).
 */
const ACCENT = WALL_ACCENT.cyan;

/**
 * The arcade floor, NOT `TV_PHOTOS.bowl`. TV1 is showing the bowling photo at
 * the same instant, six inches of bezel away on the same wall, and two wings
 * wearing one picture reads as a duplicated panel rather than a pair.
 */
const PHOTO = TV_PHOTOS.arcade;

/** What the kiosk actually does, in the order the guest will do it. */
const STEPS = ["Find your reservation", "Finish your party's waivers", "Check everyone in at once"];

export function SceneEventCheckin({ venue }: SceneProps) {
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {/* The deep scrim: this panel carries 132px type over a busy photograph. */}
      <WallGround photo={PHOTO} accent={ACCENT} deepScrim />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          gap: 34,
          // Room for the kiosk band, which is 120px of chrome along the bottom.
          padding: "70px 74px 190px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <span className="tv-eyebrow" style={{ fontSize: 26 }}>
            Booked online at
          </span>
          {/* The mark, not the word — the same call the welcome board makes for
              the same reason (owner 2026-08-11: "use actual logos"). */}
          <TvBrandLogo venue={venue} height={54} />
        </div>

        <div
          className="tv-display"
          style={{
            // 132px, not the poster's 165: "Event Check-In" is a long headline
            // and it has to land WHOLE on one panel. A word that runs off a wing
            // has nowhere to go — a word never crosses a gap on this wall.
            fontSize: 132,
            lineHeight: 0.94,
            color: "#fff",
            whiteSpace: "nowrap",
            textShadow: `0 0 10px rgba(255,255,255,0.86), 0 0 64px ${ACCENT}`,
          }}
        >
          Event Check-In
        </div>

        <div
          aria-hidden
          style={{
            width: 420,
            height: 5,
            borderRadius: 3,
            background: `linear-gradient(90deg, transparent, ${ACCENT}, transparent)`,
          }}
        />

        {/* What happens at the machine. Three lines, because a guest deciding
            whether to walk over needs to know it does the whole party — the
            thing that keeps a group of twelve out of the desk queue. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            fontSize: 37,
            lineHeight: 1.2,
            color: "rgba(245,236,238,0.88)",
          }}
        >
          {STEPS.map((step) => (
            <span key={step} style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <span
                aria-hidden
                style={{
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                  borderRadius: "50%",
                  background: ACCENT,
                  boxShadow: `0 0 16px ${ACCENT}`,
                }}
              />
              {step}
            </span>
          ))}
        </div>
      </div>

      {/* WHERE. "THE kiosk below", never "any" — the ad rotation sells the whole
          bank; this names the machine standing under this panel. The words are
          required: arrows alone were tried on this wall and the owner asked for
          the sentence back (2026-08-18). */}
      <KioskCallout accent={ACCENT} text="Check in on the kiosk below" />
    </div>
  );
}
