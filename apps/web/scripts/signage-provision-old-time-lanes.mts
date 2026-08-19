/**
 * Provision the OLD TIME LANES pair at HeadPinz Fort Myers — two screens over the
 * PinBoyz lanes, each showing the PinBoyz mark on black and nothing else.
 *
 * Same discipline as its siblings (signage-provision-front-desk.mts et al):
 * imports the app's own `rolePreset` and `saveSignageScreen`, so a row written
 * here cannot drift from what the admin form would write.
 *
 * WHY THERE IS NO PAIRING GROUP, even though these two are "left" and "right"
 * and were asked for as a pair that works together.
 *
 *   `pairing` does exactly two things in this codebase, and NEITHER is "these
 *   screens are next to each other". It builds the two-monitor launcher
 *   (`resolvePair`), and it drives content composed across two boards. Each of
 *   these screens is on ITS OWN COMPUTER (owner 2026-08-19), so the dual
 *   launcher is the wrong file for both of them — taking it to either machine
 *   would leave one monitor on a desktop. Grouping them would put that wrong
 *   button on the admin page and label each screen as sharing a player PC it
 *   does not share.
 *
 *   Left and right are therefore carried by the NAMES, which is all they need to
 *   be while the content is one mark per screen. When something genuinely spans
 *   the two, the mechanism for it is `ScreenConfig.wall` — which was built for
 *   exactly this (several screens as one picture, independent of how they are
 *   cabled) and which deliberately does NOT imply a shared player. Adding it
 *   then is a one-line change to the PLAN below.
 *
 * REQUIRES the `logo-only` role preset (defaults.ts) and the `venue-logo` scene.
 * Run it before those land and it will fail typecheck, which is the correct
 * outcome — not a silently half-provisioned pair.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/signage-provision-old-time-lanes.mts            # dry run
 *   npx tsx scripts/signage-provision-old-time-lanes.mts --apply    # write
 */
import { readFileSync } from "node:fs";

const envText = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");

const VENUE = "HPFM" as const;
const ROLE = "logo-only" as const;
/** The mark both screens wear. */
const MARK = "pinboyz" as const;

interface Plan {
  screenNumber: number;
  /** Staff-facing placement name. LEFT/RIGHT as you face the lanes — and, with no
   *  pairing group, the ONLY thing that records which screen is which. */
  name: string;
}

/**
 * HPFM:7 and HPFM:8 — the next two free keys at this venue. HPFM:1 is the
 * original kiosk-bank TV and HPFM:2–6 are the front-desk wall, so these do not
 * collide with anything; the run refuses outright if that stops being true.
 */
const PLAN: Plan[] = [
  { screenNumber: 7, name: "Old Time Left" },
  { screenNumber: 8, name: "Old Time Right" },
];

async function main() {
  const { listSignageScreens, saveSignageScreen } =
    await import("../src/features/signage/data/signage-screens-db");
  const { rolePreset } = await import("../src/features/signage/defaults");
  const { VENUE_INFO } = await import("../src/features/signage/constants");
  const { resolveLogoMark, LOGO_MARKS } = await import("../src/features/signage/logo");
  const { isSceneImplemented } = await import("../src/features/signage/scenes/registry");
  const { resolvePair } = await import("../src/features/signage/pairing");
  const { startupScriptFileName } = await import("../src/features/signage/startup-script");

  const before = await listSignageScreens();
  console.log(`\n── already provisioned (${before.length}) ──`);
  for (const s of before) {
    const scenes = (s.config.playlist ?? []).map((p) => p.scene).join(", ") || "ads";
    console.log(`  ${s.screenId.padEnd(9)} ${(s.name || "(unnamed)").padEnd(30)} — ${scenes}`);
  }

  // Refuse to squat on a key that already belongs to something else. A logo card
  // landing on a live board would replace a working screen with a holding card,
  // which is the one failure mode worth stopping the whole run for. A row that is
  // ALREADY one of ours is not a collision — this script is idempotent.
  const wanted = new Set(PLAN.map((p) => `${VENUE}:${p.screenNumber}`));
  const isOurs = (playlist: { scene: string }[]) =>
    playlist.length > 0 && playlist.every((e) => e.scene === "venue-logo");
  const collisions = before.filter(
    (s) => wanted.has(s.screenId) && !isOurs(s.config.playlist ?? []),
  );
  if (collisions.length > 0) {
    console.error(`\n✗ REFUSING TO RUN — these keys already belong to other screens:`);
    for (const c of collisions) {
      const scenes = (c.config.playlist ?? []).map((p) => p.scene).join(", ") || "ads";
      console.error(`    ${c.screenId}  "${c.name}"  — ${scenes}`);
    }
    console.error(`  Move them, or change the screen numbers in PLAN.\n`);
    process.exit(1);
  }

  const preset = rolePreset(ROLE);

  // The scene has to EXIST in this deploy, or the scheduler refuses to select it
  // and both screens quietly show house ads instead — the exact failure the
  // registry's IMPLEMENTED set was added for. Assert it here rather than
  // discovering it on the glass.
  if (!isSceneImplemented("venue-logo")) {
    console.error(
      `\n✗ REFUSING TO RUN — this deploy does not implement the "venue-logo" scene.\n` +
        `  Both screens would fall through to house ads. Land the scene first.\n`,
    );
    process.exit(1);
  }

  console.log(`\n── plan ──`);
  console.log(`  role "${ROLE}" · mark "${MARK}" (${LOGO_MARKS[MARK].label}) · black background`);
  console.log(
    `  playlist: ${(preset.config.playlist ?? []).map((p) => `${p.scene}×${p.slots ?? 1}`).join(" · ")}`,
  );
  console.log(`  each screen is on its OWN player PC — single-screen launcher, no pairing group`);
  for (const p of PLAN) {
    console.log(
      `  ${VENUE}:${String(p.screenNumber).padEnd(2)}  ${p.name.padEnd(16)} launcher ${startupScriptFileName(`${VENUE}:${p.screenNumber}`)}`,
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
        // The preset carries the playlist, the mark, and every interrupt turned
        // off. Nothing is added per screen: these two are identical by design,
        // and the only thing distinguishing them is the name.
        ...preset.config,
        venueLogo: { mark: MARK },
      },
    });
    console.log(`  ✓ ${VENUE}:${p.screenNumber} — ${p.name}`);
  }

  /* ── verify ─────────────────────────────────────────────────────────── */

  const after = await listSignageScreens();
  const ours = after
    .filter((s) => wanted.has(s.screenId))
    .sort((a, b) => a.screenNumber - b.screenNumber);

  console.log(`\n── verify ──`);
  let ok = true;
  const fail = (msg: string) => {
    ok = false;
    console.log(`  ✗ ${msg}`);
  };
  const pass = (msg: string) => console.log(`  ✓ ${msg}`);

  // 1. both rows exist
  if (ours.length === PLAN.length) pass(`${PLAN.length} screens provisioned`);
  else fail(`expected ${PLAN.length} screens, found ${ours.length}`);

  // 2. the names carry left/right, because nothing else does
  const names = ours.map((s) => s.name);
  if (names[0] === "Old Time Left" && names[1] === "Old Time Right") {
    pass(`names carry the sides: ${names.join(" | ")}`);
  } else {
    fail(
      `names are [${names.join(", ")}] — with no pairing group these are the only record of which screen is which`,
    );
  }

  // 3. ONE scene, and it is the logo. A second entry would mean something rotates
  //    in beside the mark, which is the whole thing this screen is not.
  for (const s of ours) {
    const scenes = (s.config.playlist ?? []).map((p) => p.scene);
    if (scenes.length === 1 && scenes[0] === "venue-logo")
      pass(`${s.screenId} shows venue-logo only`);
    else fail(`${s.screenId} playlist is [${scenes.join(", ")}] — expected venue-logo alone`);
  }

  // 4. the mark RESOLVES to the one we meant. Guards the gap between "a string is
  //    stored" and "that string names artwork this deploy holds" — a typo here
  //    would silently fall back to the default rather than fail, so assert the
  //    stored value round-trips instead of trusting the write.
  for (const s of ours) {
    const stored = s.config.venueLogo?.mark;
    if (stored === MARK && resolveLogoMark(stored) === MARK) {
      pass(`${s.screenId} mark "${stored}" → ${LOGO_MARKS[MARK].src}`);
    } else {
      fail(
        `${s.screenId} mark is ${JSON.stringify(stored)} — resolves to "${resolveLogoMark(stored)}", expected "${MARK}"`,
      );
    }
  }

  // 5. NOTHING INTERRUPTS A HOLDING CARD. A celebration fired by a kiosk on the
  //    far side of the building, thrown across these screens, is confetti with no
  //    story behind it.
  for (const s of ours) {
    const i = s.config.interrupts ?? {};
    const on = Object.entries(i)
      .filter(([, v]) => (v as { enabled?: boolean } | undefined)?.enabled === true)
      .map(([k]) => k);
    if (on.length === 0) pass(`${s.screenId} has no interrupts enabled`);
    else fail(`${s.screenId} would be interrupted by [${on.join(", ")}]`);
  }

  // 6. NEITHER IS PAIRED — each is on its own computer, so the two-monitor
  //    launcher must not be offered for either. This is the assert that would
  //    catch someone "helpfully" grouping them later.
  for (const s of ours) {
    if (!s.config.pairing && !resolvePair(after, s.screenId)) {
      pass(`${s.screenId} unpaired — single-screen launcher, its own PC`);
    } else {
      fail(
        `${s.screenId} is in a pairing group — it is on its own computer, so the dual launcher is the WRONG file for it`,
      );
    }
  }

  // 7. no data gates. There is nothing for one to be about — the mark is a
  //    committed asset — and a gated sole entry would resolve to an empty
  //    playlist, which falls back to house ads.
  for (const s of ours) {
    const gated = (s.config.playlist ?? []).filter((e) => e.requiresData);
    if (gated.length === 0) pass(`${s.screenId} has no data-gated entries`);
    else
      fail(
        `${s.screenId} gates [${gated.map((e) => e.scene).join(", ")}] — would fall back to ads`,
      );
  }

  console.log(`\n── open these before hanging anything ──`);
  for (const s of ours) console.log(`  /tv?screen=${s.screenId}   ${s.name}`);
  console.log(`\n── one launcher per PC, each set as the WINDOWS SHELL ──`);
  for (const s of ours) console.log(`  ${startupScriptFileName(s.screenId)}   → ${s.name}`);

  console.log(
    ok
      ? `\n  ✓ both screens provisioned and consistent\n`
      : `\n  ✗ provisioned but INCONSISTENT — fix the failures above before hanging\n`,
  );
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error("provision failed:", err);
  process.exit(1);
});
