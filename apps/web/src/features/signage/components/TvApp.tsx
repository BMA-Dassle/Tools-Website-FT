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
  screenKey,
  VENUE_INFO,
  type SignageVenue,
  TEST_SCREEN_NUMBER,
} from "../constants";
import { resolveScreenConfig } from "../defaults";
import { useTvFeed } from "../useTvFeed";
import { applyDemo, effectiveDemoMode, parseDemoMode, type DemoMode } from "../demo";
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

const IDENTITY_KEY = "tv_screen_id";
const BUILD_SHA = (process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 8);

export function TvApp() {
  const [screenId, setScreenId] = useState<string | null>(null);
  const [venue, setVenue] = useState<SignageVenue>("HPFM");
  const [booted, setBooted] = useState(false);
  const [decision, setDecision] = useState<SceneDecision | null>(null);
  const [demo, setDemo] = useState<DemoMode>("off");

  const { offset } = useKioskClock();
  // Fixed at mount; a reload gives the new tab a later value. Stamped in an
  // effect rather than during render, which must stay pure.
  const bootedAtRef = useRef(0);
  useEffect(() => {
    bootedAtRef.current = Date.now();
  }, []);

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
        // Canonical URL, so a self-update hard reload returns to this screen.
        const canonical = `/tv?screen=${encodeURIComponent(screenKey(parsed.venue, parsed.screenNumber))}`;
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

  const rawFeed = useTvFeed(screenId);

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

  /** Hold a reload while guests are depending on what is on this screen. */
  const holdReloads = briefingActive || checkinActive;

  // Staff asked the screens to reload. Obey it once, only for a request made
  // AFTER this tab booted — otherwise a day-old stamp would reload every screen
  // forever. bootedAt is captured on mount, so a reloaded tab has a fresh one.
  const reloadAt = rawFeed?.reloadAt ?? null;
  useEffect(() => {
    // bootedAtRef is 0 until the mount effect runs; guard so we never reload
    // on the very first paint before it is stamped.
    if (!reloadAt || !bootedAtRef.current || reloadAt <= bootedAtRef.current) return;
    // HELD, not dropped: briefingActive is a dependency, so the moment the room
    // goes idle this effect re-runs and the reload happens then.
    if (holdReloads) return;
    window.location.reload();
  }, [reloadAt, holdReloads]);

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

  if (!booted) {
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
      >
        <SceneDirector
          feed={feed}
          offset={offset}
          venue={venue}
          config={config}
          asleep={asleep}
          demo={effectiveDemo}
          onDecision={setDecision}
        />
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
              `reloads     ${holdReloads ? "HELD (guests on screen)" : "allowed"}`,
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
