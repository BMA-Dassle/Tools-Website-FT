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
 * WITH ONE EXCEPTION, ADDED AFTER IT COST US AN EVENING: when a different
 * hostname of ours proves the network is up while our own origin stays
 * unreachable, the fault is this page's connection and the reload IS the fix.
 * See the wedge-escape note further down — it is opt-in, it fires only on
 * positive proof, and it can only ever turn "held forever" into "reload".
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

/* ── the wedge escape ───────────────────────────────────────────────────────
 *
 * WHY THE GATE ABOVE IS NOT ENOUGH, AND WHAT IT COST US (FT:10, 2026-08-20).
 *
 * The red results wall went silent at 6:14 PM and was still silent eighteen
 * minutes later. It behaved exactly as designed: the stamp went amber at 90s,
 * the self-heal armed at five minutes, and the gate then held the reload back
 * because `originReachable` kept answering false. The owner walked over and
 * reloaded it by hand — AND THE RELOAD WORKED INSTANTLY.
 *
 * That is the whole finding. A reload needs the network. So the network was
 * fine, and had probably been fine for most of those eighteen minutes, while
 * every request this page made — the feed, the pulse, and the gate's own probe
 * — failed. Not an outage. A WEDGED CONNECTION.
 *
 * Everything a page fetches from its own origin is multiplexed over ONE HTTP/2
 * connection. When that connection black-holes — a NAT that drops the flow, a
 * wifi roam, a firewall ageing out state — every request on it hangs until the
 * OS finally gives up on the socket, which can take many minutes. A fresh
 * document gets a fresh connection, which is precisely why the manual reload
 * fixed it in one keystroke.
 *
 * So the gate's probe cannot tell "the network is down" from "this page's
 * connection is dead", BECAUSE IT ASKS DOWN THE SAME DEAD CONNECTION. And those
 * two need opposite responses: hold for the first, reload for the second. Held
 * on a wedge, the board waits for a human — the one outcome all this machinery
 * exists to remove.
 *
 * THE DISCRIMINATOR IS A DIFFERENT HOSTNAME. Our aliases all point at the same
 * deployment, but a browser opens a SEPARATE connection per origin — so a call
 * to the other one does not ride the wedge. If it answers, the network is up and
 * only this page is broken, and reloading is not merely safe, it is the fix.
 * If it fails too, this is a real outage and the strict rule stands: hold.
 *
 * IT CAN ONLY EVER TURN "HELD FOREVER" INTO "RELOAD", AND ONLY ON POSITIVE
 * PROOF. No proof, no escape — every existing guarantee is left where it was.
 */

/**
 * The hostnames the off-origin probe may use, in preference order.
 *
 * Both serve this same app, so either proves DNS, TLS and our deployment — the
 * property that made `/api/kiosk/version` the right same-origin probe applies
 * unchanged here. swflpassport.com is deliberately absent: middleware treats it
 * as a pure redirector that hosts nothing, so it proves less.
 */
export const OFF_ORIGIN_PROBE_HOSTS: readonly string[] = ["fasttraxent.com", "headpinz.com"];

/**
 * A probe URL on a host that is NOT the one this page came from, or null.
 *
 * Null when we cannot get off this origin, and null is honest: the whole value
 * of this check is that it uses a different connection, so falling back to the
 * current host would quietly re-ask the wedged one and answer "network down" to
 * a wedge — the exact confusion this exists to end. A dev host answers null too;
 * localhost has no second name and must never reach for production.
 */
export function offOriginProbeUrl(currentHostname: string): string | null {
  const here = currentHostname.toLowerCase();
  if (here === "localhost" || here === "127.0.0.1" || here === "[::1]") return null;
  const host = OFF_ORIGIN_PROBE_HOSTS.find((h) => h !== here);
  return host ? `https://${host}${RELOAD_PROBE_PATH}` : null;
}

/**
 * Is the NETWORK up, asked without using this page's own connection?
 *
 * `mode: "no-cors"`, so no CORS headers are needed anywhere and the answer comes
 * back opaque — which means THE RESOLVED PROMISE IS THE SIGNAL, not `res.ok`
 * (an opaque response has no readable status; reading `.ok` would see `false`
 * on a perfectly good answer). fetch rejects only on network-level failure —
 * DNS, TCP, TLS, timeout — so resolving means we reached a server, and that is
 * all this needs to establish.
 *
 * Deliberately weaker than `originReachable`: it proves the LINK, not that our
 * app is healthy. That is the right strength for the one decision it informs —
 * "is it the network, or is it just us?".
 */
export async function networkReachableOffOrigin(
  timeoutMs: number = RELOAD_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  if (typeof location === "undefined") return false;
  const url = offOriginProbeUrl(location.hostname);
  if (!url) return false;
  try {
    await fetch(url, {
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * How long the gate holds before it will entertain the wedge explanation.
 *
 * Three minutes of consecutive failures on top of the five the self-heal already
 * waited — so a wedged board recovers itself around the eight-minute mark
 * instead of never. Not shorter, because an ordinary outage that ends inside a
 * couple of minutes should end with the poll simply resuming, no navigation
 * spent. Not longer, because past this point a human is already walking over.
 */
export const RELOAD_WEDGE_AFTER_MS = 3 * 60_000;

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
  /**
   * Positive proof the NETWORK is up, taken OFF this page's own connection —
   * see the wedge-escape note above. Omit it and the strict rule stands: an
   * unreachable origin holds the reload for as long as it stays unreachable.
   *
   * Supplied only by callers whose reload is itself rate-limited, because this
   * is the one path that can navigate without our origin having answered. Today
   * that means the self-heal (capped at 3 attempts per rolling hour, per
   * screen — see feed-heal.ts) and NOT the deploy or nightly-recycle reloads,
   * which have no such cap and no such urgency.
   */
  offOriginProbe?: () => Promise<boolean>;
  wedgeAfterMs?: number;
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
  offOriginProbe,
  wedgeAfterMs = RELOAD_WEDGE_AFTER_MS,
}: GatedReloadOptions): GatedReloadHandle {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed probes. Counted rather than clocked so the policy stays
   *  pure — retries are on a fixed cadence, so `(n - 1) * retryMs` IS the time
   *  spent holding, and a rule about hours can then be tested in milliseconds. */
  let blockedRuns = 0;

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

    /* OUR ORIGIN IS UNREACHABLE FROM THIS PAGE — which is a network outage, or a
       wedged connection, and the probe above cannot tell them apart because it
       asks down the same connection. Once we have been held long enough that a
       passing hiccup is ruled out, ask a DIFFERENT hostname. Only a clear yes
       from it releases the reload; anything else, including a throw, leaves the
       strict rule exactly where it was. */
    blockedRuns += 1;
    if (offOriginProbe && (blockedRuns - 1) * retryMs >= wedgeAfterMs) {
      let networkUp = false;
      try {
        networkUp = await offOriginProbe();
      } catch {
        networkUp = false;
      }
      if (done) return;
      if (networkUp) {
        done = true;
        onBlocked?.(false);
        reload();
        return;
      }
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
