/**
 * Read back — or wipe — the lane decision log.
 *
 *   npx tsx scripts/lane-decisions.mts                      last 24h, every centre
 *   npx tsx scripts/lane-decisions.mts --center 9172 --hours 72
 *   npx tsx scripts/lane-decisions.mts --full               every field, one block per row
 *   npx tsx scripts/lane-decisions.mts --reset              WIPE (asks for --yes)
 *   npx tsx scripts/lane-decisions.mts --reset --center 9172 --yes
 *
 * The summary is the point: how often we had an opinion, how often the vendor took it, and
 * what it said when it did not. That is the difference between tuning the weights against
 * evidence and tuning them against a handful of Saturdays that disagreed with each other.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { readLaneDecisions, resetLaneDecisions } = await import("@/lib/lane-decisions-db");

const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const centerId = flag("center") ? Number(flag("center")) : undefined;
const hours = Number(flag("hours") ?? 24);
const CENTER_NAME: Record<number, string> = {
  9172: "HeadPinz Fort Myers",
  3148: "HeadPinz Naples",
  11542: "FastTrax duckpin",
};

if (args.includes("--reset")) {
  if (!args.includes("--yes")) {
    console.log(
      `Refusing to wipe without --yes.\n` +
        `  This DELETES the rows; it does not archive them.\n` +
        `  Re-run:  --reset ${centerId ? `--center ${centerId} ` : ""}--yes`,
    );
    process.exit(1);
  }
  const gone = await resetLaneDecisions(centerId);
  console.log(
    `Wiped ${gone} decision${gone === 1 ? "" : "s"}${centerId ? ` for ${centerId}` : ""}.`,
  );
  process.exit(0);
}

const rows = await readLaneDecisions({ centerId, sinceHours: hours, limit: 1000 });
const clock = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

console.log(
  `=== lane decisions · last ${hours}h · ${centerId ? (CENTER_NAME[centerId] ?? centerId) : "all centres"} ===\n`,
);

if (rows.length === 0) {
  console.log("  No decisions recorded.");
  console.log("  Either nothing has been booked in the window, or every booking was");
  console.log("  outside the guard's reach (not starting within ~20 minutes).");
  process.exit(0);
}

if (args.includes("--full")) {
  for (const r of rows) {
    console.log(`--- ${clock(r.createdAt)}  ${r.kind}  ${r.reservationId ?? "(none)"} ---`);
    console.log(`    centre ${r.centerId}  offer ${r.webOfferId ?? "—"}  ${r.players ?? "?"}p`);
    if (r.freeLanes?.length) console.log(`    floor free   ${r.freeLanes.join(", ")}`);
    if (r.allowedLanes?.length) console.log(`    section      ${r.allowedLanes.join(", ")}`);
    if (r.candidates?.length)
      console.log(`    offered      ${r.candidates.map((c) => c.join("+")).join("  then  ")}`);
    if (r.fromLanes?.length) console.log(`    was on       ${r.fromLanes.join("+")}`);
    if (r.chosenLanes?.length) console.log(`    ended on     ${r.chosenLanes.join("+")}`);
    if (r.attempts) console.log(`    attempts     ${JSON.stringify(r.attempts)}`);
    console.log(`    ${r.outcome}\n`);
  }
} else {
  for (const r of rows) {
    const lanes = r.chosenLanes?.length ? r.chosenLanes.join("+") : "—";
    const from = r.fromLanes?.length ? `${r.fromLanes.join("+")} -> ` : "";
    console.log(
      `  ${clock(r.createdAt).padEnd(13)} ${r.kind.padEnd(8)} ${(r.reservationId ?? "").padEnd(9)} ` +
        `${(from + lanes).padEnd(14)} ${r.outcome}`,
    );
  }
}

// ── The summary that actually answers "how is it going" ──────────────────────
const places = rows.filter((r) => r.kind === "place");
const hadOpinion = places.filter((r) => (r.candidates?.length ?? 0) > 0);
const tookIt = hadOpinion.filter((r) => r.failedOpen === false);
const refused = hadOpinion.filter((r) => r.failedOpen === true);
const repairs = rows.filter((r) => r.kind === "recheck");

console.log(`\n--- SUMMARY ---`);
console.log(`  bookings seen            ${places.length}`);
console.log(`  we had an opinion        ${hadOpinion.length}`);
console.log(`  vendor took our lane     ${tookIt.length}`);
console.log(`  vendor refused them all  ${refused.length}`);
console.log(`  repairs before arrival   ${repairs.length}`);

// Every refusal the vendor gave, counted. This is the list that tells us whether the
// classifier is keeping up with what QAMF actually says.
const reasons = new Map<string, number>();
for (const r of rows) {
  const attempts = Array.isArray(r.attempts)
    ? (r.attempts as { failure?: { code?: string } }[])
    : [];
  for (const a of attempts) {
    const code = a.failure?.code;
    if (code) reasons.set(code, (reasons.get(code) ?? 0) + 1);
  }
}
if (reasons.size) {
  console.log(`\n  refusals by reason:`);
  for (const [code, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(n).padStart(4)}  ${code}`);
  }
  if (reasons.get("unknown")) {
    console.log(
      `\n  "unknown" means we did NOT recognise what the vendor said and stopped trying\n` +
        `  lanes. Run with --full, read the message, and teach it to classifyPinFailure.`,
    );
  }
}
