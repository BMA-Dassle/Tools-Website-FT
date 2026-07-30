/**
 * Contract test for the mobile /waiver theme.
 *
 * The mobile flow reuses the KIOSK party components, which are authored in
 * absolute px for the fixed 1080×1920 kiosk canvas. `waiver-party.css` re-
 * proportions those px utilities under `.wp-mobile`. That mapping is a
 * whitelist, so it silently rots: the day a kiosk component gains a
 * `text-[52px]` or a `w-[500px]`, the phone renders it at full kiosk size and
 * nobody notices until a guest opens the page.
 *
 * These tests make the whitelist a maintained contract instead. When one goes
 * red, ADD THE MAPPING to waiver-party.css — don't relax the assertion.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../../.."); // apps/web

const css = readFileSync(path.join(here, "waiver-party.css"), "utf8");

/**
 * Kiosk components rendered by the mobile /waiver flow (WaiverFlow mounts
 * KioskPartyManager with theme="mobile"; the party manager renders the sign-in
 * boxes and the license-match picker). Photo capture is MobileWaiverPhoto, not
 * KioskWaiverPhoto, so the kiosk photo screen is deliberately absent.
 */
const REACHABLE = [
  "src/features/kiosk/components/KioskPartyManager.tsx",
  "src/features/kiosk/components/KioskSignInBoxes.tsx",
  "src/features/kiosk/components/LicenseMatchPicker.tsx",
];

/** Utility prefixes whose px values affect visible size/spacing on a phone. */
const SIZE_PREFIXES = [
  "text",
  "p",
  "px",
  "py",
  "pt",
  "pb",
  "gap",
  "gap-x",
  "gap-y",
  "space-y",
  "space-x",
  "h",
  "w",
  "min-h",
  "min-w",
  "max-w",
  "rounded",
  "mt",
  "mb",
  "ml",
  "mr",
  "leading",
  "tracking",
];

const sources = REACHABLE.map((rel) => readFileSync(path.join(webRoot, rel), "utf8"));

/** Every `<prefix>-[Npx]` utility appearing in the reachable components. */
function usedPxUtilities(): Set<string> {
  const found = new Set<string>();
  const re = new RegExp(`\\b(${SIZE_PREFIXES.join("|")})-\\[(\\d+)px\\]`, "g");
  for (const src of sources) {
    for (const m of src.matchAll(re)) found.add(`${m[1]}-[${m[2]}px]`);
  }
  return found;
}

/** Every `<prefix>-[Npx]` utility remapped under `.wp-mobile` in the CSS. */
function coveredPxUtilities(): Set<string> {
  const covered = new Set<string>();
  // The trailing `-` is matched explicitly: a greedy [a-z-]+ would swallow it
  // and yield "text-" as the prefix (→ "text--[40px]", matching nothing).
  const re = /\.wp-mobile\s+\.([a-z-]+)-\\\[(\d+)px\\\]/g;
  for (const m of css.matchAll(re)) covered.add(`${m[1]}-[${m[2]}px]`);
  return covered;
}

/**
 * The declaration body of the `.wp-mobile .<utility>` rule. The CSS escapes the
 * brackets (`.w-\[400px\]`), so the literal we match for is `\[` — one
 * backslash, then the bracket.
 */
function declarationsFor(utility: string): string {
  const m = /^([a-z-]+)-\[(\d+)px\]$/.exec(utility);
  if (!m) return "";
  const selector = `\\.wp-mobile\\s+\\.${m[1]}-\\\\\\[${m[2]}px\\\\\\]`;
  return new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

describe("mobile /waiver theme covers the kiosk px utilities it reuses", () => {
  it("remaps every px utility used by a reachable kiosk component", () => {
    const used = usedPxUtilities();
    const covered = coveredPxUtilities();
    const missing = [...used].filter((u) => !covered.has(u)).sort();
    expect(
      missing,
      `These kiosk px utilities render at FULL KIOSK SIZE on a phone. Add a ` +
        `.wp-mobile rule for each in waiver-party.css:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("clamps anything wider than a small phone to the viewport", () => {
    // A 390px-wide phone is the design floor. Any absolute width at or above
    // 360px must resolve to a viewport-relative value, or the page scrolls
    // sideways — the one layout bug a guest cannot work around.
    const wide = [...usedPxUtilities()].filter((u) => {
      const m = /^(w|min-w)-\[(\d+)px\]$/.exec(u);
      return m && Number(m[2]) >= 360;
    });
    for (const u of wide) {
      const body = declarationsFor(u);
      expect(body, `${u} must clamp to the viewport (min()/vw/%), got: ${body.trim()}`).toMatch(
        /min\(|vw|%/,
      );
    }
  });

  it("defines a mobile look for every kiosk design-system class it renders", () => {
    // Source the class list from kiosk.css itself, so a new kiosk primitive
    // adopted by a shared component can't ship unstyled on the phone.
    const kioskCss = readFileSync(path.join(webRoot, "app/kiosk/kiosk.css"), "utf8");
    const kioskClasses = new Set([...kioskCss.matchAll(/\.(k-[a-z0-9-]+)\b/g)].map((m) => m[1]));

    const usedKiosk = [...kioskClasses].filter((cls) =>
      sources.some((src) => new RegExp(`["'\\s]${cls}[\\s"'\`]`).test(src)),
    );
    const definedMobile = new Set(
      [...css.matchAll(/\.wp-mobile\s+\.(k-[a-z0-9-]+)/g)].map((m) => m[1]),
    );
    const missing = usedKiosk.filter((cls) => !definedMobile.has(cls)).sort();
    expect(
      missing,
      `Kiosk classes rendered by the mobile flow with NO .wp-mobile rule ` +
        `(they inherit nothing outside .kiosk-canvas):\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps every input's remapped font-size at 16px+ so iOS does not zoom", () => {
    // iOS Safari zooms the page when a focused input computes under 16px and
    // never zooms back out — the guest finishes the form at 1.4x, panning.
    // A CSS floor can't express "the remapped value, but never under 16px"
    // (see the note in waiver-party.css), so the invariant is checked here
    // against the value the phone will actually compute.
    const sizeClassesOnInputs = new Set<string>();
    for (const src of sources) {
      // Walk each input/select/textarea tag and pull its text-[Npx] class.
      for (const tag of src.matchAll(/<(?:input|select|textarea)\b[\s\S]{0,900}?\/>/g)) {
        for (const m of tag[0].matchAll(/\btext-\[(\d+)px\]/g)) {
          sizeClassesOnInputs.add(`text-[${m[1]}px]`);
        }
      }
    }
    expect(
      sizeClassesOnInputs.size,
      "found no sized inputs — the extraction regex probably stopped matching",
    ).toBeGreaterThan(0);

    for (const cls of sizeClassesOnInputs) {
      const body = declarationsFor(cls);
      const rem = /font-size:\s*([\d.]+)rem/.exec(body);
      const px = /font-size:\s*([\d.]+)px/.exec(body);
      const computed = rem ? Number(rem[1]) * 16 : px ? Number(px[1]) : NaN;
      expect(
        computed,
        `${cls} is used on an input and maps to ${body.trim() || "NOTHING"} ` +
          `(= ${computed}px). Under 16px iOS Safari will zoom on focus.`,
      ).toBeGreaterThanOrEqual(16);
    }
  });
});
