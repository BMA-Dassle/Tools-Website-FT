/** Flip the 2 already-settled bowling no-show combo rows to completed so they drop off Active Only. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { sql } = await import("@/lib/db");
const q = sql();
const r = (await q`
  UPDATE bowling_reservations SET status = 'completed'
  WHERE id IN (5300, 5612) AND status NOT IN ('completed', 'cancelled')
  RETURNING id, status, guest_name
`) as Array<Record<string, unknown>>;
console.log("updated:", r.map((x) => `#${x.id} ${x.guest_name}→${x.status}`).join(", ") || "none");
