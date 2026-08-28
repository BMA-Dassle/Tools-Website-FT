/**
 * Swipe waiter — lets an IMPERATIVE loop `await` the next valid MSR swipe.
 *
 * The serial MSR (useSerialMsr) is event-driven: every swipe arrives through
 * `onSwipe`. The reactive screens (reload row, balance check, the new-card
 * cart) consume that directly. The sequential runs — a voucher basket
 * ("card 2 of 3"), the confirmation-screen fulfilment of cards bought with a
 * booking — read like the dispenser loop (`await dispenseAndRead()`), so they
 * need the swipe as a promise instead. This is that bridge:
 *
 *   const waiter = useRef(createSwipeWaiter()).current;   // ONE instance
 *   useSerialMsr({ onSwipe: (a) => { if (!waiter.feed(a)) normalHandling(a); } });
 *   …
 *   const acct = await waiter.wait({ timeoutMs: 90_000 });
 *
 * Rules that keep it safe on a kiosk:
 *  - Every wait is BOUNDED. A guest who walks away mid-run must not leave the
 *    screen listening forever — the next person's swipe would receive the
 *    previous guest's paid tokens. Callers always pass `timeoutMs`.
 *  - `feed` returns false when nobody is waiting, so the caller's ordinary
 *    swipe handling runs untouched.
 *  - `cancel` rejects only the PENDING wait; the instance stays usable. It is
 *    held in a ref and StrictMode's simulated unmount/remount reuses it.
 *  - One wait at a time: a second `wait()` cancels the first (a stale awaiter
 *    from an abandoned run must never steal a later swipe).
 */

export type SwipeWaitEnd = "cancelled" | "timeout";

export class SwipeWaitError extends Error {
  readonly kind: SwipeWaitEnd;
  constructor(kind: SwipeWaitEnd) {
    super(kind === "timeout" ? "No card was swiped in time." : "Swipe wait cancelled.");
    this.name = "SwipeWaitError";
    this.kind = kind;
  }
}

export interface SwipeWaitOptions {
  /** Give up after this long (rejects with kind "timeout"). */
  timeoutMs?: number;
  /** External cancel (rejects with kind "cancelled"). */
  signal?: AbortSignal;
}

export interface SwipeWaiter {
  /** Resolve with the next swiped account number. */
  wait(opts?: SwipeWaitOptions): Promise<string>;
  /** Hand a swipe to the pending wait. False = nobody was waiting. */
  feed(accountNumber: string): boolean;
  /** Reject the pending wait (if any). The waiter remains usable. */
  cancel(): void;
  /** Whether a wait is pending right now. */
  readonly waiting: boolean;
}

interface Pending {
  resolve: (acct: string) => void;
  reject: (err: SwipeWaitError) => void;
  cleanup: () => void;
}

export function createSwipeWaiter(): SwipeWaiter {
  let pending: Pending | null = null;

  /** Detach the pending wait (clearing its timer/listener) and return it. */
  const take = (): Pending | null => {
    const p = pending;
    pending = null;
    p?.cleanup();
    return p;
  };

  return {
    get waiting() {
      return pending != null;
    },
    wait(opts: SwipeWaitOptions = {}): Promise<string> {
      take()?.reject(new SwipeWaitError("cancelled"));
      return new Promise<string>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onAbort = () => take()?.reject(new SwipeWaitError("cancelled"));
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
        };
        pending = { resolve, reject, cleanup };
        if (opts.timeoutMs != null) {
          timer = setTimeout(() => take()?.reject(new SwipeWaitError("timeout")), opts.timeoutMs);
        }
        if (opts.signal) {
          if (opts.signal.aborted) onAbort();
          else opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    },
    feed(accountNumber: string): boolean {
      const p = take();
      if (!p) return false;
      p.resolve(accountNumber);
      return true;
    },
    cancel(): void {
      take()?.reject(new SwipeWaitError("cancelled"));
    },
  };
}
