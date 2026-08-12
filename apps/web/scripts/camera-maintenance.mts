/**
 * THE CAMERA MAINTENANCE LIST — put a camera on the bench, or take it off.
 *
 * A camera on this list is dropped from the briefing-room return strip: it is not
 * missing, it is known-broken, and a permanently red box is how a board teaches
 * staff to ignore it (owner 2026-08-12: "make a maintenance list for cameras you
 * can easily change in database. 3, 6, and 31 can be put on there").
 *
 *   npx tsx scripts/camera-maintenance.mts                                  # show the list
 *   npx tsx scripts/camera-maintenance.mts --all                            # incl. returned
 *   npx tsx scripts/camera-maintenance.mts --bench=3,6,31 --reason="no clips" --apply
 *   npx tsx scripts/camera-maintenance.mts --return=6 --apply
 *
 * It affects NOTHING but the strip: no match is suppressed, no video hidden, and a
 * clip that does arrive from a benched camera still routes to its racer.
 *
 * The table is deliberately hand-editable — one row per camera, and "off the list"
 * works either by setting `cleared_at` or by deleting the row:
 *
 *   SELECT * FROM camera_maintenance WHERE cleared_at IS NULL;
 *   UPDATE camera_maintenance SET cleared_at = now() WHERE camera_number = 6;
 *   DELETE FROM camera_maintenance WHERE camera_number = 6;
 *
 * DRY RUN BY DEFAULT — pass --apply to write. Run from apps/web.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const APPLY = process.argv.includes("--apply");
const SHOW_ALL = process.argv.includes("--all");

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
function cameraList(name: string): number[] {
  const raw = arg(name);
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 999);
}

const et = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString("en-US", { timeZone: "America/New_York" }) : "—";

async function ensureSchema(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS camera_maintenance (
      camera_number INT PRIMARY KEY,
      reason        TEXT,
      noted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      noted_by      TEXT,
      cleared_at    TIMESTAMPTZ
    )
  `;
}

async function show(): Promise<void> {
  const rows = (await (SHOW_ALL
    ? sql`SELECT camera_number, reason, noted_at, noted_by, cleared_at FROM camera_maintenance ORDER BY camera_number`
    : sql`SELECT camera_number, reason, noted_at, noted_by, cleared_at FROM camera_maintenance WHERE cleared_at IS NULL ORDER BY camera_number`)) as Array<
    Record<string, unknown>
  >;
  if (rows.length === 0) {
    console.log(`\nThe maintenance list is empty — every camera counts as in service.\n`);
    return;
  }
  console.log(`\n=== camera maintenance list${SHOW_ALL ? " (incl. returned)" : ""} ===\n`);
  console.log(`  ${"cam".padStart(4)}  ${"benched".padEnd(24)} ${"by".padEnd(10)} reason`);
  for (const r of rows) {
    const cleared = r.cleared_at ? `  RETURNED ${et(r.cleared_at)}` : "";
    console.log(
      `  ${String(r.camera_number).padStart(4)}  ${et(r.noted_at).padEnd(24)} ${String(r.noted_by ?? "—").padEnd(10)} ${String(r.reason ?? "—")}${cleared}`,
    );
  }
  console.log(
    `\n  ${rows.filter((r) => !r.cleared_at).length} on the bench — dropped from the briefing-room strip.\n`,
  );
}

async function main() {
  await ensureSchema();

  const bench = cameraList("bench");
  const back = cameraList("return");
  if (bench.length === 0 && back.length === 0) {
    await show();
    console.log(`  Nothing to change. Pass --bench=3,6,31 or --return=6 (plus --apply).\n`);
    return;
  }

  const reason = arg("reason");
  const by = arg("by") ?? "ops";

  if (bench.length) {
    console.log(
      `\n${APPLY ? "BENCHING" : "would bench"}: ${bench.join(", ")}${reason ? `  reason: ${reason}` : ""}`,
    );
    if (APPLY) {
      for (const cam of bench) {
        await sql`
          INSERT INTO camera_maintenance (camera_number, reason, noted_by, cleared_at)
          VALUES (${cam}, ${reason}, ${by}, NULL)
          ON CONFLICT (camera_number) DO UPDATE
            SET reason = EXCLUDED.reason, noted_by = EXCLUDED.noted_by,
                noted_at = now(), cleared_at = NULL
        `;
      }
    }
  }
  if (back.length) {
    console.log(
      `${APPLY ? "RETURNING TO SERVICE" : "would return to service"}: ${back.join(", ")}`,
    );
    if (APPLY) {
      for (const cam of back) {
        await sql`UPDATE camera_maintenance SET cleared_at = now() WHERE camera_number = ${cam}`;
      }
    }
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply.`);
  }
  await show();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
