import https from "https";

/**
 * The single HTTPS agent every BMI Office caller shares.
 *
 * TWO JOBS.
 *
 * 1. KEEP-ALIVE. Before this, no Office call passed an `agent` at all, so each
 *    one went out on the global agent and paid a fresh TCP + TLS handshake.
 *    Reusing a socket is the difference between "one connection per request" and
 *    "a handful per instance" — and if BMI counts sockets rather than session
 *    ids, that distinction IS the incident they reported on 2026-08-25.
 *
 * 2. A HARD CONCURRENCY CEILING. `maxSockets` caps how many requests this
 *    process can have in flight toward Office at once; the rest queue rather
 *    than pile onto the vendor. That is the house rule for this upstream — see
 *    tasks/lessons.md "An upstream that answers fast or never needs CONCURRENCY,
 *    not a longer timeout" (2026-08-18). Every current caller is sequential, so
 *    4 is already generous; it exists to stop a future `Promise.all` over
 *    projects from becoming a thundering herd nobody notices until BMI calls.
 *
 * Deliberately NOT a per-caller agent: separate agents cannot pool with each
 * other, and the cap would then be 4 x (number of modules) instead of 4.
 *
 * `fetch`-based Office callers (~/features/daily-events) ride undici's own
 * pool, which already keeps connections alive; a Node agent does not apply
 * there and is not needed.
 */
export const officeAgent = new https.Agent({
  keepAlive: true,
  /** Hold an idle socket long enough for the next call in a run to reuse it. */
  keepAliveMsecs: 15_000,
  /** The ceiling. Queue beyond this instead of opening more connections. */
  maxSockets: 4,
  /** Keep a couple warm between runs on a reused lambda; drop the rest. */
  maxFreeSockets: 2,
  /** Reap a socket BMI has silently stopped answering on. */
  timeout: 30_000,
});
