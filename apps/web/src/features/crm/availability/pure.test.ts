import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The gate gap of 2026-09-13 15:11, closed by a cheap static check.
 *
 * This branch's production build died with "Module not found: Can't resolve
 * 'dns' / 'fs' / 'net' / 'tls'" because `AvailabilityScreen.tsx` imported the
 * sub BARREL, which re-exports `readLaneGrid` → `@/lib/redis` → ioredis. `tsc`,
 * vitest, eslint and the a11y gate all pass straight through that class of
 * error; only `next build` traces the client graph, and the light gate does not
 * run one (brief §5.7b).
 *
 * So the rule is pinned here instead of being left to a build that runs once at
 * release: nothing under `components/features/crm/availability/` may import a
 * sub barrel, and `pure.ts` — the module they import in its place — may not
 * reach a transport, Redis, Neon or a node built-in, however indirectly.
 */

const SUB_DIR = __dirname;
const COMPONENT_DIR = path.join(SUB_DIR, "../../../components/features/crm/availability");

/** Modules that pull Node built-ins into whatever imports them. */
const SERVER_ONLY = [
  "@/lib/redis",
  "@ft/db",
  "server-only",
  "node:",
  "daily-events/data/bmi-office",
  "lane-plan/grid.server",
  "@/lib/qamf-bowling",
];

function sourcesIn(dir: string): { file: string; text: string }[] {
  return readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
    .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), "utf8") }));
}

/**
 * Every module specifier this file imports AS A VALUE.
 *
 * `import type` / `export type` are erased by the compiler and create no bundle
 * edge — `contracts.ts` names `./service/heats` for its `HeatBlock` type and
 * that is fine, it is the VALUE edges that drag ioredis into the browser.
 */
function importsOf(text: string): string[] {
  const values = text.replace(/(?:import|export)\s+type\s[\s\S]*?from\s+"[^"]+";/g, "");
  return [...values.matchAll(/from\s+"([^"]+)"|import\("([^"]+)"\)/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
}

/** Every module `pure.ts` reaches, following relative edges inside this sub. */
function pureGraph(): { file: string; text: string }[] {
  const seen = new Map<string, string>();
  const queue = ["pure.ts"];
  while (queue.length) {
    const rel = queue.shift() as string;
    if (seen.has(rel)) continue;
    const abs = path.join(SUB_DIR, rel);
    const text = readFileSync(abs, "utf8");
    seen.set(rel, text);
    for (const spec of importsOf(text)) {
      if (!spec.startsWith(".")) continue;
      const resolved = path.relative(SUB_DIR, path.resolve(path.dirname(abs), spec));
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        try {
          readFileSync(path.join(SUB_DIR, resolved + ext), "utf8");
          queue.push((resolved + ext).split(path.sep).join("/"));
          break;
        } catch {
          // try the next extension
        }
      }
    }
  }
  return [...seen].map(([file, text]) => ({ file, text }));
}

describe("pure.ts is safe to import from a client component", () => {
  it("reaches nothing that needs a Node built-in", () => {
    const offenders: string[] = [];
    for (const { file, text } of pureGraph()) {
      for (const spec of importsOf(text)) {
        if (SERVER_ONLY.some((bad) => spec.includes(bad))) offenders.push(`${file} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not re-export the sub barrel (which is where the server lives)", () => {
    const text = readFileSync(path.join(SUB_DIR, "pure.ts"), "utf8");
    expect(importsOf(text)).toEqual(["./service/engine", "./service/request"]);
  });
});

describe("the availability screen never imports a sub barrel", () => {
  it("imports pure modules by path only", () => {
    const offenders: string[] = [];
    for (const { file, text } of sourcesIn(COMPONENT_DIR)) {
      for (const spec of importsOf(text)) {
        // `~/features/crm/<sub>` with nothing after it IS the barrel.
        if (/^~\/features\/crm\/[a-z-]+$/.test(spec)) offenders.push(`${file} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
