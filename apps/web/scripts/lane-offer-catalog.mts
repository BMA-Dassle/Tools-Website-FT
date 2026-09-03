/**
 * What does OUR catalog know about each web offer?
 *
 * The section is currently inferred from where an offer happens to appear on today's board,
 * which is both unreliable and poisonable. If our own experience rows already name the
 * product, that is a far better source: it does not move, and one stray booking cannot
 * change it. READ-ONLY.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { getBowlingExperiences } = await import("@/lib/bowling-db");

for (const code of ["TXBSQN0FEKQ11", "PPTR5G2N0QXF7", "LAB52GY480CJF"]) {
  let rows;
  try {
    rows = await getBowlingExperiences(code, undefined, true);
  } catch (err) {
    console.log(`\n=== ${code} — FAILED: ${err instanceof Error ? err.message : err}`);
    continue;
  }
  console.log(`\n=== ${code} — ${rows.length} experiences ===`);
  for (const e of rows) {
    const r = e as unknown as Record<string, unknown>;
    console.log(
      `  offer ${String(r.qamfWebOfferId ?? "—").padStart(4)}  ` +
        `slug ${String(r.slug ?? "—").padEnd(34)} ` +
        `kind ${String(r.kind ?? "—").padEnd(12)} ` +
        `active ${String(r.isActive ?? r.is_active ?? "?")}  ` +
        `"${String(r.name ?? r.title ?? "").slice(0, 34)}"`,
    );
  }
  if (rows[0]) {
    console.log(`\n  available fields: ${Object.keys(rows[0] as object).join(", ")}`);
  }
}
