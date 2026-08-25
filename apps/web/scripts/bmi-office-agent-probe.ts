/**
 * bmi-office-agent-probe — LIVE, READ-ONLY.
 *
 * Proves the two things lib/bmi-office-agent.ts claims:
 *
 *   1. SOCKET REUSE. Node reports `req.reusedSocket` per request, so this is
 *      directly observable rather than inferred. Arm A goes through officeAgent
 *      and expects reuse after the first request; arm B is the CONTROL, an agent
 *      with keepAlive:false, which must show no reuse at all. Without arm B a
 *      pass proves nothing — Node's global agent also keeps connections alive,
 *      so "it reused a socket" is the default, not evidence.
 *
 *   2. THE CONCURRENCY CEILING. Fire more requests at once than maxSockets and
 *      sample how many sockets the agent actually opens. The rest must queue.
 *
 * Uses a deliberately tiny read (`/search` for a token that matches nothing —
 * 200 with an empty result) so this measures connections, not payload. Takes one
 * token from the shared cache, so it normally mints nothing at all.
 *
 *   npx tsx --env-file=../../.env.local scripts/bmi-office-agent-probe.ts
 */

import https from "https";
import { officeAgent } from "../lib/bmi-office-agent";
import { getOfficeToken } from "../lib/bmi-office-token";
import { officeReadSessionId } from "../lib/bmi-office-ids";

const OFFICE_HOST = "office-api22.sms-timing.com";
const SMS_VERSION = "6251006 202511051229";
const CK = "headpinzftmyers";

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.log(`   FAIL  ${m}`);
};
const pass = (m: string) => console.log(`   ok    ${m}`);

/** A near-empty read. Returns whether the socket was reused. */
function probeOnce(
  tok: string,
  agent: https.Agent,
): Promise<{ status: number; reused: boolean; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: OFFICE_HOST,
        // A token that matches nothing: 200, empty list, negligible body.
        path: `/api/${CK}/search?token=ZZZZZZZZ&maxResults=1`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${tok}`,
          "x-fast-version": SMS_VERSION,
          "x-session-id": officeReadSessionId("read", CK),
          clientkey: CK,
          "Content-Type": "application/json",
        },
        agent,
      },
      (res) => {
        res.on("data", () => undefined);
        res.on("end", () =>
          // reusedSocket is set by the time the response lands.
          resolve({
            status: res.statusCode ?? 0,
            reused: req.reusedSocket === true,
            ms: Date.now() - t0,
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

function openSockets(agent: https.Agent): number {
  const buckets = (agent as unknown as { sockets: Record<string, unknown[]> }).sockets ?? {};
  return Object.values(buckets).reduce((n, list) => n + (list?.length ?? 0), 0);
}

async function main() {
  console.log("BMI Office HTTPS agent — keep-alive and the concurrency cap (READ-ONLY)\n");

  const tok = await getOfficeToken(CK);

  // ── A. officeAgent: expect reuse after the first ─────────────────
  console.log("── A. officeAgent (keepAlive: true) ────────────────────");
  const reuse: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await probeOnce(tok, officeAgent);
    reuse.push(r.reused);
    console.log(`   req ${i + 1}: ${r.status}  reusedSocket=${r.reused}  ${r.ms}ms`);
  }
  const reusedAfterFirst = reuse.slice(1).every(Boolean);
  if (reuse[0] === false && reusedAfterFirst) {
    pass("one handshake, then 4 reuses — exactly what keep-alive is for");
  } else if (reusedAfterFirst) {
    // A socket left warm by an earlier run in this process is still a pass.
    pass("every request after the first reused a socket");
  } else {
    fail(`expected reuse after the first request, got [${reuse.join(", ")}]`);
  }

  // ── B. CONTROL: keepAlive:false must NOT reuse ───────────────────
  console.log("\n── B. control (keepAlive: false) ───────────────────────");
  const cold = new https.Agent({ keepAlive: false });
  const coldReuse: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await probeOnce(tok, cold);
    coldReuse.push(r.reused);
    console.log(`   req ${i + 1}: ${r.status}  reusedSocket=${r.reused}  ${r.ms}ms`);
  }
  cold.destroy();
  if (coldReuse.some(Boolean)) {
    fail("control reused a socket — this probe cannot tell keep-alive from the default");
  } else {
    pass("control never reused — the measurement above is meaningful");
  }

  // ── C. maxSockets caps in-flight connections ─────────────────────
  console.log("\n── C. concurrency ceiling (maxSockets = 4) ─────────────");
  let peak = 0;
  const sampler = setInterval(() => {
    peak = Math.max(peak, openSockets(officeAgent));
  }, 5);
  const burst = await Promise.all(Array.from({ length: 12 }, () => probeOnce(tok, officeAgent)));
  clearInterval(sampler);
  const bad = burst.filter((r) => r.status !== 200).length;
  console.log(`   12 concurrent reads: ${12 - bad} x 200, peak open sockets = ${peak}`);
  if (bad) fail(`${bad}/12 concurrent reads failed`);
  else if (peak > 4) fail(`opened ${peak} sockets — the maxSockets cap is not holding`);
  else pass(`queued behind ${peak} socket(s) instead of opening 12`);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — agent probe complete`);
}

main()
  .then(() => {
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((e) => {
    console.error("crashed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    officeAgent.destroy();
    try {
      const { default: redis } = await import("@/lib/redis");
      redis.disconnect();
    } catch {
      // Nothing to close.
    }
  });
