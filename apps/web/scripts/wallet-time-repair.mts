/**
 * Repair wallet racing licences poisoned by the 2026-08-06 timezone defect.
 *
 * THE DEFECT. A booking record's `heatStart` is CENTRE-LOCAL with no zone
 * marker ("2026-08-06T22:48:00"); Pandora's `scheduledStart` is absolute UTC
 * and says so with a Z. The pass writer ran both through `new Date()`, which
 * resolves a naive string in the SERVER's zone — UTC on Vercel — so every pass
 * written from a booking record carries a time four hours early. Racers
 * reported it (Jamil Hisham: 6:48 PM on the pass, 10:48 PM on the track).
 *
 * `184253b8` fixed the writer. It did NOT fix values already written: clearing
 * the `next_race` COLUMN left `meta.nextRace` intact, and meta is what the
 * phone renders. This walks the passes the writer can no longer reach and
 * rewrites them from source.
 *
 * WHICH PASSES. Only rows with `next_race_session_id IS NULL` — a row WITH a
 * session id was written by the pre-race cron from Pandora's Z-carrying field
 * and was never affected. Rows already reading "None in next 2 hrs" are skipped.
 *
 * NOT A +4h SHIFT. The correct time is re-derived from the booking record with
 * the fixed parser, so a pass whose racer also MOVED heats lands on their real
 * heat rather than on a corrected version of a stale one.
 *
 * Every PUT is an Apple push, and Apple warned us on 2026-08-06 that it was
 * about to disable automatic updates — so a pass whose recomputed value matches
 * what it already holds is left alone.
 *
 *   DRY:     node --env-file=apps/web/.env.local apps/web/scripts/wallet-time-repair.mts
 *   EXECUTE: node --env-file=apps/web/.env.local apps/web/scripts/wallet-time-repair.mts --execute
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {}
}
const EXECUTE = process.argv.includes("--execute");
/** Also clear passes still advertising a race that has already run. Stale, not
 *  mistimed — opt in, because each one is another Apple push. */
const STALE = process.argv.includes("--also-stale");
const TZ = "America/New_York";

const { neon } = await import("@neondatabase/serverless");
const { default: Redis } = await import("ioredis");
const q = neon(process.env.DATABASE_URL!);
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 3 });

// ---------------------------------------------------------------- time, fixed
// Verbatim behaviour of src/features/racing/wallet/licence-meta.ts. Inlined
// because these scripts run under plain node, which cannot resolve the app's
// `~/` aliases — the TESTS pin the real module, this only has to agree with it.

const hasZone = (s: string) => /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(s.trim());

function parts(iso: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const raw = String(iso ?? "").trim();
  if (!raw) return {};
  const naive = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (naive && !hasZone(raw)) {
    const [, y, mo, d, h = "0", mi = "0"] = naive;
    const anchored = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts })
        .formatToParts(anchored)
        .map((p) => [p.type, p.value]),
    );
  }
  const dt = new Date(raw);
  if (isNaN(dt.getTime())) return {};
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts })
      .formatToParts(dt)
      .map((p) => [p.type, p.value]),
  );
}

function heatEpoch(iso: string | null | undefined): number {
  const raw = String(iso ?? "").trim();
  if (!raw) return NaN;
  const naive = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (naive && !hasZone(raw)) {
    const [, y, mo, d, h, mi] = naive;
    const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi);
    const et = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(asUtc))
      .reduce<Record<string, string>>((a, p) => ((a[p.type] = p.value), a), {});
    const etAsUtc = Date.UTC(+et.year, +et.month - 1, +et.day, +et.hour % 24, +et.minute);
    return asUtc + (asUtc - etAsUtc);
  }
  return new Date(raw).getTime();
}

function formatHeat(heat: { scheduledStart: string; track: string; heatNumber?: number | null }) {
  const p = parts(heat.scheduledStart, {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (!p.month) return { nextRace: "", nextRaceLong: "", raceLabel: "" };
  const time = `${p.hour}:${p.minute} ${p.dayPeriod}`;
  const track = heat.track ? ` · ${heat.track}` : "";
  const raceLabel = heat.heatNumber != null ? `Heat ${heat.heatNumber}` : "";
  return {
    nextRace: `${p.month} ${p.day} · ${time}${track}`,
    nextRaceLong: `${p.weekday}, ${p.month} ${p.day} · ${time}${track}${raceLabel ? ` · ${raceLabel}` : ""}`,
    raceLabel,
  };
}

// ------------------------------------------------------------------- passkit
const REGION_BASE = process.env.PASSKIT_API_URL || "https://api.pub2.passkit.io";

function jwt(): string {
  const key = process.env.PASSKIT_API_KEY!;
  const secret = process.env.PASSKIT_API_SECRET!;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ uid: key, iat: now - 30, exp: now + 60 }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

async function putMember(memberId: string, metaData: Record<string, string>): Promise<void> {
  const res = await fetch(`${REGION_BASE}/members/member`, {
    method: "PUT",
    headers: { Authorization: jwt(), "Content-Type": "application/json" },
    body: JSON.stringify({ id: memberId, metaData }),
  });
  if (!res.ok) throw new Error(`PassKit ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// --------------------------------------------------------------- the racer's heat
interface BookingRacer {
  personId?: string | null;
  sessionId?: string | number | null;
  heatStart?: string | null;
  track?: string | null;
  heatName?: string | null;
}

/** The racer's next heat from OUR booking index — the same resolution order the
 *  hub uses, minus its first step (the pass row, which is the poisoned value we
 *  are here to replace). Only heats still ahead of us count. */
async function nextHeatFor(personId: string) {
  const billIds = await redis.smembers(`bookingrecord:person:${personId}`);
  const now = Date.now();
  let best: { start: number; racer: BookingRacer } | null = null;
  for (const billId of billIds.slice(0, 40)) {
    const raw = await redis.get(`bookingrecord:${billId}`);
    if (!raw) continue;
    let rec: { racers?: BookingRacer[] } | null = null;
    try {
      rec = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const r of rec?.racers ?? []) {
      if (String(r?.personId ?? "").trim() !== personId) continue;
      const start = heatEpoch(r?.heatStart);
      if (isNaN(start) || start < now - 20 * 60_000) continue;
      if (!best || start < best.start) best = { start, racer: r };
    }
  }
  if (!best) return null;
  const heat = Number(String(best.racer.heatName ?? "").replace(/\D+/g, ""));
  return {
    sessionId: String(best.racer.sessionId ?? ""),
    ...formatHeat({
      scheduledStart: best.racer.heatStart!,
      track: best.racer.track ?? "",
      heatNumber: Number.isFinite(heat) && heat > 0 ? heat : null,
    }),
  };
}

// ------------------------------------------------------------------------ run
const rows = (await q`
  SELECT person_id, member_id, meta
    FROM racer_wallet_passes
   WHERE next_race_session_id IS NULL
   ORDER BY person_id
`) as Array<{ person_id: string; member_id: string; meta: Record<string, string> | null }>;

console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} — ${rows.length} session-less passes\n`);

let fixed = 0;
let cleared = 0;
let skipped = 0;

for (const row of rows) {
  const meta = row.meta;
  const name = meta?.memberName ?? row.person_id;
  const stored = meta?.nextRace ?? "";

  // Nothing to be wrong about: a pass already reading the idle value was never
  // given a booking-record time.
  if (!meta || !stored || /^none\b/i.test(stored)) {
    skipped++;
    continue;
  }

  const heat = await nextHeatFor(row.person_id).catch(() => null);

  // Their heat has been and gone (or we have no record of one). Stale, but NOT
  // mistimed — a different defect, and each fix costs an Apple push. Only
  // touched with --also-stale.
  if (!heat) {
    if (!STALE) {
      console.log(`  · ${name} — stale, race already run (${stored}); --also-stale to clear`);
      skipped++;
      continue;
    }
    console.log(`  x ${name}`);
    console.log(`      was  ${JSON.stringify(meta.nextRace)}`);
    console.log(`      now  "None in next 2 hrs"`);
    if (EXECUTE) {
      const full = { ...meta, nextRace: "None in next 2 hrs", nextRaceLong: "—", raceLabel: "—" };
      try {
        await putMember(row.member_id, full);
        await q`UPDATE racer_wallet_passes
                   SET meta = ${JSON.stringify(full)}::jsonb, next_race = ${"None in next 2 hrs"}
                 WHERE person_id = ${row.person_id}`;
        console.log(`      pushed`);
      } catch (e) {
        console.log(`      FAILED ${(e as Error).message}`);
        continue;
      }
    }
    cleared++;
    continue;
  }

  // THE TIME IS THE DEFECT, so the time decides whether this row was hit.
  //
  // Never key off the whole triple: a pass whose time is already right but
  // whose stored `raceLabel` we cannot re-derive (the booking record does not
  // always carry a parseable heat name) would be "changed" only in the sense
  // that we would DELETE a correct label off it. Kyle Gordon's pass read
  // "5:48 PM · Heat 35", was never mistimed, and this rewrite would have taken
  // Heat 35 away from him.
  if (heat.nextRace === (meta.nextRace ?? "")) {
    console.log(`  = ${name} — time already correct (${stored})`);
    skipped++;
    continue;
  }

  // Past that gate the time genuinely moved, so a stored label describes some
  // OTHER heat and cannot be carried over.
  const next = {
    nextRace: heat.nextRace,
    nextRaceLong: heat.nextRaceLong,
    raceLabel: heat.raceLabel || "—",
  };

  console.log(`  ~ ${name}`);
  console.log(`      was  ${JSON.stringify(meta.nextRace)} / ${JSON.stringify(meta.nextRaceLong)}`);
  console.log(`      now  ${JSON.stringify(next.nextRace)} / ${JSON.stringify(next.nextRaceLong)}`);

  if (EXECUTE) {
    // MERGE, never replace: PUT /members/member REPLACES metaData, so sending
    // only the three changed keys would delete the barcode source.
    const full = { ...meta, ...next };
    try {
      await putMember(row.member_id, full);
      await q`
        UPDATE racer_wallet_passes
           SET meta = ${JSON.stringify(full)}::jsonb,
               next_race = ${next.nextRace},
               next_race_session_id = ${heat?.sessionId || null}
         WHERE person_id = ${row.person_id}
      `;
      console.log(`      pushed`);
    } catch (e) {
      console.log(`      FAILED ${(e as Error).message}`);
      continue;
    }
  }
  fixed++;
}

console.log(
  `\n${EXECUTE ? "pushed" : "would push"}: ${fixed} corrected, ${cleared} cleared to idle; ${skipped} untouched`,
);
await redis.quit();
