/**
 * READ-ONLY: what would the camera monitors' check-in rail say right now?
 *
 *   npx tsx scripts/signage-checkin-rail-probe.mts
 *
 * IMPORTS THE APP WIRING — the same pure selection/counting the feed uses
 * (src/features/signage/checkin-progress.ts), not a re-implementation of it, so
 * a probe that agrees with the wall proves the wall.
 *
 * Prints, per track: the stored called heat, whether the age gate still counts
 * it as "checking in", and the live roster's checked-in count. Also prints the
 * raw `checkedIn` value of the first roster row, because the reason this rail
 * exists at all is that the field is a TIMESTAMP and one reader compared it to
 * `true`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import type { CheckinProgressSession } from "../src/features/signage/checkin-progress";

// The app's `src/**` is CommonJS under this workspace (no "type": "module"), so
// an .mts probe reaches its named exports through the interop object rather
// than by static named import — which silently resolves to nothing here.
const mod: any = await import("../src/features/signage/checkin-progress");
const { checkingInTracks, countCheckedIn, orderCheckinProgress } = mod.default ?? mod;

const PKEY = process.env.SWAGGER_ADMIN_KEY || "";
const LOC = "LAB52GY480CJF";
const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";

const { default: Redis } = await import("ioredis");
const redis = new Redis(REDIS_URL);

const now = Date.now();
const tracks = ["blue", "red", "mega"] as const;
const raw = await redis.mget(...tracks.map((t) => `pandora:last-race:fasttrax:${t}`));

const byTrack: Record<string, any> = {};
tracks.forEach((t, i) => {
  if (!raw[i]) return;
  try {
    byTrack[t] = JSON.parse(raw[i] as string);
  } catch {
    /* skip */
  }
});

console.log("stored called heats:");
for (const t of tracks) {
  const r = byTrack[t];
  console.log(
    `  ${t.padEnd(5)} ${r ? `session ${r.sessionId} · heat ${r.heatNumber} · ${r.raceType} · called ${r.calledAt}` : "(none)"}`,
  );
}

const open = checkingInTracks(byTrack, now);
console.log(`\nstill "checking in" after the age gate: ${open.length}`);

const rows: CheckinProgressSession[] = [];
for (const heat of open) {
  const res = await fetch(
    `https://bma-pandora-api.azurewebsites.net/v2/bmi/session/${LOC}/${heat.sessionId}/participants?excludeRemoved=true`,
    { headers: { Authorization: `Bearer ${PKEY}` }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) {
    console.log(`  ${heat.track}: roster HTTP ${res.status} — DROPPED (never shown as zero)`);
    continue;
  }
  const body = (await res.json()) as any;
  const list: any[] = Array.isArray(body?.data) ? body.data : [];
  const counts = countCheckedIn(list);
  console.log(
    `  ${heat.track}: raw checkedIn of row 1 = ${JSON.stringify(list[0]?.checkedIn)} (typeof ${typeof list[0]?.checkedIn})`,
  );
  if (counts.total === 0) {
    console.log(`  ${heat.track}: empty roster — DROPPED`);
    continue;
  }
  rows.push({ ...heat, ...counts });
}

console.log("\nwhat the Blue camera monitor would show:");
const ordered = orderCheckinProgress(rows, "blue");
if (ordered.length === 0) console.log("  (no rail — nothing checking in)");
for (const s of ordered) {
  const label = `${s.track}${s.heatNumber != null ? ` #${s.heatNumber}` : ""}${s.raceType ? ` · ${s.raceType}` : ""}`;
  console.log(`  ${label.padEnd(34)} ${s.checkedIn} / ${s.total}`);
}

await redis.quit();
