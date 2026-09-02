/**
 * Upload ONE marketing reel for the front-desk TV wall.
 *
 * The wall's other films are referenced straight off the public site, so they need no
 * upload — this is for a reel that exists only as a master on the marketing share and
 * has to be cut down before a TV can play it. Cut it with ffmpeg first; this script
 * only moves the finished file and refuses anything that would misbehave on the glass.
 *
 * REFUSES AUDIO. Every wall film plays muted (it is what makes gesture-free autoplay
 * legal, and the wall stands over a staff desk), so an audio track is pure payload that
 * every player downloads and no one ever hears.
 *
 * Pathname is pinned, not random-suffixed, so re-cutting a reel overwrites in place and
 * the URL in assets.ts keeps working. That IS an overwrite of a live asset — hence
 * --live, and hence the dry run first.
 *
 * Usage (from the repo root, with BLOB_READ_WRITE_TOKEN in apps/web/.env.local):
 *   node apps/web/scripts/upload-tv-wall-film.mjs <file> <name>          # dry run
 *   node apps/web/scripts/upload-tv-wall-film.mjs <file> <name> --live   # upload
 *
 *   e.g. node apps/web/scripts/upload-tv-wall-film.mjs ./nexus-18s.mp4 nexus-hero-18s
 */
import { put } from "@vercel/blob";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
    break;
  } catch {
    /* try the next location */
  }
}

const args = process.argv.slice(2).filter((a) => a !== "--live");
const LIVE = process.argv.includes("--live");
const [file, name] = args;

if (!file || !name) {
  console.error("usage: upload-tv-wall-film.mjs <file> <name> [--live]");
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error(`name must be lower-case kebab (got "${name}") — it becomes the pathname`);
  process.exit(1);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("BLOB_READ_WRITE_TOKEN not found in env or apps/web/.env.local");
  process.exit(1);
}

function probe(path) {
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,width,height",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      path,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

async function main() {
  const body = readFileSync(file);
  const info = probe(file);
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const seconds = Number(info.format?.duration ?? 0);

  if (!video) throw new Error(`${file} has no video stream`);
  if (video.codec_name !== "h264") {
    throw new Error(`codec is ${video.codec_name} — the players want H.264`);
  }
  if (audio) {
    throw new Error("this file carries an audio track; re-encode with -an (the wall is muted)");
  }

  const pathname = `videos/tv-wall/${name}.mp4`;
  console.log(
    `${LIVE ? "LIVE" : "DRY-RUN"}  ${file}\n` +
      `  ${video.width}x${video.height} · ${seconds.toFixed(1)}s · ` +
      `${(body.length / 1024 / 1024).toFixed(1)} MB → ${pathname}`,
  );
  if (!LIVE) {
    console.log("\nDry-run only — re-run with --live to upload.");
    return;
  }

  const blob = await put(pathname, body, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "video/mp4",
  });
  console.log(`  ✓ ${blob.url}`);
}

main().catch((err) => {
  console.error("upload failed:", err.message);
  process.exit(1);
});
