/**
 * NEVER NAVIGATE A WALL PANEL INTO AN OUTAGE.
 *
 * Everything else on a TV is built to ride a network loss out. The feed poll
 * keeps its last good answer, the clock keeps its last offset, the localStorage
 * cache paints real content on a cold boot. One thing is not survivable — and it
 * is the one thing that fires on a timer with no network involved at all:
 * `window.location.reload()`.
 *
 * A reload while the origin is unreachable lands Edge on its OWN error page.
 * That page is not ours. No script of ours runs on it, nothing retries, and the
 * launcher's relaunch loop never fires because Edge did not exit — it is up,
 * showing "Hmmm… can't reach this page". Restoring the network changes nothing.
 * The panel is dead until somebody walks to the mini PC, and since the shell
 * method replaced explorer.exe there is no desktop to fix it from: it is
 * Ctrl+Shift+Esc and Task Manager. (HeadPinz Fort Myers front desk, 2026-08-19 —
 * "didn't recover nicely from network loss, they crashed".)
 *
 * All three things that reload a TV are exposed, and the worst of them needs no
 * network to fire:
 *
 *   - THE NIGHTLY RECYCLE (recycle.ts) is purely clock-driven, 02:00–06:00 venue
 *     time. Screens provisioned or power-cycled together share an uptime, so they
 *     reach the window inside the same 5-minute check — one outage overlapping
 *     those four hours takes a whole wall at once, which is exactly the shape of
 *     the report.
 *   - THE SELF-UPDATE reads the network to latch, but can then sit latched for
 *     hours behind a briefing hold before it navigates.
 *   - THE STAFF "reload screens" press arrives on a feed that may itself be
 *     minutes stale.
 *
 * So: prove the origin answers, THEN navigate. Waiting costs nothing — the panel
 * goes on showing the board it already has, which is the whole point of the
 * last-good-feed floor. A deferred reload is invisible; a reload into an outage
 * is a truck roll.
 *
 * Framework-free, because the retry policy is a rule about what a panel does over
 * hours and that needs a test rather than a careful reading. The React wiring is
 * a five-line hook in useGatedReload.ts.
 */

/**
 * The reachability probe. `/api/kiosk/version` is the right one and not just a
 * convenient one: it touches no database, no vendor and no cache, it is already
 * `no-store`, and every TV in the estate already calls it on the self-update
 * cadence — so it is proven reachable from a player, and answering it proves DNS,
 * TLS and the app, which a ping to a public resolver does not.
 */
export const RELOAD_PROBE_PATH = "/api/kiosk/version";

/** A probe that has not answered in this long is a network that is not there. */
export const RELOAD_PROBE_TIMEOUT_MS = 8_000;

/** How long a held reload waits before asking again. */
export const RELOAD_RETRY_MS = 30_000;

/**
 * Is our own origin answering right now?
 *
 * `navigator.onLine` is consulted only for its NO. It is famously worthless as a
 * yes — a player plugged into a live switch with a dead uplink reports online all
 * day — but a false is a real false and saves the round trip.
 */
export async function originReachable(
  timeoutMs: number = RELOAD_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    const res = await fetch(RELOAD_PROBE_PATH, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface GatedReloadHandle {
  cancel(): void;
}

export interface GatedReloadOptions {
  /** Answers "is the origin up?". Injected so the policy is testable. */
  probe: () => Promise<boolean>;
  /** Called exactly once, and only with the origin confirmed up. */
  reload: () => void;
  /** True while a wanted reload is being held back; false once it is not. */
  onBlocked?: (blocked: boolean) => void;
  retryMs?: number;
}

/**
 * Hold a wanted reload until the origin answers, then take it.
 *
 * Probes immediately — the overwhelmingly common case is a healthy network, and
 * a deploy or a staff press should land now, not in thirty seconds.
 *
 * `reload` is called AT MOST ONCE. A probe that throws counts as unreachable
 * rather than escaping, because the one outcome this module exists to prevent is
 * a navigation taken on a bad assumption.
 */
export function startGatedReload({
  probe,
  reload,
  onBlocked,
  retryMs = RELOAD_RETRY_MS,
}: GatedReloadOptions): GatedReloadHandle {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const attempt = async () => {
    if (done) return;
    let reachable = false;
    try {
      reachable = await probe();
    } catch {
      reachable = false;
    }
    if (done) return;
    if (reachable) {
      done = true;
      onBlocked?.(false);
      reload();
      return;
    }
    onBlocked?.(true);
    timer = setTimeout(() => void attempt(), retryMs);
  };

  void attempt();

  return {
    cancel() {
      done = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
