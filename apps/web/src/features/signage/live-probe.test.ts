import { describe, it, expect } from "vitest";
import { applyDemo, effectiveDemoMode } from "./demo";
import { resolveScreenConfig } from "./defaults";
import { resolveActiveScene } from "./director/schedule";
import { sceneHasData, isSceneImplemented } from "./scenes/registry";
import type { SignageVenue } from "./constants";
import type { TvFeed } from "./types";

/**
 * LIVE PROBE — runs the exact client pipeline against production.
 *
 * Not a unit test with a tidy fixture: it fetches the real feed for a real
 * screen and asks the real scheduler what that screen should be showing right
 * now. Unit tests kept passing while the owner watched nothing happen on the
 * wall, which means the fixtures were not the thing under suspicion — the
 * production data and the deployed code were.
 *
 * Skipped unless SIGNAGE_PROBE=1 so CI never depends on the network.
 */
const BASE = process.env.SIGNAGE_PROBE_BASE ?? "https://fasttraxent.com";
const SCREEN = process.env.SIGNAGE_PROBE_SCREEN ?? "HPFM:1";
const RUN = process.env.SIGNAGE_PROBE === "1";

describe.runIf(RUN)("live probe", () => {
  it(`decides a scene for ${SCREEN} exactly as the browser would`, async () => {
    const res = await fetch(`${BASE}/api/tv/feed?screen=${encodeURIComponent(SCREEN)}`);
    expect(res.ok).toBe(true);
    const feed = (await res.json()) as TvFeed;

    // ── everything below mirrors TvApp/SceneDirector, in order ──────────
    const venue = (feed.screen?.venue ?? "HPFM") as SignageVenue;
    // effectiveDemoMode is the SAME function TvApp calls — not a re-derivation.
    // The previous probe re-implemented this resolution, got it right, and so
    // kept passing while the app itself was decorating with the wrong mode.
    // A probe that shares no code with the thing it probes can only test the
    // author's intent, never the deployment.
    const demo = effectiveDemoMode(feed, "off");
    const decorated = applyDemo(feed, demo, feed.now);
    const config = resolveScreenConfig(decorated?.screen?.config ?? null, venue);
    const decision = resolveActiveScene({
      nowMs: feed.now,
      config,
      hasData: (scene) => sceneHasData(scene, decorated),
      vips: decorated?.vip ?? null,
      events: decorated?.kioskEvents ?? [],
      seenEventIds: new Set(),
      isImplemented: isSceneImplemented,
    });

    console.log(
      JSON.stringify(
        {
          screen: feed.screen?.screenId ?? null,
          demoModeFromServer: feed.demoMode,
          parsedDemo: demo,
          vipPartiesAfterDemo: decorated?.vip?.length ?? 0,
          eventsAfterDemo: decorated?.events?.length ?? 0,
          playlist: config.playlist.map((p) => p.scene),
          vipEnabled: config.vip.enabled,
          crownEnabled: config.billboardCrown.enabled,
          DECIDED_SCENE: decision.scene,
        },
        null,
        2,
      ),
    );

    expect(decision.scene).toBeTruthy();
  }, 20_000);
});
