import path from "node:path";
import { test, type BrowserContext } from "@playwright/test";

/**
 * A ONE-OFF DIAGNOSTIC, not a gate.
 *
 * The audit says Contracts and Statuses make the document 235px wider than the
 * phone, yet every element past the edge has SOMETHING that can scroll it back.
 * Which something matters enormously: if it is the table's own `.scroll-x`,
 * the screen is fine and a thumb drags the table. If it is `.content` — the
 * whole page body — then dragging slides the entire screen sideways under a
 * fixed topbar, which is the kind of thing that reads as "the layout is
 * broken" even though nothing is technically unreachable.
 *
 * So this walks the actual box tree and prints, for the offending table, every
 * ancestor's overflow and scroll geometry. It answers the question by
 * measurement instead of by reading the cascade and guessing.
 */

const enabled = process.env.E2E_ADMIN_SSO === "1";
test.skip(!enabled, "set E2E_ADMIN_SSO=1");

async function beMicrosoftUser(context: BrowserContext, fixture: string) {
  await context.addCookies([
    { name: "mock_entra_session", value: fixture, domain: "localhost", path: "/" },
  ]);
}

test("who actually scrolls the wide table", async ({ page, context }) => {
  test.setTimeout(300_000);
  await beMicrosoftUser(context, "eric");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/admin/crm");
  await page.waitForLoadState("networkidle");

  for (const screen of ["contracts", "statuses", "events"]) {
    for (const w of [390, 360]) {
      await page.setViewportSize({ width: w, height: 844 });
      await page.goto(`/admin/crm/${screen}`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(900);

      const out = await page.evaluate(
        ({ w }) => {
          const lines: string[] = [];
          const doc = document.documentElement;
          lines.push(
            `doc scrollW=${doc.scrollWidth} clientW=${doc.clientWidth} bodyScrollW=${document.body.scrollWidth}`,
          );

          const name = (el: Element) => {
            const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).join(".");
            return el.tagName.toLowerCase() + (cls ? "." + cls : "");
          };

          // The widest element on the page that is not fixed — the thing to explain.
          let worst: Element | null = null;
          let worstRight = w;
          for (const el of Array.from(document.body.querySelectorAll("*"))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            if (getComputedStyle(el).position === "fixed") continue;
            if (r.right > worstRight) {
              worstRight = r.right;
              worst = el;
            }
          }
          if (!worst) {
            lines.push("nothing past the edge");
            return lines.join("\n");
          }

          lines.push(`widest: ${name(worst)} right=${Math.round(worstRight)}`);
          lines.push("ancestor chain (nearest first):");
          let node: Element | null = worst;
          while (node) {
            const cs = getComputedStyle(node);
            const r = node.getBoundingClientRect();
            const scrolls = node.scrollWidth > node.clientWidth + 1;
            lines.push(
              `   ${name(node).slice(0, 52).padEnd(54)} ` +
                `w=${String(Math.round(r.width)).padStart(4)} ` +
                `sw=${String(node.scrollWidth).padStart(4)} ` +
                `cw=${String(node.clientWidth).padStart(4)} ` +
                `ox=${cs.overflowX.padEnd(7)} ` +
                `${scrolls ? "← CAN SCROLL" : ""}`,
            );
            node = node.parentElement;
          }
          return lines.join("\n");
        },
        { w },
      );
      console.log(`\n===== ${screen} @ ${w}px =====\n${out}`);
    }
  }
  // Keep the artefact path stable for the notes.
  void path;
});
