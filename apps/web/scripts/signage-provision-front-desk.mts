/**
 * Provision the FRONT DESK WALL at HeadPinz Fort Myers — five screens over a
 * second bank of kiosks, driven as ONE object off the shared clock.
 *
 * Same discipline as its siblings (signage-provision-checkin-screens.mts et al):
 * imports the app's own `rolePreset` and `saveSignageScreen`, so a row written
 * here cannot drift from what the admin form would write.
 *
 * TWO FIELDS, TWO MEANINGS — the thing to understand before editing this file:
 *
 *   `wall`    all five screens, positions 0..4 of 5. The CHOREOGRAPHY group:
 *             every scene renders its slice from `wall.position`.
 *   `pairing` the two screens sharing ONE Windows player. `resolvePair()`
 *             returns null for any group that isn't EXACTLY two, and that is
 *             what builds the dual-monitor launcher — so the machine pairs
 *             cannot be folded into the five-wide wall group.
 *
 * Screen 4 (HPFM:4) is deliberately UNPAIRED: it is the lone monitor on player
 * B and gets the single-screen launcher.
 *
 * THE TEAR INVARIANT: all five must carry a byte-identical playlist. Scene
 * selection is `slot % totalSlots`, so two panels with different slot totals
 * wrap at different moments and the wall visibly tears. The verify pass at the
 * bottom asserts this rather than trusting that a later hand-edit kept it true.
 *
 * REQUIRES `ScreenConfig.wall` (types.ts) and the `front-desk` role preset
 * (defaults.ts). Run it before those land and it will fail typecheck, which is
 * the correct outcome — not a silently half-provisioned wall.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/signage-provision-front-desk.mts            # dry run
 *   npx tsx scripts/signage-provision-front-desk.mts --apply    # write
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");

const VENUE = "HPFM" as const;
const WALL_ID = "hpfm-front-desk";
const COUNT = 5;

/** ~6in between panels on a ~48in picture width. Drives the virtual canvas any
 *  wall-wide gradient paints into. Measured, not guessed (owner 2026-08-17). */
const GAP_PCT = 12;

interface Plan {
  screenNumber: number;
  /** Staff-facing placement name. "TV 1" is the LEFTMOST as you face the desk. */
  name: string;
  position: number;
  /** Absent = the lone monitor on its player; no dual launcher offered. */
  pair?: { groupId: string; position: number };
  brand?: "fasttrax" | "headpinz";
  /**
   * THIS PANEL'S OWN BOARD — the thing it shows in preference to the pricing wall.
   *
   * Only the two ends have one: the self check-in list on the left (nearest the lanes,
   * and the only place a kiosk check-in learns its lane number) and today's events on
   * the right. The middle three have no job but pricing.
   *
   * It is no longer a span that frees them. Both playlist entries now span the whole
   * wall, and the pricing board is in `YIELDS_TO_WINGS` (director/schedule.ts) — so a
   * panel with a board of its own keeps it WHEN THAT BOARD HAS DATA, and joins the
   * prices when it does not. The check-in list always has something (it owns a designed
   * empty state), so TV1 never prices; the events board is usually quiet, so TV5 prices
   * all evening and steps aside for a party greeting when there is one (owner
   * 2026-09-01: a whole TV sat idle while prices took turns on the ones beside it).
   */
  outsideScene?: "bowling-checkin" | "event-welcome";
}

const PLAN: Plan[] = [
  { screenNumber: 2, name: "Front desk TV 1 (far left)", position: 0, pair: { groupId: "hpfm-fd-a", position: 0 }, brand: "fasttrax", outsideScene: "bowling-checkin" },
  { screenNumber: 3, name: "Front desk TV 2", position: 1, pair: { groupId: "hpfm-fd-a", position: 1 } },
  { screenNumber: 4, name: "Front desk TV 3 (centre)", position: 2 },
  { screenNumber: 5, name: "Front desk TV 4", position: 3, pair: { groupId: "hpfm-fd-c", position: 0 } },
  { screenNumber: 6, name: "Front desk TV 5 (far right)", position: 4, brand: "headpinz", outsideScene: "event-welcome" },
];
// TV 5 completes player C's pair; kept out of the literal above only to keep the
// row short, so set it here where it is impossible to miss.
PLAN[4].pair = { groupId: "hpfm-fd-c", position: 1 };

async function main() {
  const { listSignageScreens, saveSignageScreen } = await import(
    "../src/features/signage/data/signage-screens-db"
  );
  const { rolePreset } = await import("../src/features/signage/defaults");
  const { VENUE_INFO } = await import("../src/features/signage/constants");
  const { resolvePair } = await import("../src/features/signage/pairing");

  const before = await listSignageScreens();
  console.log(`\n── already provisioned (${before.length}) ──`);
  for (const s of before) {
    const scenes = (s.config.playlist ?? []).map((p) => p.scene).join(", ") || "ads";
    console.log(`  ${s.screenId.padEnd(9)} ${(s.name || "(unnamed)").padEnd(30)} — ${scenes}`);
  }

  // Refuse to squat on a screen number that already belongs to something else.
  // A front-desk row landing on an occupied key would silently repurpose a live
  // board, which is the one failure mode worth stopping the whole run for.
  const wanted = new Set(PLAN.map((p) => `${VENUE}:${p.screenNumber}`));
  const collisions = before.filter(
    (s) => wanted.has(s.screenId) && !s.config.wall && (s.config.playlist ?? []).length > 0,
  );
  if (collisions.length > 0) {
    console.error(`\n✗ REFUSING TO RUN — these keys already belong to other screens:`);
    for (const c of collisions) console.error(`    ${c.screenId}  "${c.name}"`);
    console.error(`  Move them, or change the screen numbers in PLAN.\n`);
    process.exit(1);
  }

  const preset = rolePreset("front-desk");

  console.log(`\n── plan ──`);
  console.log(`  wall "${WALL_ID}" · ${COUNT} screens · gap ${GAP_PCT}% of a panel`);
  console.log(`  playlist: ${(preset.config.playlist ?? []).map((p) => `${p.scene}×${p.slots ?? 1}`).join(" · ")}`);
  for (const p of PLAN) {
    const pair = p.pair ? `${p.pair.groupId}#${p.pair.position}/2` : "— (single monitor)";
    console.log(
      `  ${VENUE}:${String(p.screenNumber).padEnd(2)}  pos ${p.position}/${COUNT}  pair ${pair.padEnd(18)} mark ${(p.brand ?? "—").padEnd(9)} off-span ${p.outsideScene ?? "ads"}`,
    );
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.\n");
    return;
  }

  console.log(`\n── writing ──`);
  for (const p of PLAN) {
    await saveSignageScreen({
      screenId: `${VENUE}:${p.screenNumber}`,
      venue: VENUE,
      center: VENUE_INFO[VENUE].center,
      screenNumber: p.screenNumber,
      name: p.name,
      config: {
        // Spread the preset FIRST so the playlist is byte-identical on all five
        // — the tear invariant. Nothing below may touch `playlist`.
        ...preset.config,
        wall: {
          wallId: WALL_ID,
          position: p.position,
          count: COUNT,
          gapPct: GAP_PCT,
          ...(p.brand ? { brand: p.brand } : {}),
          ...(p.outsideScene ? { outsideScene: p.outsideScene } : {}),
        },
        ...(p.pair
          ? { pairing: { groupId: p.pair.groupId, position: p.pair.position, count: 2 } }
          : {}),
      },
    });
    console.log(`  ✓ ${VENUE}:${p.screenNumber} — ${p.name}`);
  }

  /* ── verify ─────────────────────────────────────────────────────────── */

  const after = await listSignageScreens();
  const wall = after
    .filter((s) => s.config.wall?.wallId === WALL_ID)
    .sort((a, b) => (a.config.wall!.position ?? 0) - (b.config.wall!.position ?? 0));

  console.log(`\n── verify ──`);
  let ok = true;
  const fail = (msg: string) => {
    ok = false;
    console.log(`  ✗ ${msg}`);
  };
  const pass = (msg: string) => console.log(`  ✓ ${msg}`);

  // 1. exactly five
  if (wall.length === COUNT) pass(`${COUNT} screens on wall "${WALL_ID}"`);
  else fail(`expected ${COUNT} screens on the wall, found ${wall.length}`);

  // 2. positions are exactly 0..4, no gaps, no duplicates
  const positions = wall.map((s) => s.config.wall!.position);
  const expected = Array.from({ length: COUNT }, (_, i) => i);
  if (JSON.stringify(positions) === JSON.stringify(expected)) pass(`positions 0..${COUNT - 1}`);
  else fail(`positions are [${positions.join(",")}], expected [${expected.join(",")}]`);

  // 3. THE TEAR INVARIANT — byte-identical playlists
  const playlists = wall.map((s) => JSON.stringify(s.config.playlist ?? []));
  const distinct = [...new Set(playlists)];
  if (distinct.length === 1) {
    const slots = (wall[0]?.config.playlist ?? []).reduce((n, e) => n + (e.slots ?? 1), 0);
    pass(`identical playlists — ${slots} slots (${Math.round((slots * 40) / 6) / 10} min loop)`);
  } else {
    fail(`playlists DIFFER across the wall (${distinct.length} variants) — the wall will TEAR`);
    wall.forEach((s, i) => console.log(`      ${s.screenId}: ${playlists[i]}`));
  }

  // 3b. no requiresData — it changes totalSlots per screen at runtime, which
  //     tears the wall even when the stored playlists are identical.
  const gated = (wall[0]?.config.playlist ?? []).filter((e) => e.requiresData);
  if (gated.length === 0) pass("no data-gated entries (totalSlots is constant)");
  else fail(`playlist has requiresData on [${gated.map((e) => e.scene).join(", ")}] — drops a segment when empty and tears the wall`);

  // 4. the launchers still resolve
  for (const groupId of ["hpfm-fd-a", "hpfm-fd-c"]) {
    const anchor = after.find((s) => s.config.pairing?.groupId === groupId);
    const resolved = anchor ? resolvePair(after, anchor.screenId) : null;
    if (resolved) pass(`dual launcher ${groupId}: ${resolved.left.screenId} | ${resolved.right.screenId}`);
    else fail(`dual launcher ${groupId} does NOT resolve to exactly 2 screens`);
  }
  const single = after.find((s) => s.screenId === `${VENUE}:4`);
  if (single && !single.config.pairing) pass(`${VENUE}:4 unpaired — single-screen launcher`);
  else fail(`${VENUE}:4 should have no pairing (it is the lone monitor on player B)`);

  // 5. brand marks land on the two ends and nowhere else
  const marks = wall.map((s) => s.config.wall!.brand ?? null);
  if (marks[0] === "fasttrax" && marks[COUNT - 1] === "headpinz" && marks.slice(1, -1).every((m) => m === null)) {
    pass("brand marks on the outer screens only (FastTrax left, HeadPinz right)");
  } else {
    fail(`brand marks are [${marks.join(", ")}] — expected fasttrax, …, headpinz`);
  }

  // 6. the TWO ENDS carry their own boards, the middle three do not
  const wings = wall.map((w) => w.config.wall!.outsideScene ?? null);
  if (
    wings[0] === "bowling-checkin" &&
    wings[COUNT - 1] === "event-welcome" &&
    wings.slice(1, -1).every((w) => w == null)
  ) {
    pass("ends carry their own boards (check-in left, events right); middle three do not");
  } else {
    fail(`own-board scenes are [${wings.join(", ")}] - expected bowling-checkin, ..., event-welcome`);
  }

  // 7. BOTH ENTRIES SPAN THE WHOLE WALL, and they mean different things by it. The
  //    showcase is one picture that needs all five panels; the pricing board is five
  //    independent panels, freed to reach the ends by YIELDS_TO_WINGS rather than by a
  //    narrower span. A stored `open-now: middle` here is the OLD wall — the pricing
  //    board would stop at TV4 and TV5 would sit on an idle signpost again.
  const spans = (wall[0]?.config.playlist ?? []).map((e) => `${e.scene}:${e.span ?? "wall"}`);
  if (spans.includes("open-now:wall") && spans.includes("vip-showcase:wall")) {
    pass("pricing and the showcase both span the whole wall");
  } else {
    fail(`spans are [${spans.join(", ")}] - expected open-now:wall and vip-showcase:wall`);
  }

  console.log(`\n── preview these five side by side BEFORE hanging anything ──`);
  for (const s of wall) console.log(`  /tv?screen=${s.screenId}   ${s.name}`);

  console.log(
    ok
      ? `\n  ✓ wall provisioned and consistent\n`
      : `\n  ✗ wall provisioned but INCONSISTENT — fix the failures above before hanging\n`,
  );
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error("provision failed:", err);
  process.exit(1);
});
