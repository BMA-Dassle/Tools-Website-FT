/**
 * The polling loop behind {@link useVisibleInterval}, with no React in it.
 *
 * WHY IT IS ITS OWN MODULE. Every rule this loop enforces is a rule about what
 * a wall panel does over WEEKS — it never overlaps cycles, it never forks into
 * two loops, and it can never stop for good — and none of that is assertable
 * through a hook in this test environment (node, no DOM). Pulled out here, all
 * of it is: the tests drive fake timers and a `hidden` flag directly.
 *
 * The loop owns three invariants:
 *
 *   1. NO OVERLAP. The next cycle is scheduled only once the current one has
 *      settled, so a slow upstream cannot stack pending promises.
 *   2. NO WEDGE. Every cycle is bounded by a watchdog: at the deadline the
 *      signal is aborted and the loop moves on whether or not the callback ever
 *      settles. Rule 1 without this one is a loop that stops forever the first
 *      time a `fetch` stalls — see the note on the timeout in the hook.
 *   3. NO FORKING. Exactly one cycle is live at a time. A visibility resume
 *      supersedes the cycle in flight rather than running alongside it.
 */

/** The instant a cycle would be scheduled with, so tests can be explicit. */
export interface VisibleLoop {
  /** Feed the document's visibility in. Hidden pauses; visible resumes with an
   *  immediate cycle, because somebody just started looking at it. */
  setHidden(hidden: boolean): void;
  /** Permanent teardown — no further cycles, anything in flight aborted. */
  stop(): void;
}

export interface VisibleLoopOptions {
  /** One cycle. Receives the cycle's signal; forward it to every fetch. */
  run: (signal: AbortSignal) => void | Promise<void>;
  /** Gap between the end of one cycle and the start of the next. */
  delayMs: number;
  /** How long a cycle may run before its signal is aborted and the loop moves
   *  on regardless. */
  timeoutMs: number;
  /** Skips the opening cycle when the page starts life in a hidden tab. */
  hiddenAtStart?: boolean;
}

export function startVisibleLoop({
  run,
  delayMs,
  timeoutMs,
  hiddenAtStart = false,
}: VisibleLoopOptions): VisibleLoop {
  let stopped = false;
  let hidden = hiddenAtStart;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let activeController: AbortController | null = null;
  /** Only the newest cycle may schedule the next tick — invariant 3. */
  let generation = 0;

  function clearTimer() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function abortActive() {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  }

  async function tick(): Promise<void> {
    if (stopped || hidden) return;
    abortActive();
    clearTimer();

    const mine = ++generation;
    const ctrl = new AbortController();
    activeController = ctrl;

    let watchdogId: ReturnType<typeof setTimeout> | null = null;
    const watchdog = new Promise<void>((resolve) => {
      watchdogId = setTimeout(() => {
        // Abort BEFORE resolving, so a callback that honours the signal gets to
        // unwind its own fetch rather than being left running behind us.
        ctrl.abort();
        resolve();
      }, timeoutMs);
    });

    try {
      // `run` is called inside the async wrapper so that a SYNCHRONOUS throw
      // becomes a rejection the race can absorb, instead of an exception thrown
      // straight past the watchdog and out of the loop.
      await Promise.race([(async () => run(ctrl.signal))(), watchdog]);
    } catch {
      /* a failed cycle is the caller's business; the loop just keeps going */
    }

    if (watchdogId !== null) clearTimeout(watchdogId);
    if (activeController === ctrl) activeController = null;

    if (stopped || hidden) return;
    // Superseded — by a visibility resume, or by a stop-and-restart. Scheduling
    // from here would leave two timers running the same loop.
    if (mine !== generation) return;
    timerId = setTimeout(() => void tick(), delayMs);
  }

  function setHidden(next: boolean): void {
    if (stopped) return;
    hidden = next;
    if (next) {
      clearTimer();
      abortActive();
      return;
    }
    // Back on screen: fresh data now, not at the end of the current cadence.
    clearTimer();
    void tick();
  }

  function stop(): void {
    stopped = true;
    clearTimer();
    abortActive();
  }

  if (!hidden) void tick();

  return { setHidden, stop };
}
