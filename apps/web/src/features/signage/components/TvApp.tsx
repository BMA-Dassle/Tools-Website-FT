"use client";

/**
 * The whole TV: work out which screen this is, fetch its config, and run it.
 *
 * BOOT RESOLUTION — identity from the URL, config from the cloud:
 *   1. `?screen=HPFM:1` in the URL is the identity. Staff type it once into the
 *      mini PC's Chrome shortcut and never again.
 *   2. The feed answers with that screen's config from Neon — cloud is
 *      authoritative, so an admin edit reaches the wall on the next poll.
 *   3. Last good config from localStorage covers a boot during an outage.
 *   4. No identity at all, or an unregistered one, falls back to house ads.
 *      A wall in a lobby must never show a setup prompt.
 *
 * The URL is rewritten to its canonical form so a hard reload (the self-update
 * path) comes back as the same screen.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useKioskClock } from "../clock";
import {
  parseScreenKey,
  canonicalTvPath,
  VENUE_INFO,
  type SignageVenue,
  TEST_SCREEN_NUMBER,
} from "../constants";
import { resolveScreenConfig } from "../defaults";
import { useTvFeed } from "../useTvFeed";
import { FeedHealthProvider } from "../feed-health";
import { usePanelFill } from "../usePanelFill";
import { useGatedReload } from "../useGatedReload";
import { applyDemo, effectiveDemoMode, parseDemoMode, type DemoMode } from "../demo";
import { WallIdentify } from "./WallIdentify";
import { briefingTimelineAt } from "../briefing/phase";
import type { SceneDecision } from "../director/schedule";
import { SceneDirector } from "../director/SceneDirector";
import { TvStage } from "./TvStage";
import { TvShell } from "./TvShell";
// Cross-feature on purpose: the kiosk's loader IS the house loading state
// (design decision 2026-07-17, "anything that loads shows the logo loader"), and
// a wall booting should look like the kiosks it hangs above rather than inventing
// a second one.
import { BrandedLoader } from "~/features/kiosk/components/BrandedLoader";
import { setDocumentNeverHidden } from "@/lib/use-visible-interval";

/**
 * A WALL PANEL IS NEVER HIDDEN, WHATEVER THE BROWSER SAYS.
 *
 * Edge marks a fullscreen player window hidden the moment Windows thinks it is
 * occluded or backgrounded, and every poll on this page runs through
 * useVisibleInterval, which pauses on exactly that signal. The TV then sits in
 * front of guests painting a feed from ten minutes ago — and stops writing the
 * heartbeat, so admin calls it offline while staff are looking straight at it
 * (owner 2026-08-19, the five HeadPinz front-desk screens).
 *
 * MODULE SCOPE, not an effect: React runs child effects before the parent's, so
 * every poll in the tree would already have been scheduled the wrong way by the
 * time a TvApp effect could set this. Importing this module is what makes it
 * true, which is exactly when it needs to be true.
 */
setDocumentNeverHidden(true);

const IDENTITY_KEY = "tv_screen_id";
/**
 * How long a booted board holds the branded loader waiting for its first feed
 * before falling through to whatever the default config says.
 *
 * Generous, because the case it exists for is a COLD boot — a fresh player
 * profile, a cleared cache, a slow first poll — and the alternative is house ads
 * on a pit board. Bounded, because a screen whose feed is genuinely dead should
 * end up showing something rather than spinning at a wall all night.
 */
const FEED_GRACE_MS = 12_000;
const BUILD_SHA = (process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 8);

/** "4s ago" / "6m ago" / "never" — for the ?debug=1 poll-health line, where the
 *  only question being asked is whether the number is small. */
function fmtAge(stampMs: number | null, nowMs: number): string {
  if (stampMs === null) return "never";
  const secs = Math.max(0, Math.round((nowMs - stampMs) / 1000));
  return secs < 90 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
}

export function TvApp({ initialScreenId = null }: { initialScreenId?: string | null } = {}) {
  const [screenId, setScreenId] = useState<string | null>(null);
  /**
   * Seeded from the URL on the SERVER, so the boot loader is branded correctly in
   * the very first painted markup.
   *
   * This cannot come from the identity effect below: that effect writes `venue`
   * and `booted` in the same batch, so `venue` is still its default for the whole
   * time the loader is on screen — every board, every boot, not a race. A
   * FastTrax pit board booted with the HeadPinz logo because of it (owner
   * 2026-08-14). The effect still owns identity afterwards, including the
   * localStorage fallback for a player opened with no query string.
   */
  const [venue, setVenue] = useState<SignageVenue>(
    () => parseScreenKey(initialScreenId)?.venue ?? "HPFM",
  );
  const [booted, setBooted] = useState(false);
  const [decision, setDecision] = useState<SceneDecision | null>(null);
  const [demo, setDemo] = useState<DemoMode>("off");
  /**
   * The bounded end of the wait below. Without it a screen whose feed is down
   * would spin forever, and a lobby wall is better off playing house ads than
   * showing a staff-facing loader all evening.
   */
  const [feedGraceOver, setFeedGraceOver] = useState(false);

  const { offset } = useKioskClock();
  // Fixed at mount; a reload gives the new tab a later value. Stamped in an
  // effect rather than during render, which must stay pure.
  const bootedAtRef = useRef(0);
  useEffect(() => {
    bootedAtRef.current = Date.now();
  }, []);

  /**
   * How long a board will hold the branded loader waiting for its first feed
   * before giving up and rendering whatever the default config says.
   *
   * Long enough to cover a cold player profile and a slow first poll — the case
   * the ads flash actually came from — and short enough that a screen whose feed
   * is genuinely dead still ends up showing something rather than spinning at a
   * wall all night.
   */
  useEffect(() => {
    if (!booted) return;
    const t = setTimeout(() => setFeedGraceOver(true), FEED_GRACE_MS);
    return () => clearTimeout(t);
  }, [booted]);

  /* ── identity ────────────────────────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Awaited so every state write below lands in a callback rather than
      // synchronously in the effect body — the same shape as the kiosk attract
      // screen's boot resolution.
      await Promise.resolve();
      if (cancelled) return;

      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get("screen");
      setDemo(parseDemoMode(params.get("demo")));
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(IDENTITY_KEY);
      } catch {
        /* private mode */
      }

      const resolved = parseScreenKey(fromUrl) ? fromUrl : parseScreenKey(stored) ? stored : null;
      const parsed = parseScreenKey(resolved);

      if (resolved && parsed) {
        setScreenId(resolved);
        setVenue(parsed.venue);
        try {
          localStorage.setItem(IDENTITY_KEY, resolved);
        } catch {
          /* non-fatal */
        }
        // Canonical URL, so a self-update hard reload returns to this screen —
        // still in debug if that is how it was opened. See canonicalTvPath.
        const canonical = canonicalTvPath(parsed.venue, parsed.screenNumber, {
          debug: params.has("debug"),
        });
        if (window.location.pathname + window.location.search !== canonical) {
          window.history.replaceState(null, "", canonical);
        }
      }
      setBooted(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const { feed: rawFeed, health } = useTvFeed(screenId);

  // Measured HERE, once, so the stamp on the glass and the flag on the wire can
  // never disagree about the same panel. See usePanelFill.
  const windowed = usePanelFill();

  const parsed = parseScreenKey(screenId);
  const isTest = parsed?.screenNumber === TEST_SCREEN_NUMBER;

  /**
   * IS A BRIEFING RUNNING IN THIS ROOM RIGHT NOW?
   *
   * Load-bearing for reloads. A briefing room has guests sitting in it watching a
   * safety film, and a self-update — or a staff "reload screens" press — would
   * black the wall out mid-sentence (owner 2026-08-11: "if the briefing video is
   * playing can we make sure that tv doesn't auto reload"). The briefing scene is
   * ROTATION content, not an interrupt, so `decision.isInterrupt` does not cover
   * it and the screen would otherwise have reloaded quite happily.
   *
   * Derived with the same pure function the scene uses. Deliberately covers the
   * whole timeline, not just the video: helmet sizes and the levelled-up board are
   * also shown to a room full of people. Rooms fall idle between groups, and a
   * deferred reload lands the moment one does.
   */
  // Read off the RAW feed, not the resolved `config` — that const is declared
  // further down this component, and referencing it here would be a
  // use-before-declaration ReferenceError at runtime rather than a type error
  // (the TDZ trap this codebase has been bitten by before). The resolver only
  // validates the literal, so reading it directly is equivalent.
  const rawBriefingRoom = rawFeed?.screen?.config?.briefingRoom;
  const briefingRoom =
    rawBriefingRoom === "red" || rawBriefingRoom === "blue" ? rawBriefingRoom : null;
  const briefingActive =
    !!briefingRoom &&
    briefingTimelineAt(rawFeed?.briefingRooms?.[briefingRoom] ?? null, rawFeed?.now ?? 0).phase !==
      "idle";

  /**
   * IS A HEAT CHECKING IN ON THIS TRACK BOARD RIGHT NOW?
   *
   * Same protection, for the same reason: racers are standing at the desk scanning,
   * and blacking the board out to install a build loses the one thing telling them
   * where to be (owner 2026-08-11: "not reload till next session is cleared or sent
   * to room").
   *
   * A reload itself is SAFE — everything on that board is server state (the session
   * comes from races-current, the names from the Redis scan rail), so a reloaded tab
   * repaints the same session and the same checked-in names. This is about not
   * flashing a wall at the wrong moment, not about losing anything.
   *
   * `briefedAtMs` is what ends it: the moment the group is sent to a briefing room
   * the board has finished with that heat, so a held reload lands immediately.
   */
  const checkinActive =
    !!rawFeed?.raceCheckin &&
    rawFeed.raceCheckin.sessionId != null &&
    rawFeed.raceCheckin.briefedAtMs == null;

  /**
   * Hold a reload while guests are depending on WHAT IS ON THIS SCREEN.
   *
   * SCOPED TO THE SCENE ACTUALLY SHOWING (owner 2026-08-15: "pit boards need to
   * auto reload new version"). Both conditions above are venue-wide facts — a
   * room is briefing, a heat is checking in — and applying them to every screen
   * meant the PIT BOARD inherited a hold that has nothing to do with it. During
   * trading hours one of those is nearly always true, so the pit walls never
   * reached a safe moment and simply never picked up a deploy: they were running
   * whatever build was live the last time someone power-cycled them.
   *
   * The hold only protects a scene a GUEST is reading and depending on — the
   * check-in board they are scanning at, the briefing room they are sat in. The
   * pit board is a staff instrument showing pure server state; a reload repaints
   * the identical session and roster a second later, so there is nothing to
   * protect it from. Same for the camera monitor and the ad loop.
   *
   * An interrupt (celebration, VIP welcome) is still never cut short — that is
   * the `isInterrupt` half of safeToReload, and it is orthogonal to this.
   */
  const activeScene = decision?.scene ?? null;
  const sceneGuestsDependOn = activeScene === "race-checkin" || activeScene === "briefing";
  const holdReloads = sceneGuestsDependOn && (briefingActive || checkinActive);

  // Staff asked the screens to reload. Obey it once, only for a request made
  // AFTER this tab booted — otherwise a day-old stamp would reload every screen
  // forever. bootedAt is captured on mount, so a reloaded tab has a fresh one.
  const reloadAt = rawFeed?.reloadAt ?? null;
  const [staffReloadWanted, setStaffReloadWanted] = useState(false);
  useEffect(() => {
    // bootedAtRef is 0 until the mount effect runs; guard so we never reload
    // on the very first paint before it is stamped.
    if (!reloadAt || !bootedAtRef.current || reloadAt <= bootedAtRef.current) return;
    setStaffReloadWanted(true);
  }, [reloadAt]);

  /**
   * HELD, not dropped, and now held for TWO reasons.
   *
   * `holdReloads` is the old one: a room is briefing or a heat is checking in, so
   * the moment that clears the press lands. Latching the request rather than
   * re-deriving it from the feed keeps that true even if the stamp rolls off the
   * feed while the room is busy — the same shape TvShell's `updatePending` uses.
   *
   * The gate is the new one. A reload with the origin unreachable parks Edge on
   * its own error page and the screen never comes back on its own — see
   * reload-gate.ts. A staff press arrives on a feed that may already be minutes
   * stale, so "the feed reached us" is not evidence the network is up now.
   */
  const reloadHeldForNetwork = useGatedReload(staffReloadWanted && !holdReloads);

  // Pushed-preview-or-URL resolution lives in demo.ts (effectiveDemoMode) so
  // the live probe exercises the app's real wiring, not a re-implementation.
  //
  // THE BUG THIS LAYOUT PREVENTS: the decoration below once read the raw URL
  // mode while the director read the resolved one — a patch that renamed only
  // one of the two silently no-op'd — so a pushed welcome/VIP preview resolved
  // correctly and then decorated NOTHING, and every wall showed ads
  // (2026-08-11). One variable now feeds both consumers.
  const effectiveDemo = effectiveDemoMode(rawFeed, demo);
  // Anchored to the feed's own server timestamp rather than a render-time
  // clock read: stable across re-renders, and it advances with each poll.
  const feed = useMemo(
    () => applyDemo(rawFeed, effectiveDemo, rawFeed?.now ?? 0),
    [rawFeed, effectiveDemo],
  );

  const config = useMemo(
    () => resolveScreenConfig(feed?.screen?.config ?? null, venue),
    [feed?.screen?.config, venue],
  );

  // Sleep is driven by venue hours, which lands with the welcome-board PR (the
  // same place the day's schedule arrives). Until then the rotation runs all
  // day, which is correct for a screen whose only scene needs no data.
  const asleep = false;

  // A screen we have never heard of still says WHICH screen it thinks it is,
  // briefly, so staff can spot a typo without a laptop. Guests see house ads.
  const label = screenId
    ? feed?.screen
      ? `${feed.screen.name || VENUE_INFO[venue]?.label} · ${screenId}`
      : `${screenId} · unprovisioned`
    : "no screen id";

  // `?debug=1` prints what the screen actually decided, in the browser that is
  // actually running. Every diagnosis tonight has been inference from the
  // server side; this is the one thing that can say what the CLIENT sees.
  const debug =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");

  /**
   * The overlay needs a clock OF ITS OWN, and that is the whole point.
   *
   * Every other re-render of this component is caused by a poll landing — so if
   * the ages below rode those, a wedged lane would freeze its own age display at
   * whatever it last said and read as healthy. The one number that has to keep
   * moving when nothing else does cannot be driven by the thing that stopped.
   *
   * Only ticks with ?debug=1 on the URL: a wall in front of guests gets no extra
   * render per second for a panel it is not showing.
   */
  const [debugNowMs, setDebugNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!debug) return;
    const iv = setInterval(() => setDebugNowMs(Date.now()), 1_000);
    return () => clearInterval(iv);
  }, [debug]);

  /**
   * A RELOADING BOARD SHOWS THE SPIN, NEVER ADS (owner 2026-08-14: "sometimes we
   * get some weird reloading on the pit assign screen that goes to ads. If any
   * reload is needed we should use the fasttrax spin reload. never go to ads").
   *
   * `booted` only means the screen has worked out WHICH screen it is — it is set
   * by the identity effect, which knows nothing about the feed. The playlist,
   * though, comes from `feed.screen.config`, so for the whole window between
   * those two the resolver was falling back to the venue default and the
   * director was faithfully rendering it: house ads, on a pit board, on the wall
   * above the seats. One render on a warm cache, and much longer on a cold one —
   * a fresh player profile, a cleared cache, a slow first poll — which is
   * exactly the "sometimes" in the report.
   *
   * Ads is what a screen with NOTHING CONFIGURED shows. It is not a stand-in for
   * a board that simply has not been told what it is yet, so the loader stays up
   * until the feed answers.
   */
  const waitingForConfig = booted && !!screenId && !rawFeed && !feedGraceOver;

  if (!booted || waitingForConfig) {
    // The ground colour, never a flash of white on a wall — plus the same
    // branded loader the kiosk uses, so the gap while a board is coming back
    // (a reboot, a new deploy installing, a screen id being switched) reads as
    // "this is starting up" instead of a dead panel. Reused rather than
    // reimplemented; it needs the two keyframes copied into tv.css, since /tv
    // loads only that stylesheet.
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "#000418",
          display: "grid",
          placeItems: "center",
          color: "#fff",
        }}
      >
        <BrandedLoader brand={venue === "FT" ? "fasttrax" : "headpinz"} size={360} />
      </div>
    );
  }

  return (
    <TvStage overscanPct={config.overscanPct}>
      <TvShell
        screenLabel={isTest ? `TEST · ${label}` : label}
        // Never interrupt a takeover, a celebration, or a BRIEFING to install a
        // new build. A briefing is rotation content, so it needs naming here
        // explicitly — see briefingActive above.
        safeToReload={!decision?.isInterrupt && !holdReloads}
        // For the self-heal, which deliberately does NOT ride safeToReload —
        // see the block comment in feed-heal.ts on why that would deadlock.
        screenId={screenId}
        health={health}
        windowed={windowed}
      >
        {/* THE POLL STAMPS, DOWN TO THE FOOTER OF THE SCORES WALL. They are
            read here because this is where the feed is polled, and the board
            that shows them is four layers down — reaching it by prop would mean
            widening SceneProps (the contract sixteen scenes implement) plus a
            pass-through on SceneDirector, Footer and Shell. Scoped to the
            director because scenes are the only consumers: the ?debug=1 overlay
            below already holds `health` directly. See feed-health.tsx. */}
        <FeedHealthProvider value={health}>
          <SceneDirector
            feed={feed}
            offset={offset}
            venue={venue}
            config={config}
            asleep={asleep}
            demo={effectiveDemo}
            onDecision={setDecision}
          />
        </FeedHealthProvider>
        {/* THE SETUP + SYNC TEST. An overlay rather than a scene: it has to be
            readable whatever the wall happens to be showing, and it must not
            disturb the rotation underneath — so the panels are still in step the
            moment it clears. */}
        {effectiveDemo === "identify" && (
          <WallIdentify
            screenId={screenId}
            screenName={feed?.screen?.name || VENUE_INFO[venue]?.label || ""}
            buildSha={BUILD_SHA}
            offset={offset}
            wall={config.wall}
            pairing={config.pairing}
          />
        )}
        {debug && (
          <pre
            style={{
              position: "absolute",
              left: 24,
              top: 24,
              zIndex: 99,
              margin: 0,
              padding: 16,
              maxWidth: 900,
              background: "rgba(0,0,0,0.85)",
              color: "#46d68c",
              font: "20px ui-monospace, monospace",
              whiteSpace: "pre-wrap",
              borderRadius: 12,
              border: "2px solid #46d68c",
            }}
          >
            {[
              `screen      ${screenId ?? "(none)"}`,
              `build       ${BUILD_SHA}`,
              `feed        ${rawFeed ? "ok" : "NULL — no feed yet"}`,
              // HOW OLD, not just whether. The last good feed is the floor, so
              // a wedged poll and a quiet night look identical on the glass —
              // this is the line that tells them apart without a laptop. Full
              // should read under 15s and the pulse under 2s; anything else is
              // a stalled lane.
              `polled      full ${fmtAge(health.lastFullOkMs, debugNowMs)} · pulse ${fmtAge(
                health.lastPulseOkMs,
                debugNowMs,
              )}`,
              `demoMode    ${rawFeed?.demoMode ?? "(none)"} -> ${effectiveDemo}`,
              `events      ${feed?.events?.length ?? "null"}`,
              `vip         ${feed?.vip?.length ?? "null"}`,
              `playlist    ${config.playlist.map((p) => p.scene).join(", ")}`,
              `SCENE       ${decision?.scene ?? "(deciding)"}`,
              `interrupt   ${String(decision?.isInterrupt ?? false)}`,
              `briefing    ${briefingRoom ?? "(not a briefing screen)"}${
                briefingActive ? " — ACTIVE" : ""
              }`,
              `checkin     ${rawFeed?.raceCheckin?.sessionId ?? "(none)"}${
                checkinActive ? " — checking in" : ""
              }`,
              `reloads     ${
                reloadHeldForNetwork
                  ? "HELD — waiting for the network"
                  : holdReloads
                    ? "HELD (guests on screen)"
                    : "allowed"
              }`,
              // What this PANEL actually applied, in the browser actually
              // running — so a fitting change can be confirmed at the wall
              // rather than inferred from what the admin form was saved with.
              `overscan    ${config.overscanPct}% per edge${
                config.overscanPct ? "" : " (fills the panel)"
              }`,
            ].join("\n")}
          </pre>
        )}
      </TvShell>
    </TvStage>
  );
}
