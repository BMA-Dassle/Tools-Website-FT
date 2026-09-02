/**
 * PROBE: does QAMF actually tell us which lanes an offer may be sold on?
 *
 * Our `Lane` and `WebOfferDetail` interfaces carry no group/section field, but a TypeScript
 * interface is a claim, not evidence — `listWebOffers` already shipped a type that lied about
 * the response envelope. Extra runtime keys survive `JSON.parse`, so dumping the real payload
 * is the only way to know whether the lane group is genuinely invisible or merely unmodelled.
 *
 * READ-ONLY.
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { listLanes, listWebOffers, searchAvailability, toCenterLocalIso } =
  await import("@/lib/qamf-bowling");

const CENTER = Number(process.argv[2] ?? 9172);

const keysOf = (o: unknown): string[] =>
  o && typeof o === "object" ? Object.keys(o as Record<string, unknown>) : [];

console.log(`=== QAMF lane-group probe — center ${CENTER} ===\n`);

const lanes = await listLanes(CENTER);
console.log(`GET /centers/${CENTER}/lanes -> ${lanes.length} lanes`);
const laneKeys = new Set<string>();
for (const l of lanes) for (const k of keysOf(l)) laneKeys.add(k);
console.log(`  union of ALL runtime keys: ${[...laneKeys].join(", ")}`);
console.log(`  first lane verbatim: ${JSON.stringify(lanes[0])}`);
const modelled = new Set(["LaneNumber", "Status", "ClosedAt", "Reservation"]);
const extraLane = [...laneKeys].filter((k) => !modelled.has(k));
console.log(`  UNMODELLED keys: ${extraLane.length ? extraLane.join(", ") : "(none)"}`);

const offers = await listWebOffers(CENTER);
console.log(`\nGET /centers/${CENTER}/weboffers -> ${offers.length} offers`);
const offerKeys = new Set<string>();
for (const o of offers) for (const k of keysOf(o)) offerKeys.add(k);
console.log(`  union of ALL runtime keys: ${[...offerKeys].join(", ")}`);
const modelledOffer = new Set([
  "Id",
  "IsEnabled",
  "Title",
  "Description",
  "ImageUrl",
  "OpenType",
  "Options",
  "Services",
]);
const extraOffer = [...offerKeys].filter((k) => !modelledOffer.has(k));
console.log(`  UNMODELLED keys: ${extraOffer.length ? extraOffer.join(", ") : "(none)"}`);

// The offers the engine actually leans on at FM, plus anything whose title hints at a section.
for (const o of offers) {
  const hit = /vip|private|lounge|boutique|suite|special/i.test(o.Title);
  if (hit) console.log(`  section-ish offer ${o.Id}: "${o.Title}"`);
}
// THE READ-ONLY ORACLE, if it exists. If availability names the lanes an offer can be sold
// on, we can map every group without writing a single reservation. If it does not, the ONLY
// oracle left is the 409 `LanesNotCompatible` from a pinned create — a write.
const probeDate = process.argv[3] ?? "2026-08-29";
// `toCenterLocalIso` takes epoch ms, not a string — passing a string type-errors even though
// `new Date(string)` happens to coerce at runtime. Probe times must also sit on a 5-minute
// boundary or QAMF matches nothing.
const probeMs = Date.parse(`${probeDate}T18:00:00-04:00`);
try {
  const av = await searchAvailability(CENTER, {
    // QAMF validates `StartAt` and `EndAt` as EQUAL — despite the name, BookedAtRange is a
    // single instant, not a range. Sending a real range is a 400.
    BookedAtRange: {
      StartAt: toCenterLocalIso(probeMs),
      EndAt: toCenterLocalIso(probeMs),
    },
    TotalPlayers: 4,
    // Omitting Id returns ZERO availabilities — an empty answer is not evidence about lanes,
    // it just means the query never matched. Always name the offer.
    WebOffer: { Id: Number(process.argv[4] ?? 158), Services: ["BookForLater"] },
  });
  const entries = av.Availabilities ?? [];
  console.log(
    `\nPOST availability/search StartAt=${toCenterLocalIso(probeMs)} ` +
      `offer=${process.argv[4] ?? 158} 4 players -> ${entries.length} availabilities`,
  );
  const avKeys = new Set<string>();
  for (const e of entries) for (const k of keysOf(e)) avKeys.add(k);
  console.log(`  union of ALL runtime keys: ${[...avKeys].join(", ")}`);
  const modelledAv = new Set(["TotalPlayers", "BookedAt", "WebOffer"]);
  const extraAv = [...avKeys].filter((k) => !modelledAv.has(k));
  console.log(
    `  UNMODELLED keys: ${extraAv.length ? extraAv.join(", ") : "(none) — availability does NOT name lanes"}`,
  );
  if (entries[0])
    console.log(`  first entry verbatim: ${JSON.stringify(entries[0]).slice(0, 600)}`);
} catch (err) {
  console.log(`\n  availability probe failed: ${err instanceof Error ? err.message : String(err)}`);
}

const sample = offers.find((o) => String(o.Id) === "158") ?? offers[0];
if (sample) {
  console.log(`\n  offer ${sample.Id} "${sample.Title}" verbatim:`);
  console.log(`  ${JSON.stringify(sample).slice(0, 1500)}`);
  console.log(
    `  Services keys: ${[...new Set(sample.Services.flatMap((s) => keysOf(s)))].join(", ")}`,
  );
}
