/**
 * POV CLIPPER — the Railway half of the highlight reel.
 *
 * Sibling to kart-timing-bridge and vt3-bridge, but the traffic runs the other
 * way: those bridges push venue events INTO the web app, while this one is
 * pushed TO. A daily Vercel cron POSTs the reel's picks here; this cuts each
 * racer's fastest lap, uploads it to Blob, and POSTs the manifest rows back.
 *
 * WHY IT IS NOT A VERCEL FUNCTION:
 *  - ffmpeg and tesseract are ~120MB of apk packages. Bundled into the Next app
 *    they would sit on the deploy path of the booking flow, the kiosk and every
 *    TV feed, to serve one job a day.
 *  - Vercel caps a function at 300s. Ten clips at ~10-20s each plus OCR is
 *    uncomfortably close; a full rebuild would be over it.
 *
 * ACCEPTS AND RETURNS IMMEDIATELY (202). Cutting ten clips takes minutes, and
 * the cron that triggers it must not hold a connection open that long — the same
 * reasoning that puts the web app's own venue handling behind `after()`.
 * Progress comes back per clip on the result webhook, so a partial run still
 * publishes what it finished.
 */
import { createServer } from "node:http";
import { buildClip, type ClipJob, type ClipResult } from "./clip.js";

const PORT = Number(process.env.PORT || 8080);
/** Same header the kart bridge signs with; either secret is accepted so the two
 *  services can share one env var, as they already do web-side. */
const SECRETS = [process.env.KART_BRIDGE_SECRET, process.env.VT3_BRIDGE_SECRET].filter(
  Boolean,
) as string[];
/** Where finished clips are reported. Absent = build but publish nothing, which
 *  is a useful dry-run posture rather than an error. */
const RESULT_WEBHOOK = process.env.CLIP_RESULT_WEBHOOK || "";

/** ONE AT A TIME. Each clip is an ffmpeg encode; running ten in parallel on a
 *  small Railway container would thrash rather than finish sooner, and the whole
 *  job is off the critical path anyway. */
let running = false;

function log(...a: unknown[]) {
  console.log(`[pov-clipper]`, ...a);
}

async function report(payload: unknown): Promise<void> {
  if (!RESULT_WEBHOOK) return;
  try {
    await fetch(RESULT_WEBHOOK, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kart-bridge-secret": SECRETS[0] ?? "",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // A clip that was cut and uploaded but not reported is recoverable — the
    // blob exists and the next run re-reports it. Never fail the run for this.
    log("result webhook failed:", err instanceof Error ? err.message : err);
  }
}

async function processJobs(jobs: ClipJob[]): Promise<void> {
  const done: ClipResult[] = [];
  const failed: Array<{ videoCode: string; reason: string }> = [];

  for (const [i, job] of jobs.entries()) {
    const started = Date.now();
    try {
      const result = await buildClip(job);
      if (!result) {
        failed.push({ videoCode: job.videoCode, reason: "no usable media" });
        log(`${i + 1}/${jobs.length} ${job.videoCode} — skipped, no usable media`);
        continue;
      }
      done.push(result);
      log(
        `${i + 1}/${jobs.length} ${job.videoCode} ${job.racerName} — ` +
          `${(result.bytes / 1e6).toFixed(1)}MB, cut ${result.cutAtS.toFixed(1)}s ` +
          `(${result.anchor}) in ${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
      // Reported per clip, not in one batch at the end: a run that dies halfway
      // should still have published everything it managed.
      await report({ kind: "clip", result });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ videoCode: job.videoCode, reason });
      log(`${i + 1}/${jobs.length} ${job.videoCode} — FAILED: ${reason}`);
    }
  }

  log(`run complete: ${done.length} built, ${failed.length} failed`);
  await report({ kind: "run-complete", built: done.length, failed });
}

const server = createServer((req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && req.url === "/health") {
    return send(200, { ok: true, running, hasWebhook: !!RESULT_WEBHOOK });
  }
  if (req.method !== "POST" || req.url !== "/build") {
    return send(404, { error: "not found" });
  }
  if (SECRETS.length === 0) {
    console.error("[pov-clipper] no secret configured");
    return send(500, { error: "server not configured" });
  }
  const provided = req.headers["x-kart-bridge-secret"];
  if (typeof provided !== "string" || !SECRETS.includes(provided)) {
    return send(403, { error: "forbidden" });
  }
  if (running) {
    // Not an error: the daily cron firing while yesterday's run is still going
    // should be told to come back, not retried into a pile-up.
    return send(409, { error: "a run is already in progress" });
  }

  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let jobs: ClipJob[];
    try {
      const body = JSON.parse(raw) as { jobs?: ClipJob[] };
      jobs = Array.isArray(body.jobs) ? body.jobs : [];
    } catch {
      return send(400, { error: "invalid json" });
    }
    const valid = jobs.filter(
      (j) => j?.videoCode && Number.isFinite(j.bestLapAtMs) && Number.isFinite(j.bestLapMs),
    );
    if (valid.length === 0) return send(400, { error: "no valid jobs" });

    running = true;
    send(202, { accepted: valid.length, skipped: jobs.length - valid.length });
    log(`accepted ${valid.length} jobs`);
    processJobs(valid)
      .catch((err) => log("run threw:", err))
      .finally(() => {
        running = false;
      });
  });
});

server.listen(PORT, () => log(`listening on ${PORT}`));
