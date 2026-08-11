/**
 * Re-serve a .MOV briefing film as `video/mp4`, without re-uploading it.
 *
 * THE BUG THIS FIXES. The Starter film is a .mov, and the blob store served it as
 * `video/quicktime`. Chromium REFUSES that MIME type as media — `canPlayType(
 * "video/quicktime")` returns "" in Edge — so the briefing room went black (owner
 * 2026-08-11: "in blue I'm getting briefing starting then it blacks out… that's a
 * .mov").
 *
 * The container was never the problem: a codec probe of the actual bytes shows
 * `avc1`, i.e. plain H.264. QuickTime and MP4 are both ISO base-media formats, so
 * Chromium's MP4 demuxer handles this file perfectly well — it just never gets
 * asked, because the Content-Type tells it not to bother. Locally it played during
 * upload only because a `blob:` URL is content-sniffed rather than MIME-dispatched.
 *
 * So the fix is one header. `copy()` rewrites it server-side, which means no 218 MB
 * re-upload over venue wifi: the store duplicates the object internally and we point
 * the manifest at the new URL. The new URL is also exactly what makes the players
 * re-download it — cache invalidation here is URL equality.
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/briefing-fix-mov-content-type.mts           # dry run
 *   cd apps/web && npx tsx scripts/briefing-fix-mov-content-type.mts --apply
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");

/** Chromium plays these; anything else in a <video> src is a coin toss. */
const GOOD = "video/mp4";

async function main() {
  const { copy, del } = await import("@vercel/blob");
  const { loadSignageAssets, saveSignageAsset } = await import(
    "../src/features/signage/data/signage-assets-db"
  );

  const assets = await loadSignageAssets();
  const keys = ["briefing-video:starter", "briefing-video:intermediate"] as const;

  for (const key of keys) {
    const a = assets[key];
    console.log(`\n── ${key} ──`);
    if (!a) {
      console.log("  not uploaded");
      continue;
    }

    const head = await fetch(a.url, { method: "HEAD" });
    const type = head.headers.get("content-type") ?? "?";
    console.log(`  now: ${type}`);
    if (type === GOOD) {
      console.log("  ✓ already served as video/mp4 — nothing to do");
      continue;
    }

    // Keep the .mov extension out of the new pathname: the store infers a type
    // from the extension when one is not given, and the point here is to stop
    // that inference from winning.
    const base = a.url.split("/").pop() ?? "briefing-video";
    const target = `briefing/${base.replace(/\.[^.]+$/, "")}-mp4.mp4`;
    console.log(`  → copying to ${target} as ${GOOD}`);

    if (!APPLY) {
      console.log("  DRY RUN — re-run with --apply");
      continue;
    }

    const copied = await copy(a.url, target, {
      access: "public",
      contentType: GOOD,
      addRandomSuffix: true,
      cacheControlMaxAge: 31 * 24 * 60 * 60,
    });
    console.log(`  copied: ${copied.url}`);

    const verify = await fetch(copied.url, { method: "HEAD" });
    const newType = verify.headers.get("content-type") ?? "?";
    if (newType !== GOOD) {
      console.log(`  ✗ copy is still ${newType} — leaving the manifest alone`);
      continue;
    }

    // Duration and size carry over unchanged: same bytes, different header.
    const { replacedUrl } = await saveSignageAsset({
      key,
      url: copied.url,
      size: a.size,
      durationMs: a.durationMs,
    });
    console.log(`  ✓ manifest updated (${newType})`);
    if (replacedUrl) {
      await del(replacedUrl).catch(() => {});
      console.log("  ✓ old blob deleted");
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error("fix failed:", err);
  process.exit(1);
});
