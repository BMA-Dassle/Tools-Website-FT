/**
 * WHEN A BOARD THAT HAS STOPPED HEARING US SHOULD RELOAD ITSELF.
 *
 * The liveness stamp made a wedged wall visible; this decides when it stops
 * needing a human. The three faults behind "the results screen froze again"
 * (`81ba375ae`, `74042a683`, `659507205`) are all fixed, and every one of them
 * shared the same tail: **an already-frozen screen cannot take the fix that
 * would have saved it**, because its update check rides the same dead loop. Each
 * one ended with somebody walking the floor reloading panels by hand.
 *
 * SO WHY IS THIS SAFE WHEN THE RELOAD IS THE THING THAT KILLED THE HPFM WALL?
 * Because it is not a bare reload. It goes through `startGatedReload`, which
 * proves the origin answers before it navigates and navigates AT MOST ONCE — the
 * exact protection built after that outage. A board with no network keeps its
 * last good picture and waits, which is the behaviour we want anyway.
 *
 * THREE RULES, AND EACH ONE IS THERE BECAUSE THE OBVIOUS VERSION IS WRONG:
 *
 *   1. NOT GATED ON `safeToReload`. Every other reload path waits for a calm
 *      beat — no interrupt, no briefing, no check-in on the glass. This one must
 *      not, and the reason is a deadlock: the scene decision is computed FROM THE
 *      FEED, so a feed that wedged while a celebration or VIP takeover was up
 *      pins `decision.isInterrupt` true forever. The board would then hold its
 *      own recovery back for as long as it stayed broken — the one state where
 *      waiting for a calm beat guarantees the beat never comes.
 *
 *   2. DERIVED, NOT LATCHED. The self-update flag is a latch because a shipped
 *      deploy does not un-ship. A dead feed absolutely does come back, and if it
 *      comes back while the gate is still waiting for the network then the board
 *      has already healed itself the cheap way — reloading on top of that is a
 *      blink on a wall for nothing. Arming from the CURRENT state means recovery
 *      disarms the gate.
 *
 *   3. A HARD BREAKER, because rule 2 is not enough. The loop this must not
 *      allow: the origin answers `/api/kiosk/version` fine while the feed lane
 *      itself is broken — a bad deploy, a 500 on `/api/tv/feed`, a screen id
 *      that no longer resolves. Staleness then survives the reload, and nothing
 *      in rules 1-2 stops the board reloading every few minutes forever, in
 *      front of guests, on every screen at once. So attempts are counted in
 *      localStorage over a rolling hour and capped. Past the cap the board stops
 *      trying and simply keeps its amber stamp up: we tried, it did not help,
 *      and a thrashing wall is worse than a still one that says it is stale.
 *
 * PURE — no clock, no storage, no React. The storage read/write pair below takes
 * the Storage in, so the policy is testable without a DOM. Wired in TvShell,
 * which owns every other reload path.
 */

/**
 * How long a board goes unheard before it tries reloading itself.
 *
 * THE SAME 90s THE STAMP GOES AMBER AT — deliberately one threshold, where there
 * used to be two. The first version held these apart on the reasoning that
 * "amber wants to be early, a reload wants to be sure", and set this to five
 * minutes. That reasoning priced a reload as expensive, and it no longer is:
 * arming does not navigate, it only asks. The gate still refuses to move until
 * the origin answers or a second hostname proves the network is up, the attempts
 * are still capped per hour, and an arm that never navigated is now refunded
 * (see dropLastAttempt). What is left to be "sure" about is nothing the extra
 * three and a half minutes was buying.
 *
 * What it was costing is measurable. FT:9 on 2026-08-20 sat dead for 8.3 minutes
 * on the very first outage after the gate fix, and the whole of the first five
 * was this constant. 90s is ~45 consecutive missed pulses on a 2s lane: no venue
 * wifi hiccup and no single slow upstream reaches it, and by then the wall has
 * already told the room it is stale. The board should start fixing itself at the
 * moment it admits it is broken, not four minutes later.
 */
export const FEED_HEAL_AFTER_MS = 90_000;

/** Attempts allowed inside FEED_HEAL_WINDOW_MS before the board gives up. */
export const FEED_HEAL_MAX_ATTEMPTS = 3;

/**
 * How often the shell re-asks the question.
 *
 * Coarse on purpose: the threshold is five minutes, so a 15s cadence costs one
 * trivial re-render of the shell (React bails out of the identical `children`
 * element beneath it) and still bounds the delay to recovery at 5m15s. It cannot
 * ride the update check — that runs every five minutes, which against a
 * five-minute threshold would put worst-case recovery at ten.
 */
export const FEED_HEAL_CHECK_MS = 15_000;

/**
 * The rolling window the cap applies over.
 *
 * An hour, not a day: a board that needed one reload at noon and one at seven
 * had two unrelated bad moments, and holding the first against the second would
 * eventually disable self-healing on every long-running screen in the estate.
 */
export const FEED_HEAL_WINDOW_MS = 60 * 60_000;

/** Where the attempt log lives. Per screen — one sick panel must not spend the
 *  budget of the healthy one beside it. */
export function healLogKey(screenId: string): string {
  return `tv_feed_heal:${screenId}`;
}

/** Attempt stamps still inside the window, oldest first. */
export function pruneAttempts(
  attempts: readonly number[],
  nowMs: number,
  windowMs: number = FEED_HEAL_WINDOW_MS,
): number[] {
  return attempts
    .filter((t) => Number.isFinite(t) && t <= nowMs && nowMs - t < windowMs)
    .sort((a, b) => a - b);
}

/**
 * Should this board arm a self-healing reload right now?
 *
 * `ageMs` is how long since anything was heard — null when the feed is healthy
 * or the board is still in its opening seconds, which are both "no".
 */
export function shouldHeal(args: {
  ageMs: number | null;
  attempts: readonly number[];
  nowMs: number;
  healAfterMs?: number;
  maxAttempts?: number;
  windowMs?: number;
}): boolean {
  const {
    ageMs,
    attempts,
    nowMs,
    healAfterMs = FEED_HEAL_AFTER_MS,
    maxAttempts = FEED_HEAL_MAX_ATTEMPTS,
    windowMs = FEED_HEAL_WINDOW_MS,
  } = args;
  if (ageMs === null || ageMs <= healAfterMs) return false;
  return pruneAttempts(attempts, nowMs, windowMs).length < maxAttempts;
}

/** The attempt log, or an empty list for anything unreadable — a corrupt entry
 *  must not be able to stop a board healing, and must not throw on a wall. */
export function readAttempts(store: Pick<Storage, "getItem">, screenId: string): number[] {
  try {
    const raw = store.getItem(healLogKey(screenId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  } catch {
    return [];
  }
}

/**
 * Record an attempt and return the pruned log.
 *
 * WRITTEN WHEN THE GATE IS ARMED, NOT WHEN IT NAVIGATES — the navigation
 * destroys this page, so anything written after it is never written. The cost
 * used to be that a board which recovered on its own while the gate was waiting
 * had still spent an attempt; `dropLastAttempt` below hands that one back.
 */
export function recordAttempt(
  store: Pick<Storage, "getItem" | "setItem">,
  screenId: string,
  nowMs: number,
  windowMs: number = FEED_HEAL_WINDOW_MS,
): number[] {
  const next = pruneAttempts([...readAttempts(store, screenId), nowMs], nowMs, windowMs);
  try {
    store.setItem(healLogKey(screenId), JSON.stringify(next));
  } catch {
    /* full or blocked storage — the attempt still happens, it just is not
       counted. Better an uncounted heal than a board that cannot recover. */
  }
  return next;
}

/**
 * Hand back the newest attempt, because it was never spent.
 *
 * WHY THE CAP NEEDED THIS BEFORE IT COULD BE ARMED EARLIER. The cap exists to
 * stop a board RELOADING every few minutes in front of guests. It does not exist
 * to ration wanting to. But the attempt is written at arm time, so a feed that
 * came back while the gate was still probing — no navigation, no blink, nothing
 * a guest could see — burned one of three all the same.
 *
 * At a five-minute threshold that was rare enough to ignore. At 90s it is the
 * common case: this venue drops screens for a minute at a time all evening (five
 * separate screens on 2026-08-20), and three such blips would have left the board
 * unable to heal the one real wedge that followed. The safety valve would have
 * been spent entirely on things it was never meant to catch.
 *
 * Only ever called on RECOVERY, and that is what makes it sound: if the gate had
 * navigated, this page would not be here to call it.
 */
export function dropLastAttempt(
  store: Pick<Storage, "getItem" | "setItem">,
  screenId: string,
): number[] {
  const kept = readAttempts(store, screenId).sort((a, b) => a - b);
  kept.pop();
  try {
    store.setItem(healLogKey(screenId), JSON.stringify(kept));
  } catch {
    /* unwritable storage — the refund is lost, which only makes the cap
       stricter. Never a reason to throw on a wall. */
  }
  return kept;
}
