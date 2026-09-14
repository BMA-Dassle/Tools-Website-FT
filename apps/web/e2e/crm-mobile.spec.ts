import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * THE PHONE AUDIT — every CRM screen, measured at two real handset widths.
 *
 * Owner, 2026-09-14: "please go through and check mobile formatting alot of it
 * sucks." Reps work from phones; this is the screen the CRM is actually used
 * on, and until now the only width with a layout proof was the builder's.
 *
 * ── WHY THIS EXISTS AS A MEASURING RIG, NOT A PASS/FAIL GATE ────────────────
 *
 * A CSS fix reasoned from the cascade and never rendered is how the board's
 * horizontal scrollbar got WORSE instead of better (tasks/lessons.md — "a rig
 * that never reproduced cannot verify"). So this run's job is to REPRODUCE
 * first: it walks every screen, measures four things a phone user actually
 * suffers, and writes the numbers to a JSON report. The fixes are then made
 * against that report and the run repeated, so every claim has a before and an
 * after.
 *
 * What it measures, per screen per width:
 *   overflow    the document scrolling sideways — the single worst phone bug,
 *               because it makes vertical scrolling feel broken too.
 *   wide        the specific elements whose right edge is past the viewport.
 *               `overflow` tells you it is broken; this tells you what to fix.
 *   taps        interactive targets under 40px. Apple asks 44, Material 48;
 *               40 is the floor below which a thumb misses.
 *   clipped     text cut off by its container with no ellipsis to say so — a
 *               guest name reading "Strikes for Scho" and nothing to reveal it.
 *
 * Deliberately NOT asserted as hard failures on the first pass: a screen with
 * an empty database legitimately has fewer targets than a full one, and this
 * tenant's data is what it is. The report is read by a human. The ONE hard
 * assertion is document overflow, which is never correct at any width.
 *
 * Run:
 *   E2E_ADMIN_SSO=1 npx playwright test -c apps/web/playwright.config.ts \
 *     e2e/crm-mobile.spec.ts
 *
 * Report lands at test-results/crm-mobile/report.json, shots beside it (both
 * gitignored; never commit a PNG).
 */

const enabled = process.env.E2E_ADMIN_SSO === "1";
test.skip(!enabled, "set E2E_ADMIN_SSO=1 to run the CRM mobile audit");

const OUT = path.resolve(__dirname, "../test-results/crm-mobile");

/** iPhone 13/14/15 logical width, and the small-Android floor. */
const WIDTHS = [
  { w: 390, h: 844, name: "iphone" },
  { w: 360, h: 740, name: "android-small" },
] as const;

/**
 * Every screen in `core/nav.ts`, plus the two that are only reachable from a
 * row (`deal`, `account`) and so would otherwise never be measured. `builder`
 * has its own suite and is skipped here.
 */
const SCREENS = [
  "",
  "pipeline",
  "queue",
  "contracts",
  "events",
  "availability",
  "conversations",
  "calls",
  "history",
  "cold",
  "collateral",
  "accountability",
  "kpi",
  "goals",
  "rules",
  "statuses",
  "more",
] as const;

interface WideEl {
  sel: string;
  right: number;
  width: number;
  /** The nearest ancestor that can scroll it into view, or null if there is none. */
  scroller: string | null;
}
interface TapEl {
  sel: string;
  w: number;
  h: number;
  text: string;
}
interface ClipEl {
  sel: string;
  scrollW: number;
  clientW: number;
  text: string;
}
interface ScreenReport {
  screen: string;
  width: number;
  docScrollW: number;
  docClientW: number;
  overflow: number;
  /** Elements past the right edge that NOTHING can scroll into view. */
  stranded: WideEl[];
  wide: WideEl[];
  taps: TapEl[];
  clipped: ClipEl[];
  errors: string[];
}

async function beMicrosoftUser(context: BrowserContext, fixture: string) {
  await context.addCookies([
    { name: "mock_entra_session", value: fixture, domain: "localhost", path: "/" },
  ]);
}

/**
 * The measuring pass, run INSIDE the page.
 *
 * A short CSS path per element rather than an index, so a finding names
 * something greppable ("div.board-col > header.col-head") instead of "the 41st
 * div". Elements are de-duplicated by that path: one broken rule repeated
 * across 30 cards is ONE fix, and 30 identical rows would bury the other
 * findings.
 */
async function measure(page: Page, screen: string, width: number): Promise<ScreenReport> {
  return page.evaluate(
    ({ screen, width }) => {
      const sel = (el: Element): string => {
        const bits: string[] = [];
        let node: Element | null = el;
        for (let i = 0; node && i < 3; i++) {
          const cls = (node.getAttribute("class") || "")
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .join(".");
          bits.unshift(node.tagName.toLowerCase() + (cls ? "." + cls : ""));
          node = node.parentElement;
        }
        return bits.join(" > ");
      };

      /**
       * The nearest ancestor that can actually scroll this element into view.
       *
       * THE DISTINCTION THAT MATTERS. A table inside `overflow-x: auto` reports
       * a rect far past the viewport and is perfectly fine — a thumb drags it.
       * The same rect with no scrollable ancestor is content nobody can reach,
       * and since `html`/`body` are `overflow: hidden` under the shell, the
       * document will not scroll to rescue it. Only the second kind is a bug,
       * and the first kind was burying it: 25 board columns and every table row
       * landed in the same list as the real findings.
       */
      const scrollerFor = (el: Element): string | null => {
        let node = el.parentElement;
        while (node && !node.classList.contains("crm-root")) {
          const ox = getComputedStyle(node).overflowX;
          if ((ox === "auto" || ox === "scroll") && node.scrollWidth > node.clientWidth + 1) {
            return sel(node);
          }
          node = node.parentElement;
        }
        return null;
      };

      const doc = document.documentElement;
      const stranded: WideEl[] = [];
      const wide: WideEl[] = [];
      const taps: TapEl[] = [];
      const clipped: ClipEl[] = [];
      const seenWide = new Set<string>();
      const seenTap = new Set<string>();
      const seenClip = new Set<string>();

      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") continue;

        // ── past the right edge ──────────────────────────────────────────────
        // 1px of tolerance for sub-pixel rounding; anything genuinely broken is
        // out by tens of pixels. `position: fixed` off-canvas panels (a closed
        // drawer) are parked deliberately and are not a finding.
        if (r.right > width + 1 && cs.position !== "fixed") {
          const k = sel(el);
          if (!seenWide.has(k)) {
            seenWide.add(k);
            const scroller = scrollerFor(el);
            const row = {
              sel: k,
              right: Math.round(r.right),
              width: Math.round(r.width),
              scroller,
            };
            wide.push(row);
            // Nothing can bring it back: this is the finding.
            if (!scroller) stranded.push(row);
          }
        }

        // ── thumb-sized? ─────────────────────────────────────────────────────
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        const interactive =
          tag === "button" ||
          tag === "a" ||
          tag === "select" ||
          tag === "input" ||
          role === "button" ||
          role === "tab";
        if (interactive && r.width > 0 && r.height > 0 && (r.width < 40 || r.height < 40)) {
          // A link inside a sentence is not a tap target in the thumb sense.
          const inProse = el.closest("p, .prose, .help, .hint") !== null;
          if (!inProse) {
            const k = sel(el);
            if (!seenTap.has(k)) {
              seenTap.add(k);
              taps.push({
                sel: k,
                w: Math.round(r.width),
                h: Math.round(r.height),
                text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40),
              });
            }
          }
        }

        // ── text cut off with nothing to say so ──────────────────────────────
        // Only when the container HIDES the overflow and is not an ellipsis and
        // is not a scroller — a scrollable strip is cut off on purpose.
        const hidesX = cs.overflowX === "hidden" || cs.overflowX === "clip";
        const ellipsis = cs.textOverflow === "ellipsis";
        // `.sr-only` is a 1px clipped box ON PURPOSE — that is the technique.
        const srOnly = el.classList.contains("sr-only");
        if (
          !srOnly &&
          hidesX &&
          !ellipsis &&
          el.scrollWidth > el.clientWidth + 2 &&
          el.clientWidth > 0
        ) {
          const k = sel(el);
          if (!seenClip.has(k)) {
            seenClip.add(k);
            clipped.push({
              sel: k,
              scrollW: el.scrollWidth,
              clientW: el.clientWidth,
              text: (el.textContent || "").trim().slice(0, 40),
            });
          }
        }
      }

      return {
        screen,
        width,
        docScrollW: doc.scrollWidth,
        docClientW: doc.clientWidth,
        overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
        stranded: stranded.slice(0, 25),
        wide: wide.slice(0, 25),
        taps: taps.slice(0, 25),
        clipped: clipped.slice(0, 25),
        errors: [],
      };
    },
    { screen, width },
  );
}

test.describe("CRM on a phone", () => {
  test("every screen, measured at 390 and 360", async ({ page, context }) => {
    test.setTimeout(600_000);
    mkdirSync(OUT, { recursive: true });
    await beMicrosoftUser(context, "eric");

    const report: ScreenReport[] = [];
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e.message ?? e)));
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
    });

    // Sign in once at desktop size, so the OIDC round trip is not measured.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/admin/crm");
    await page.waitForLoadState("networkidle");

    for (const { w, h, name } of WIDTHS) {
      await page.setViewportSize({ width: w, height: h });
      for (const screen of SCREENS) {
        consoleErrors.length = 0;
        const url = screen ? `/admin/crm/${screen}` : "/admin/crm";
        await page.goto(url);
        // The shell paints, then React Query fills it. Both matter to layout.
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(900);

        const r = await measure(page, screen || "today", w);
        r.errors = [...new Set(consoleErrors)].slice(0, 5);
        report.push(r);

        await page
          .screenshot({
            path: path.join(OUT, `${name}-${screen || "today"}.png`),
            fullPage: true,
          })
          .catch(() => {});
      }
    }

    writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

    // ── the summary a human reads ────────────────────────────────────────────
    const bad = report.filter((r) => r.stranded.length > 0);
    for (const r of report) {
      const bits = [
        `${String(r.width)}px ${r.screen.padEnd(15)}`,
        r.stranded.length ? `STRANDED ${String(r.stranded.length).padStart(2)}` : "ok         ",
        `over ${String(r.overflow).padStart(4)}`,
        `inScroller ${String(r.wide.length - r.stranded.length).padStart(2)}`,
        `taps ${String(r.taps.length).padStart(2)}`,
        `clip ${String(r.clipped.length).padStart(2)}`,
      ];
      console.log(bits.join("  "));
    }
    for (const r of bad) {
      console.log(`\n── ${r.screen} @ ${r.width}px — ${r.stranded.length} unreachable`);
      for (const el of r.stranded.slice(0, 8)) {
        console.log(`     ${el.sel}  right=${el.right}  w=${el.width}`);
      }
    }

    // THE HARD RULE. Not "the document is wide" — under this shell `html` and
    // `body` are `overflow: hidden`, so a wide document does not scroll, it
    // CLIPS. What must never happen is content past the right edge that no
    // scroller can bring back: on a phone that content simply does not exist.
    expect(
      bad.map((r) => `${r.screen}@${r.width}:${r.stranded.length}`),
      "content stranded past the right edge with nothing to scroll it back",
    ).toEqual([]);
  });
});
