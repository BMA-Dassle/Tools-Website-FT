import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RELOAD_RETRY_MS, originReachable, startGatedReload } from "./reload-gate";

/**
 * The rule this file exists to hold: A WALL PANEL NEVER NAVIGATES INTO AN
 * OUTAGE. Every test is named for the failure it prevents, because the failure
 * is not "a reload was late" — it is a screen parked on Edge's error page with
 * nothing of ours left running to bring it back, until somebody drives to the
 * venue.
 */

/** Settle the microtask queue between timer advances — the gate awaits a probe. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startGatedReload", () => {
  it("reloads straight away when the origin answers", async () => {
    // The overwhelmingly common case: a healthy network. A deploy or a staff
    // press must land now, not on some retry cadence.
    const reload = vi.fn();
    startGatedReload({ probe: async () => true, reload });
    await flush();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("DOES NOT RELOAD WHILE THE ORIGIN IS UNREACHABLE (the screens died because it did)", async () => {
    const reload = vi.fn();
    startGatedReload({ probe: async () => false, reload });
    await flush();
    expect(reload).not.toHaveBeenCalled();

    // An hour of outage is still not a reason to navigate.
    await advance(RELOAD_RETRY_MS * 120);
    expect(reload).not.toHaveBeenCalled();
  });

  it("takes the reload the moment the network comes back", async () => {
    // Held, not dropped. The nightly recycle that fires at 3am into a dead
    // network still gets its memory amnesty — just later, and alive.
    let up = false;
    const reload = vi.fn();
    startGatedReload({ probe: async () => up, reload });
    await flush();
    expect(reload).not.toHaveBeenCalled();

    await advance(RELOAD_RETRY_MS * 3);
    expect(reload).not.toHaveBeenCalled();

    up = true;
    await advance(RELOAD_RETRY_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("treats a probe that throws as unreachable, never as permission to navigate", async () => {
    // The one outcome this module exists to prevent is a navigation taken on a
    // bad assumption, so an exception must fail towards waiting.
    const reload = vi.fn();
    startGatedReload({
      probe: async () => {
        throw new Error("DNS is gone");
      },
      reload,
    });
    await flush();
    await advance(RELOAD_RETRY_MS * 5);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads at most once, however many probes have landed", async () => {
    const reload = vi.fn();
    startGatedReload({ probe: async () => true, reload });
    await flush();
    await advance(RELOAD_RETRY_MS * 10);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("cancel() stops the wait, and no reload escapes afterwards", async () => {
    // The disarm path: a briefing starts, or the component unmounts. A pending
    // retry must not fire a navigation into a room full of people.
    let up = false;
    const reload = vi.fn();
    const handle = startGatedReload({ probe: async () => up, reload });
    await flush();
    handle.cancel();

    up = true;
    await advance(RELOAD_RETRY_MS * 5);
    expect(reload).not.toHaveBeenCalled();
  });

  it("says when it is holding, and stops saying so once it lets go", async () => {
    // `?debug=1` prints this at the wall. A held reload and a screen with
    // nothing to do look identical from the front, which is how the last one
    // went unnoticed for a day.
    let up = false;
    const onBlocked = vi.fn();
    startGatedReload({ probe: async () => up, reload: () => {}, onBlocked });
    await flush();
    expect(onBlocked).toHaveBeenLastCalledWith(true);

    up = true;
    await advance(RELOAD_RETRY_MS);
    expect(onBlocked).toHaveBeenLastCalledWith(false);
  });

  it("honours a caller's retry cadence", async () => {
    const probe = vi.fn(async () => false);
    startGatedReload({ probe, reload: () => {}, retryMs: 1_000 });
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);

    await advance(1_000);
    expect(probe).toHaveBeenCalledTimes(2);
    await advance(1_000);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});

describe("originReachable", () => {
  it("is true only for an OK answer from our own origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
    await expect(originReachable()).resolves.toBe(true);
  });

  it("is false for a non-OK answer — a 502 from the edge is not a live app", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false }) as Response),
    );
    await expect(originReachable()).resolves.toBe(false);
  });

  it("is false when the fetch rejects, which is what an outage looks like", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(originReachable()).resolves.toBe(false);
  });

  it("short-circuits on a definite offline without spending a round trip", async () => {
    // navigator.onLine is worthless as a yes — a player on a live switch with a
    // dead uplink reports online all day — but a false is a real false.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("navigator", { onLine: false });
    await expect(originReachable()).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ── the drift pin ─────────────────────────────────────────────────────── */

/** Anchored to this file, not to cwd — the workspace run invokes vitest from the
 *  repo root and a cwd-relative path is a test that passes where it is not
 *  asked. */
const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNAGE_DIR = HERE;
const TV_ROUTE_DIR = join(HERE, "..", "..", "..", "app", "tv");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("no signage surface reloads without the gate", () => {
  it("every window.location.reload() on a TV goes through startGatedReload", () => {
    // THE POINT OF THE WHOLE FILE, pinned so the next reason to reload a wall
    // panel inherits the protection instead of having to remember it. There are
    // three reasons today — a new deploy, the nightly memory recycle, and a
    // staff press — and each was a bare navigation until 2026-08-19, when one of
    // them fired into an outage and the front-desk wall had to be recovered by
    // hand.
    const offenders: string[] = [];
    for (const file of [...sourceFiles(SIGNAGE_DIR), ...sourceFiles(TV_ROUTE_DIR)]) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("location.reload(")) continue;
      // Legitimate: the callback handed TO the gate, which only runs it with
      // the origin confirmed up.
      if (src.includes("startGatedReload(")) continue;
      offenders.push(relative(HERE, file).replace(/\\/g, "/"));
    }
    expect(offenders, "reload these through useGatedReload / startGatedReload").toEqual([]);
  });

  it("is actually looking at the source it claims to be", () => {
    // A pin that silently scans nothing is worse than no pin.
    const files = [...sourceFiles(SIGNAGE_DIR), ...sourceFiles(TV_ROUTE_DIR)];
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("TvShell.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("TvApp.tsx"))).toBe(true);
    expect(files.some((f) => f.includes("reload-gate"))).toBe(true);
  });
});
