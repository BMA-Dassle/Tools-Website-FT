#!/usr/bin/env node
/**
 * A11y gate — runs eslint filtering to only jsx-a11y rules, fails the
 * build if ANY jsx-a11y violation is introduced.
 *
 * Why a custom script rather than `eslint --max-warnings=0`:
 *   - Codebase has ~49 pre-existing react-hooks / @next/next errors that
 *     would block the build. Those are out of scope for this a11y pass;
 *     they'll be fixed in separate PRs.
 *   - We need to gate ONLY on jsx-a11y so this check is additive without
 *     regressing the existing CI/build behaviour.
 *
 * How it works:
 *   1. Run `eslint --format=json` across the whole source tree
 *   2. Parse JSON output, filter messages to those starting with "jsx-a11y/"
 *   3. If any found, print them + exit 1; else exit 0
 *
 * Wired to `postbuild` in package.json, so `npm run build` automatically
 * enforces a11y cleanliness. Run manually with `npm run lint:a11y`.
 */

import { spawnSync } from "node:child_process";

const ESLINT_ARGS = ["eslint", "--format=json", "."];

const proc = spawnSync("npx", ESLINT_ARGS, {
  cwd: process.cwd(),
  encoding: "utf8",
  shell: process.platform === "win32",
  // ESLint JSON report for this project runs 2–5 MB; the default 1 MB
  // buffer overflows with ENOBUFS. Size up generously.
  maxBuffer: 200 * 1024 * 1024,
});

if (proc.error) {
  console.error("[a11y-gate] failed to run eslint:", proc.error.message);
  process.exit(2);
}

// eslint exits non-zero when there are any errors — we parse regardless.
let report;
try {
  // Strip any noisy stderr before JSON (rare but some configs print warnings).
  const jsonStart = proc.stdout.indexOf("[");
  const json = jsonStart >= 0 ? proc.stdout.slice(jsonStart) : proc.stdout;
  report = JSON.parse(json);
} catch (err) {
  console.error("[a11y-gate] could not parse eslint output:", err.message);
  console.error("STDOUT:", proc.stdout.slice(0, 500));
  console.error("STDERR:", proc.stderr.slice(0, 500));
  process.exit(2);
}

const violations = [];
for (const file of report) {
  for (const msg of file.messages || []) {
    if (msg.ruleId && msg.ruleId.startsWith("jsx-a11y/")) {
      violations.push({
        filePath: file.filePath,
        line: msg.line,
        column: msg.column,
        rule: msg.ruleId,
        message: msg.message,
      });
    }
  }
}

if (violations.length === 0) {
  console.log("[a11y-gate] ✓ zero jsx-a11y violations");
  process.exit(0);
}

console.error(`[a11y-gate] ✗ ${violations.length} jsx-a11y violation(s):\n`);
for (const v of violations) {
  const rel = v.filePath.replace(process.cwd(), "").replace(/\\/g, "/");
  console.error(`  ${rel}:${v.line}:${v.column}  ${v.rule}`);
  console.error(`    ${v.message}`);
}
console.error(`\n[a11y-gate] Fix the above before merging.`);
console.error(`[a11y-gate] See fasttrax-web/lib/a11y.ts for modalBackdropProps + clickableDivProps helpers.`);
process.exit(1);
