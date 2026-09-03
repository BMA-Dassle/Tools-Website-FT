/**
 * REPRO: staff report that we always look at the first lane of every section, and that a
 * booked first lane blocks the booking entirely.
 *
 * Calls the REAL functions against the REAL live board. Read-only — it asks what lanes we
 * would offer, and never creates anything.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { freeLaneCandidates } = await import("~/features/booking/service/immediate-lane-guard");
const { planLanesForNewBooking } = await import("~/features/lane-plan/place.server");
const { sectionsFor } = await import("~/features/lane-plan/sections");
const { listLanes } = await import("@/lib/qamf-bowling");
const { laneSectionForOffer } = await import("~/features/lane-plan/offer-section.server");

const CENTER = Number(process.argv[2] ?? 9172);
const PLAYERS = Number(process.argv[3] ?? 4);

const lanes = await listLanes(CENTER);
const free = lanes.filter((l) => l.Status === "Closed").map((l) => l.LaneNumber);
console.log(`=== centre ${CENTER} · ${PLAYERS} players ===`);
console.log(`floor free: ${free.join(", ")}\n`);

console.log("sections:");
for (const s of sectionsFor(CENTER)) {
  const sectionFree = free.filter((l) => s.lanes.includes(l));
  console.log(
    `  ${s.name.padEnd(10)} ${s.lanes[0]}-${s.lanes[s.lanes.length - 1]}   free here: ${sectionFree.join(", ") || "none"}`,
  );
}

// 1 ── The GUARD on its own, exactly as the hold route calls it when the engine has no
//      opinion. This is the path that runs for most bookings.
const bare = await freeLaneCandidates({ centerId: CENTER, players: PLAYERS });
console.log(`\n[1] guard alone (engine had no opinion)`);
console.log(`    would offer: ${bare.candidates.map((c) => c.join("+")).join("  then  ") || "nothing"}`);
const sections = sectionsFor(CENTER);
for (const set of bare.candidates) {
  const inSection = sections.find((s) => set.every((n) => s.lanes.includes(n)));
  console.log(`      ${set.join("+").padEnd(6)} -> ${inSection ? inSection.name : "SPANS SECTIONS"}`);
}

// 2 ── The ENGINE, for a Regular product. Needs a real offer + duration option to bound the
//      window; without one it declines to have an opinion, which is case [1] above.
for (const [offer, option] of [
  [154, 1247],
  [158, 1258],
] as const) {
  const sectionLanes = await laneSectionForOffer(CENTER, offer);
  const plan = await planLanesForNewBooking({
    centerId: CENTER,
    bookedAtMs: Date.now() + 10 * 60_000,
    players: PLAYERS,
    webOfferId: offer,
    optionId: option,
    optionType: "Time",
    allowedLanes: sectionLanes,
  });
  console.log(`\n[2] engine, offer ${offer} option ${option}`);
  console.log(`    would offer: ${plan.map((c) => c.join("+")).join("  then  ") || "NOTHING — no opinion"}`);
  for (const set of plan) {
    const inSection = sections.find((s) => set.every((n) => s.lanes.includes(n)));
    console.log(`      ${set.join("+").padEnd(6)} -> ${inSection ? inSection.name : "SPANS SECTIONS"}`);
  }

  // 3 ── And what the hold route ACTUALLY sends: the guard filtered by the engine's order.
  const combined = await freeLaneCandidates({
    centerId: CENTER,
    players: PLAYERS,
    preferred: plan,
    allowedLanes: sectionLanes,
  });
  console.log(
    `    hold route sends: ${combined.candidates.map((c) => c.join("+")).join("  then  ") || "nothing"}`,
  );
}

console.log(
  `\nWhat to look for: every candidate landing in a section the product cannot be sold on.\n` +
    `Each one is a live 409 the guest waits through, and there are only 3 attempts before we\n` +
    `give up and let QAMF choose.`,
);
