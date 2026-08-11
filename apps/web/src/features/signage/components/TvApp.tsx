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
import { applyDemo, parseDemoMode, type DemoMode } from "../demo";
import type { SceneDecision } from "../director/schedule";
import { SceneDirector } from "../director/SceneDirector";
import { TvStage } from "./TvStage";
import { TvShell } from "./TvShell";

const IDENTITY_KEY = "tv_screen_id";

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

  // Demo fixtures decorate the feed on a TEST screen only, and only in this
  // tab — never written, never published. See ../demo.ts.
  // Anchored to the feed's own server timestamp rather than a render-time
  // clock read: stable across re-renders, and it advances with each poll.
  const feed = useMemo(
    () => applyDemo(rawFeed, demo, isTest, rawFeed?.now ?? 0),
    [rawFeed, demo, isTest],
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
          onDecision={setDecision}
        />
      </TvShell>
    </TvStage>
  );
}
