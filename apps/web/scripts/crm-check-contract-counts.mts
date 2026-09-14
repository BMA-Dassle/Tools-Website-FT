/**
 * The badge must equal the list, under the SAME filters.
 *
 * It did not: with a rep selected the list showed that rep's contracts and the
 * badge still read the whole team's (owner, 2026-09-14: "That number is not
 * honooring the filter"). Runs the real `listContracts` both ways.
 */
import fs from "node:fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { listContracts } = await import("../src/features/crm/contracts/service/list.js");

for (const rep of [undefined, "stephanie", "kelsea", "lori"]) {
  const page = await listContracts({ win: "attention", rep, limit: 200 });
  const label = rep ?? "(no rep filter)";
  const match = page.total === page.counts.attention ? "MATCH" : "*** DISAGREE ***";
  console.log(
    `${label.padEnd(18)} list=${String(page.total).padStart(4)}  badge=${String(page.counts.attention).padStart(4)}   ${match}`,
  );
}
