/**
 * Live smoke for `setProjectState` through the REAL app code path (not a replica).
 *
 * Reads a project's current stateId and asks setProjectState to set that SAME
 * value. Semantic no-op — no state change, no cron re-arm, no guest email — but
 * it drives the whole rail: Office GET → toMinimalProject → putProject (including
 * the confirm:true retry when the record is over capacity) → read-back verify.
 *
 * On an overbooked project this is the end-to-end proof that a group function can
 * now leave "Send Contract": before the fix the PUT 403'd and threw.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/office-setstate-noop-smoke.mts 58454076 [centerCode=fort-myers]
 */
import { readFileSync } from "node:fs";

for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {
    /* next */
  }
}

const PROJECT_ID = process.argv[2];
const CENTER = process.argv[3] || "fort-myers";
if (!PROJECT_ID || !/^\d+$/.test(PROJECT_ID)) {
  console.error("Usage: office-setstate-noop-smoke.mts <projectId> [centerCode]");
  process.exit(1);
}

const { fetchProject, setProjectState } = await import("@/lib/bmi-office-actions");

const before = await fetchProject(CENTER, PROJECT_ID);
if (!before) {
  console.error(`project ${PROJECT_ID} unreadable at ${CENTER}`);
  process.exit(1);
}
const state = String(before.stateId);
console.log(
  `project ${PROJECT_ID} "${before.name}" number=${before.number} ` +
    `stateId=${state} persons=${before.persons}\n` +
    `  writing back the SAME stateId=${state} …`,
);

const t0 = Date.now();
try {
  await setProjectState({
    centerCode: CENTER,
    projectId: PROJECT_ID,
    stateId: state,
    label: "no-op smoke",
  });
  console.log(`  ✅ setProjectState resolved in ${Date.now() - t0}ms`);
} catch (err) {
  console.log(`  ❌ setProjectState threw after ${Date.now() - t0}ms: ${err}`);
  process.exitCode = 1;
}

const after = await fetchProject(CENTER, PROJECT_ID);
const nowState = after ? String(after.stateId) : "unreadable";
console.log(`  verify stateId=${nowState} ${nowState === state ? "(unchanged ✓)" : "⚠ CHANGED"}`);
