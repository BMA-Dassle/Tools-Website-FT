/**
 * COMPLETENESS AUDIT for waiver entry points — a source scan, not a unit test.
 *
 * Stage 2 pointed every waiver surface at short capability codes. The risk with a
 * sweep like that is not the files you changed, it is the one you missed: a single
 * sender left on the old external BMI kiosk URL keeps mailing guests a link where
 * none of the first-party flow exists, and it fails SILENTLY — the link works, it
 * is just the wrong page, filed at the wrong location.
 *
 * So the invariants are asserted against the tree itself:
 *
 *   1. No source file builds an external kiosk waiver URL.
 *   2. No source file hand-writes a "/waiver?…" query string — buildWaiverUrl owns
 *      the URL contract and the mint owns the short form.
 *   3. The two functions once both named `buildWaiverUrl` cannot both exist again.
 *   4. `/w/` stays registered in middleware (the HeadPinz-404 rule).
 *
 * A grep test is unusual, and it is deliberate: green unit tests coexisted with a
 * broken sweep repeatedly on this branch, because a unit test only knows about the
 * call sites someone remembered to wire.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** apps/web — this file lives at apps/web/src/features/waiver/. */
const WEB_ROOT = join(__dirname, "..", "..", "..");
const SCAN_DIRS = ["app", "lib", "src", "components"];
const CODE_EXT = /\.(ts|tsx)$/;

/**
 * Files allowed to mention the legacy hosts INSIDE A STRING, and why.
 *
 * The patterns below deliberately require a quote before `https://kiosk.…` so that
 * PROSE — the "was kiosk.bmileisure.com/…" notes left behind on every migrated
 * surface, which are useful history — does not read as an offence. Comment
 * stripping was the obvious alternative and is the wrong tool: a naive `//…` strip
 * eats the `//` in every URL literal and would turn real offenders into passes.
 */
const LEGACY_HOST_ALLOWED = new Set([
  // Names the legacy hosts in order to REFUSE them.
  join("lib", "waiver-link-send.ts"),
  join("lib", "waiver-link-send.test.ts"),
  // This file.
  join("src", "features", "waiver", "waiver-entry-points.test.ts"),
]);

/** Files allowed to compose a raw `/waiver?` string: the builder and its tests. */
const RAW_URL_ALLOWED = new Set([
  join("src", "features", "waiver", "build-waiver-url.ts"),
  join("src", "features", "waiver", "build-waiver-url.test.ts"),
  join("src", "features", "waiver", "waiver-entry-points.test.ts"),
  join("lib", "waiver-link-send.ts"),
  join("lib", "waiver-link-send.test.ts"),
  join("lib", "waiver-short-link.ts"),
  join("lib", "waiver-short-link.test.ts"),
  // Documents the redirect target it serves; builds it via buildWaiverUrl.
  join("app", "w", "[code]", "route.ts"),
  // Client-side fetches of our own API, not guest-facing links.
  join("app", "api", "waiver", "context", "route.ts"),
]);

/**
 * Senders that legitimately mention `waiverUrl` without importing the send module,
 * because they PASS IT THROUGH to another internal route that resolves it. Keeping
 * the fallback in one place is the point — see race-day-emails.
 */
const PASS_THROUGH_SENDERS = new Set([join("app", "api", "cron", "race-day-emails", "route.ts")]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE_EXT.test(entry)) out.push(full);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(join(WEB_ROOT, d))).map((full) => ({
  rel: full.slice(WEB_ROOT.length + 1),
  text: readFileSync(full, "utf8"),
}));

describe("waiver entry-point completeness", () => {
  it("scanned a plausible number of files (the scan itself works)", () => {
    // Without this, a broken path silently turns every assertion below into a
    // vacuous pass — the failure mode of every grep-based test.
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES.some((f) => f.rel === join("lib", "waiver-link-send.ts"))).toBe(true);
    expect(FILES.some((f) => f.rel === join("components", "Nav.tsx"))).toBe(true);
  });

  it("no file builds an EXTERNAL kiosk waiver link", () => {
    // `kiosk.sms-timing.com/{clientKey}/subscribe` and
    // `kiosk.bmileisure.com/{clientKey}` were the pre-stage-2 waiver URLs. Nine
    // senders each built one by hand — and this assertion caught three more the
    // sweep had missed: the FastTrax nav (components/Nav.tsx), the legacy bowling
    // confirmation page, and a ready-made LEGACY_WAIVER_URLS export sitting in the
    // very module meant to replace them.
    const offenders = FILES.filter(
      (f) =>
        !LEGACY_HOST_ALLOWED.has(f.rel) &&
        // Quote-prefixed = a URL being CONSTRUCTED, not history being described.
        /["'`]https:\/\/kiosk\.(sms-timing|bmileisure)\.com/.test(f.text),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("no file hand-writes a /waiver query string", () => {
    // buildWaiverUrl owns the contract (both-or-neither on loc+pid, Naples never
    // folded into fort-myers, ids never through Number()). A hand-built string
    // bypasses all of it.
    const offenders = FILES.filter(
      (f) => !RAW_URL_ALLOWED.has(f.rel) && /["'`]\/waiver\?/.test(f.text),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the buildWaiverUrl NAME COLLISION cannot come back", () => {
    // lib/group-event-rules.ts used to export its own `buildWaiverUrl` — a
    // different function, same name, feeding a live cron. An import fixed in the
    // wrong file silently swapped one for the other.
    const declarers = FILES.filter((f) =>
      /export\s+(async\s+)?function\s+buildWaiverUrl\b/.test(f.text),
    ).map((f) => f.rel);
    expect(declarers).toEqual([join("src", "features", "waiver", "build-waiver-url.ts")]);
  });

  it("keeps /w/ registered as a shared top-level route", () => {
    // CLAUDE.md hard rule: an unregistered top-level path is rewritten into /hp/*
    // on the HeadPinz host, so every HeadPinz waiver link 404s. This already
    // happened once on this branch.
    const mw = readFileSync(join(WEB_ROOT, "middleware.ts"), "utf8");
    expect(mw).toContain('"/w/"');
  });

  it("every group sender that mentions waivers goes through the send module", () => {
    // A sender that still mentions a waiver URL but imports neither helper is
    // almost certainly building one itself.
    const senders = FILES.filter(
      (f) =>
        (f.rel.startsWith(join("app", "api", "cron")) ||
          f.rel.startsWith(join("app", "api", "notifications")) ||
          f.rel.startsWith(join("app", "api", "group-function"))) &&
        /\bwaiverUrl\b/.test(f.text),
    );
    const unwired = senders
      .filter(
        (f) =>
          !PASS_THROUGH_SENDERS.has(f.rel) &&
          !/waiver-link-send|waiverLinkForSuppliedUrl|waiverUrlForQuote/.test(f.text),
      )
      .map((f) => f.rel);
    expect(unwired).toEqual([]);
  });
});
