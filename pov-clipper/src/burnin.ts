/**
 * READ THE CAMERA'S BURNED-IN WALL CLOCK.
 *
 * This is what turns a lap time into a file offset. The kart cameras print
 * `YYYY/MM/DD HH:MM:SS` into the bottom-left of every frame, and it advances 1:1
 * with playback, so one frame fixes the video's start time:
 *
 *   videoStartWallClock = burnInAt(t) - t
 *
 * Verified against real footage 2026-08-17: the timing system said a lap
 * completed at 23:00:02.948 ET; the frame at the offset that math predicts read
 * 23:00:03. A ~50ms match between two systems sharing no identifier.
 *
 * VT3 EXPOSES NO RECORDING-START FIELD, which is why this exists at all.
 * `created_at` is dock/ingest time — tested as a substitute across 1,385 videos
 * and the interquartile spread was 243 SECONDS, so it cannot anchor anything.
 *
 * ONE SECOND OF RESOLUTION is all the burn-in has, so alignment is +/-1s. The
 * caller's lead-in absorbs that.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where the stamp sits, as a fraction of the frame. Generous — the crop only
 *  has to exclude the racing picture, and tesseract copes with slack. */
const CROP = "crop=iw/2.6:ih/11:0:ih*10/11";

export interface BurnIn {
  /** Venue-local wall clock the camera printed, as "YYYY-MM-DDTHH:MM:SS". */
  localStamp: string;
  /** Offset in the video the stamp was read at, seconds. */
  atS: number;
}

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`));
    });
  });
}

/**
 * Grab one frame and OCR the stamp out of it.
 *
 * The filter chain is doing real work, not decoration: the stamp is small,
 * white-on-dark and sits over moving footage. Upscaling 4x before thresholding
 * is what takes tesseract from unreliable to dependable on this source.
 *
 * Returns null on anything at all — a failed read must degrade to the caller's
 * fallback, never throw a clip run away.
 */
export async function readBurnIn(url: string, atS: number): Promise<BurnIn | null> {
  const dir = await mkdtemp(join(tmpdir(), "burnin-"));
  const png = join(dir, "stamp.png");
  try {
    await run("ffmpeg", [
      "-v",
      "error",
      // BEFORE -i: seek with range requests instead of streaming the file.
      "-ss",
      String(atS),
      "-i",
      url,
      "-frames:v",
      "1",
      "-vf",
      `${CROP},scale=iw*4:ih*4,format=gray,eq=contrast=1.6,threshold=128:255:0:255`,
      "-y",
      png,
    ]);

    // `--psm 7` = one text line, which the crop guarantees. The whitelist stops
    // tesseract inventing letters out of the picture bleeding into the crop.
    const raw = await run("tesseract", [
      png,
      "stdout",
      "--psm",
      "7",
      "-c",
      "tessedit_char_whitelist=0123456789/: ",
    ]);
    return parseBurnIn(raw, atS);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * "2026/08/16 22:53:39" -> { localStamp: "2026-08-16T22:53:39" }.
 *
 * PURE and exported so the parsing can be tested without a video. Tolerates the
 * spacing noise OCR produces; rejects anything that is not a plausible stamp
 * rather than returning a date that would silently mis-cut every clip.
 */
export function parseBurnIn(ocrText: string, atS: number): BurnIn | null {
  const m = /(\d{4})\s*\/\s*(\d{2})\s*\/\s*(\d{2})\s+(\d{2})\s*:\s*(\d{2})\s*:\s*(\d{2})/.exec(
    ocrText,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y);
  if (year < 2020 || year > 2100) return null;
  if (Number(mo) < 1 || Number(mo) > 12) return null;
  if (Number(d) < 1 || Number(d) > 31) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  return { localStamp: `${y}-${mo}-${d}T${h}:${mi}:${s}`, atS };
}

/** Venue-local ET wall clock -> epoch ms. Two-pass, so a stamp after midnight on
 *  a DST-transition night resolves with that night's actual offset. */
export function etLocalToUtcMs(local: string): number {
  const naive = Date.parse(`${local}Z`);
  const shown = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(new Date(naive))
    .replace(", ", "T");
  return naive - (Date.parse(`${shown}Z`) - naive);
}

/**
 * The video's start instant, from a burn-in read. This is the whole output of
 * this module: everything downstream is arithmetic against it.
 */
export function videoStartMs(b: BurnIn): number {
  return etLocalToUtcMs(b.localStamp) - b.atS * 1000;
}
