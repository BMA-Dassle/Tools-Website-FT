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
import type { SceneDecision } from "../director/schedule";
import { SceneDirector } from "../director/SceneDirector";
import { TvStage } from "./TvStage";
import { TvShell } from "./TvShell";

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

  // Staff asked the screens to reload. Obey it once, only for a request made
  // AFTER this tab booted — otherwise a day-old stamp would reload every screen
  // forever. bootedAt is captured on mount, so a reloaded tab has a fresh one.
  const reloadAt = rawFeed?.reloadAt ?? null;
  useEffect(() => {
    // bootedAtRef is 0 until the mount effect runs; guard so we never reload
    // on the very first paint before it is stamped.
    if (reloadAt && bootedAtRef.current && reloadAt > bootedAtRef.current) {
      window.location.reload();
    }
  }, [reloadAt]);

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
    // One paint of the ground colour rather than a flash of white on a wall.
    return <div style={{ position: "fixed", inset: 0, background: "#000418" }} />;
  }

  return (
    <TvStage>
      <TvShell
        screenLabel={isTest ? `TEST · ${label}` : label}
        // Never interrupt a takeover or a celebration to install a new build.
        safeToReload={!decision?.isInterrupt}
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
            ].join("\n")}
          </pre>
        )}
      </TvShell>
    </TvStage>
  );
}
