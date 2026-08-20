import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OFF_ORIGIN_PROBE_HOSTS,
  RELOAD_RETRY_MS,
  RELOAD_WEDGE_AFTER_MS,
  networkReachableOffOrigin,
  offOriginProbeUrl,
  originReachable,
  startGatedReload,
} from "./reload-gate";

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

/* ── the wedge escape ──────────────────────────────────────────────────────
 *
 * The fault these hold the line on: FT:10 sat silent for eighteen minutes with
 * its self-heal armed and held, and the reload a human then typed worked FIRST
 * TIME — so the network had been fine and only the page's own connection was
 * dead. Every test below is named for the half of that it protects: break the
 * hold when the network is provably up, and never otherwise.
 */

describe("the wedge escape", () => {
  /** Small numbers so the rule is legible; the shipped ones are checked below. */
  const RETRY = 1_000;
  const WEDGE = 5_000;

  it("reloads a HELD board once a second hostname proves the network is up", async () => {
    // The FT:10 case. Our origin never answers, so the strict gate would hold
    // for ever and wait for a human — but the network is fine, this page's
    // connection is simply dead, and a fresh document gets a fresh connection.
    const reload = vi.fn();
    startGatedReload({
      probe: async () => false,
      offOriginProbe: async () => true,
      reload,
      retryMs: RETRY,
      wedgeAfterMs: WEDGE,
    });
    await flush();
    expect(reload).not.toHaveBeenCalled();

    await advance(WEDGE);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("STILL NEVER NAVIGATES INTO A REAL OUTAGE — both probes failing means hold", async () => {
    // The guarantee the whole module exists for, unchanged. When the network is
    // genuinely gone the off-origin host is gone with it, so there is no proof,
    // so there is no escape.
    const reload = vi.fn();
    startGatedReload({
      probe: async () => false,
      offOriginProbe: async () => false,
      reload,
      retryMs: RETRY,
      wedgeAfterMs: WEDGE,
    });
    await flush();
    await advance(RETRY * 3_600);
    expect(reload).not.toHaveBeenCalled();
  });

  it("waits out the threshold rather than reloading on a passing hiccup", async () => {
    // A blip that clears in a minute should end with the poll simply resuming.
    // Spending a navigation on it puts a blink on a wall for nothing.
    const reload = vi.fn();
    const offOriginProbe = vi.fn(async () => true);
    startGatedReload({
      probe: async () => false,
      offOriginProbe,
      reload,
      retryMs: RETRY,
      wedgeAfterMs: WEDGE,
    });
    await flush();

    await advance(WEDGE - RETRY);
    expect(offOriginProbe).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("is OPT-IN — a gate given no off-origin probe holds exactly as it always did", async () => {
    // The deploy and nightly-recycle reloads keep the absolute rule. Only the
    // rate-limited self-heal path is handed the escape.
    const reload = vi.fn();
    startGatedReload({ probe: async () => false, reload, retryMs: RETRY, wedgeAfterMs: WEDGE });
    await flush();
    await advance(RETRY * 1_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("treats an off-origin probe that throws as no proof at all", async () => {
    // Same discipline as the main probe: an exception must fail towards waiting,
    // never towards a navigation taken on a bad assumption.
    const reload = vi.fn();
    startGatedReload({
      probe: async () => false,
      offOriginProbe: async () => {
        throw new TypeError("Failed to fetch");
      },
      reload,
      retryMs: RETRY,
      wedgeAfterMs: WEDGE,
    });
    await flush();
    await advance(RETRY * 100);
    expect(reload).not.toHaveBeenCalled();
  });

  it("prefers the origin coming back, and never reloads twice", async () => {
    // If our own origin answers first that is the ordinary recovery and it wins;
    // the escape must not then fire a second navigation behind it.
    let up = false;
    const reload = vi.fn();
    startGatedReload({
      probe: async () => up,
      offOriginProbe: async () => true,
      reload,
      retryMs: RETRY,
      wedgeAfterMs: WEDGE,
    });
    await flush();
    up = true;
    await advance(RETRY);
    expect(reload).toHaveBeenCalledTimes(1);

    await advance(WEDGE * 10);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stops saying it is blocked when the escape lets it go", async () => {
    // `?debug=1` and the shell's corner stamp both read this. A board that is
    // mid-reload must not still be claiming it is held back by the network.
    const onBlocked = vi.fn();
    startGatedReload({
      probe: async () => false,
      offOriginProbe: async () => true,
      reload: () => {},
      onBlocked,
      retryMs: RETRY,
      wedgeAfterMs: WEDGE,
    });
    await flush();
    expect(onBlocked).toHaveBeenLastCalledWith(true);

    await advance(WEDGE);
    expect(onBlocked).toHaveBeenLastCalledWith(false);
  });

  it("cancel() disarms the escape too", async () => {
    const reload = vi.fn();
    const handle = startGatedReload({
      probe: async () => false,
      offOriginProbe: async () => true,
      reload,
      retryMs: RETRY,
      wedgeAfterMs: WEDGE,
    });
    await flush();
    handle.cancel();

    await advance(WEDGE * 5);
    expect(reload).not.toHaveBeenCalled();
  });

  it("the SHIPPED numbers give a wedged board about eight minutes, not for ever", async () => {
    // 5 min for the self-heal to arm (feed-heal.ts) plus 3 min of holding here.
    // Pinned because the value of this change is entirely in how long a guest
    // stares at a dead board.
    expect(RELOAD_WEDGE_AFTER_MS).toBe(180_000);

    const reload = vi.fn();
    startGatedReload({ probe: async () => false, offOriginProbe: async () => true, reload });
    await flush();

    await advance(RELOAD_WEDGE_AFTER_MS - RELOAD_RETRY_MS);
    expect(reload).not.toHaveBeenCalled();
    await advance(RELOAD_RETRY_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("offOriginProbeUrl", () => {
  it("never hands back the host the page is already on — that is the whole point", () => {
    // Re-asking the current origin would ride the wedged connection and report
    // "network down" for a wedge, which is the confusion this exists to end.
    for (const host of OFF_ORIGIN_PROBE_HOSTS) {
      expect(offOriginProbeUrl(host)).not.toContain(`https://${host}/`);
    }
    expect(offOriginProbeUrl("fasttraxent.com")).toBe("https://headpinz.com/api/kiosk/version");
    expect(offOriginProbeUrl("headpinz.com")).toBe("https://fasttraxent.com/api/kiosk/version");
  });

  it("matches the host case-insensitively, because a URL's host is", () => {
    expect(offOriginProbeUrl("FastTraxEnt.com")).toBe("https://headpinz.com/api/kiosk/version");
  });

  it("gives a preview or venue host the first alternative", () => {
    // A *.vercel.app board is on neither name, so either proves a live network.
    expect(offOriginProbeUrl("tools-website-ft.vercel.app")).toBe(
      "https://fasttraxent.com/api/kiosk/version",
    );
  });

  it("REFUSES on localhost — a dev page must never reach for production", () => {
    expect(offOriginProbeUrl("localhost")).toBeNull();
    expect(offOriginProbeUrl("127.0.0.1")).toBeNull();
  });
});

describe("networkReachableOffOrigin", () => {
  beforeEach(() => vi.stubGlobal("location", { hostname: "fasttraxent.com" }));

  it("counts a RESOLVED fetch as proof, because a no-cors answer is opaque", async () => {
    // The trap: an opaque response reports ok === false however healthy it is.
    // Reading .ok here would make this always answer "network down" and quietly
    // restore the exact deadlock the escape removes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, type: "opaque", status: 0 }) as unknown as Response),
    );
    await expect(networkReachableOffOrigin()).resolves.toBe(true);
  });

  it("asks the OTHER hostname, opaquely and uncached", async () => {
    const fetchSpy = vi.fn(async () => ({}) as Response);
    vi.stubGlobal("fetch", fetchSpy);
    await networkReachableOffOrigin();

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://headpinz.com/api/kiosk/version");
    expect(init.mode).toBe("no-cors");
    expect(init.cache).toBe("no-store");
  });

  it("is false when the fetch rejects — that is a network that is not there", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(networkReachableOffOrigin()).resolves.toBe(false);
  });

  it("short-circuits on a definite offline without spending a round trip", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("navigator", { onLine: false });
    await expect(networkReachableOffOrigin()).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is false on localhost rather than probing production from a dev machine", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("location", { hostname: "localhost" });
    await expect(networkReachableOffOrigin()).resolves.toBe(false);
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
