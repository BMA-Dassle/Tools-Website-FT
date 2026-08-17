/**
 * CUT ONE RACER'S FASTEST LAP AND PUT IT ON BLOB.
 *
 * THE SOURCE IS NEVER DOWNLOADED. VT3's R2 objects answer range requests
 * (`accept-ranges: bytes`, 206), and `-ss` BEFORE `-i` makes ffmpeg seek with
 * them — measured 2026-08-17, cutting 25s out of a 14-minute/800MB video took
 * 10 seconds and fetched tens of megabytes. Putting `-ss` after `-i` would
 * decode from the start and pull the whole file; do not reorder these flags.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { put } from "@vercel/blob";
import { readBurnIn, videoStartMs } from "./burnin.js";

export interface ClipJob {
  videoCode: string;
  racerName: string;
  /** Epoch ms the racer crossed the line COMPLETING their best lap. */
  bestLapAtMs: number;
  bestLapMs: number;
  /** Which slice of the lap to take, so consecutive clips are different corners:
   *  0 opening sector, 1 middle, 2 run to the line. */
  sector?: 0 | 1 | 2;
  clipSeconds?: number;
  /** Wall-clock race length, for the fallback when OCR fails. */
  raceDurationS?: number | null;
}

export interface ClipResult {
  videoCode: string;
  url: string;
  bytes: number;
  cutAtS: number;
  /** How the cut point was found — "burn-in" is exact, "estimate" is the old
   *  centring guess and is worth surfacing so a wall of estimates is visible. */
  anchor: "burn-in" | "estimate";
}

/** The stamp is read here. Far enough in that the camera is recording properly,
 *  early enough to be inside even a short video. */
const BURNIN_PROBE_S = 60;
/** Absorbs the burn-in's 1-second resolution. */
const LEAD_IN_S = 1.5;

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`));
    });
  });
}

interface Media {
  url: string;
  durationS: number;
  locked: boolean;
}

/**
 * VT3's public check endpoint. No credentials — but CALLING IT COUNTS AS AN
 * IMPRESSION, and the video-match cron reads those back as "did the racer watch
 * this?". One call per clip actually built is acceptable; never poll it.
 */
async function resolveMedia(videoCode: string): Promise<Media | null> {
  const res = await fetch(`https://sys.vt3.io/videos/code/${encodeURIComponent(videoCode)}/check`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    url?: unknown;
    video?: { duration?: unknown; locked?: unknown };
  };
  if (typeof body.url !== "string") return null; // locked videos expose only a sample
  return {
    url: body.url,
    durationS: Number(body.video?.duration) || 0,
    locked: body.video?.locked !== false,
  };
}

/**
 * Where in the file to start cutting.
 *
 * Prefers the burn-in, which is exact. Falls back to centring the race in the
 * video — the pre-OCR heuristic, kept only as a floor: it was measured 55s wrong
 * on a real video (true head pad 109s against the 164s symmetry predicts,
 * because cameras keep running while the group walks back), so a clip cut this
 * way is not the record lap and is reported as `anchor: "estimate"`.
 */
async function resolveCut(
  job: ClipJob,
  media: Media,
): Promise<{ cutAtS: number; anchor: "burn-in" | "estimate" }> {
  const clipS = job.clipSeconds ?? 12;
  const lapLenS = job.bestLapMs / 1000;

  const burn = await readBurnIn(media.url, BURNIN_PROBE_S);
  if (burn) {
    const startMs = videoStartMs(burn);
    const lapEndS = (job.bestLapAtMs - startMs) / 1000;
    const lapStartS = lapEndS - lapLenS;
    if (lapStartS >= 0 && lapEndS <= media.durationS) {
      // Rotate the window through the lap so the reel is not ten identical
      // run-ups to the start/finish line.
      const usable = Math.max(0, lapLenS - clipS);
      const phase = [0, 0.5, 1][job.sector ?? 0];
      const cutAtS = Math.max(0, lapStartS + usable * phase - (phase === 0 ? LEAD_IN_S : 0));
      return { cutAtS: Math.min(cutAtS, Math.max(0, media.durationS - clipS)), anchor: "burn-in" };
    }
    // A lap that lands outside the file means the stamp was misread; fall
    // through rather than cut somewhere arbitrary.
  }

  const raceS = job.raceDurationS ?? 0;
  const pad = raceS > 0 ? Math.max(0, (media.durationS - raceS) / 2) : media.durationS * 0.4;
  const cutAtS = Math.max(0, Math.min(media.durationS - clipS, pad + raceS * 0.55));
  return { cutAtS, anchor: "estimate" };
}

/**
 * Cut, encode and upload. Returns null when the video cannot serve a clip —
 * expired, still locked, or too short to contain the lap.
 */
export async function buildClip(job: ClipJob): Promise<ClipResult | null> {
  const media = await resolveMedia(job.videoCode);
  if (!media || !media.durationS) return null;

  // A camera mounted late or pulled early produces a file shorter than its race;
  // centring anything in it is a confident wrong answer (real case: a 191s video
  // of a 501s race).
  if (job.raceDurationS && media.durationS < job.raceDurationS) return null;

  const clipS = job.clipSeconds ?? 12;
  const { cutAtS, anchor } = await resolveCut(job, media);

  const dir = await mkdtemp(join(tmpdir(), "clip-"));
  const out = join(dir, `${job.videoCode}.mp4`);
  try {
    await run(
      "ffmpeg",
      [
        "-ss",
        cutAtS.toFixed(2), // BEFORE -i — see the header
        "-i",
        media.url,
        "-t",
        String(clipS),
        "-an", // the wall is silent
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        // The source runs ~9 Mbps, a recording spec rather than a playback one.
        // 6 Mbps is indistinguishable on a 1080p wall and roughly halves what we
        // store and what every TV has to download.
        "-crf",
        "26",
        "-maxrate",
        "6M",
        "-bufsize",
        "12M",
        "-movflags",
        "+faststart", // first frame plays before the file lands
        "-y",
        out,
      ],
      180_000,
    );

    const bytes = (await stat(out)).size;
    const body = await readFile(out);
    // addRandomSuffix is the cache-invalidation strategy across this codebase,
    // and it is what lets a surviving clip keep its URL — which is what keeps it
    // cached on the wall between daily rebuilds.
    const blob = await put(`pov-reel/${job.videoCode}.mp4`, body, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: true,
      cacheControlMaxAge: 31 * 24 * 3600,
    });
    return { videoCode: job.videoCode, url: blob.url, bytes, cutAtS, anchor };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
