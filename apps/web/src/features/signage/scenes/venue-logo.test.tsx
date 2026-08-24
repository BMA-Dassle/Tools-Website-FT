import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { SceneVenueLogo } from "./SceneVenueLogo";
import { resolveScreenConfig } from "../defaults";
import { logoAsset } from "../logo";
import { TV_H, TV_W } from "../constants";
import type { SceneProps } from "../director/types";

/**
 * The holding card over the Old Time Lanes. One mark, black behind it, nothing
 * else — so the things worth locking down are exactly: that the ground really is
 * black, that the mark is the one the config names, and that its aspect ratio
 * survives being scaled to the canvas.
 *
 * Rendered by calling the component and walking the element tree rather than
 * through react-dom, matching checkin-feed.test.tsx: a root-hoisted react 18 from
 * another workspace shadows apps/web's react 19 in this repo's install layout,
 * and react-dom/server refuses a mismatched pair.
 */

interface Node {
  type?: unknown;
  props?: Record<string, unknown> & { children?: ReactNode };
}

/** Every element in the tree, depth-first. */
function walk(node: ReactNode): Node[] {
  if (
    node == null ||
    typeof node === "boolean" ||
    typeof node === "string" ||
    typeof node === "number"
  ) {
    return [];
  }
  if (Array.isArray(node)) return node.flatMap(walk);
  const el = node as Node;
  return [el, ...walk(el.props?.children as ReactNode)];
}

function render(mark?: string) {
  const props = {
    feed: null,
    nowMs: 1_755_600_000_000,
    offset: 0,
    venue: "HPFM",
    config: resolveScreenConfig(mark === undefined ? {} : { venueLogo: { mark } }, "HPFM"),
    decision: { scene: "venue-logo" },
    demo: "off",
  } as unknown as SceneProps;
  return walk(SceneVenueLogo(props));
}

/** The one <Image>. Identified by carrying a `src`, so this does not depend on
 *  next/image's internal component identity. */
function image(tree: Node[]): Record<string, unknown> {
  const found = tree.filter((n) => typeof n.props?.src === "string");
  expect(found, "expected exactly one image in the scene").toHaveLength(1);
  return found[0].props as Record<string, unknown>;
}

describe("SceneVenueLogo", () => {
  it("paints a TRUE BLACK full-bleed ground", () => {
    // The owner asked for black, and the mark only reads because of the contrast.
    // Not `sleep`'s near-black #000418 — that one is deliberately dim because it
    // is pretending to be off overnight; this is a lit sign during trading hours.
    const root = render()[0];
    const style = root.props?.style as Record<string, unknown>;
    expect(style.background).toBe("#000");
    expect(style.position).toBe("absolute");
    expect(style.inset).toBe(0);
  });

  it("shows the mark the config names", () => {
    expect(image(render("pinboyz")).src).toBe(logoAsset("pinboyz").src);
  });

  it("falls back to a real mark rather than a broken image", () => {
    // A screen whose ONLY content is one image must never come up blank over a
    // typo in a text field or a mark written by a newer deploy.
    for (const bad of ["", "pinboys", "a-mark-from-2027"]) {
      const src = image(render(bad)).src as string;
      expect(src, `mark ${JSON.stringify(bad)}`).toBeTruthy();
      expect(src).toBe(logoAsset("pinboyz").src);
    }
    // And with no venueLogo block at all.
    expect(image(render()).src).toBe(logoAsset("pinboyz").src);
  });

  it("keeps the artwork's aspect ratio, so the mark is never stretched", () => {
    const img = image(render("pinboyz"));
    const asset = logoAsset("pinboyz");
    const w = img.width as number;
    const h = img.height as number;
    // Within a pixel of the source ratio — both dimensions are rounded.
    expect(Math.abs(w / h - asset.width / asset.height)).toBeLessThan(0.01);
  });

  it("draws the mark large, and inside the canvas on both axes", () => {
    const img = image(render("pinboyz"));
    const w = img.width as number;
    const h = img.height as number;
    // Big enough to be the subject of the screen...
    expect(h).toBeGreaterThan(TV_H * 0.5);
    // ...and comfortably within it, so nothing is clipped on a panel that is
    // already cropping its own edges (see ScreenConfig.overscanPct).
    expect(h).toBeLessThan(TV_H * 0.8);
    expect(w).toBeLessThan(TV_W * 0.8);
  });

  it("does not upscale beyond the source, which is all the detail there is", () => {
    // 576x636 is the ceiling — the artwork is a 2015 scan. Drawing it much larger
    // than native trades sharpness for size on the one image this screen has.
    const img = image(render("pinboyz"));
    const asset = logoAsset("pinboyz");
    expect((img.height as number) / asset.height).toBeLessThan(1.15);
  });

  it("is in the FIRST paint — never lazily loaded", () => {
    // A TV has no scroll and no second chance: a board that comes up black for a
    // beat after every reload reads as broken to whoever is standing under it.
    const img = image(render("pinboyz"));
    expect(img.loading).toBe("eager");
    expect(img.fetchPriority).toBe("high");
    // `priority` is deprecated in Next 16 — using it would warn on every board.
    expect(img).not.toHaveProperty("priority");
  });

  it("bypasses the image optimizer, which would re-encode it at quality 75", () => {
    // The asset is already webp-with-alpha at its SOURCE resolution, so the
    // optimizer has no width to save; `images.qualities` is Next 16's default
    // [75], so routing through it costs a second lossy pass whose artefacts land
    // on hard black lettering over flat white.
    expect(image(render("pinboyz")).unoptimized).toBe(true);
  });

  it("carries no alt text — it is decoration, not information", () => {
    // Nothing about this screen is conveyed by the mark to a screen reader, and
    // there is no screen reader on a lobby TV. An empty alt is the correct
    // a11y answer and keeps the a11y gate honest.
    expect(image(render("pinboyz")).alt).toBe("");
  });
});
