import { describe, expect, it } from "vitest";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { ScanRail, railType } from "./SceneRaceCheckin";

/**
 * The track board's check-in rail keeps everyone, and shrinks instead of dropping.
 *
 * THE RULE THIS LOCKS IN (owner, 2026-09-07): "make the check in people persistent
 * and the pills just get smaller if we get too many." Before this the rail held
 * six names for ninety seconds — a racer who scanned first watched their name go
 * while their group was still arriving. Now every scan handed to the rail is on
 * the wall, and a bigger heat means smaller pills, never fewer names.
 *
 * It also locks the layout fix that rode with it: the rail used to be an
 * absolutely positioned overlay pinned to the bottom edge, which is how the
 * session's "check in by" line ended up underneath the names. The rail is in
 * flow now, so nothing here may position itself.
 *
 * Rendered by calling the component and walking the element tree rather than
 * through react-dom — same reason as checkin-feed.test.tsx (the repo's install
 * layout hoists a mismatched react for react-dom/server).
 */

type El = ReactElement<{ children?: ReactNode; style?: CSSProperties }>;

function isEl(node: ReactNode): node is El {
  return typeof node === "object" && node != null && "props" in node;
}

/** Every element in the tree, depth-first. */
function elements(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isEl(node)) return [];
  return [node, ...elements(node.props.children)];
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isEl(node) ? textOf(node.props.children) : "";
}

const NOW = 1_800_000_000_000;

function scans(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `scan-${i}`,
    firstName: `Racer${i}`,
    // Newest first, all long enough ago that nobody is "fresh".
    atMs: NOW - 60_000 - i * 10_000,
  }));
}

/** The name pills — every element carrying a racer's name. */
function pills(n: number) {
  const tree = ScanRail({ scans: scans(n), accent: "#3b82f6", nowMs: NOW });
  return elements(tree).filter((el) => /^Racer\d+$/.test(textOf(el.props.children)));
}

describe("ScanRail", () => {
  it("lists every name it is given — nobody is dropped to make room", () => {
    for (const n of [1, 6, 10, 16, 24, 40]) {
      expect(pills(n)).toHaveLength(n);
    }
  });

  it("makes the pills smaller as the heat grows, never fewer", () => {
    const sizeAt = (n: number) => Number(pills(n)[0].props.style?.fontSize);
    const sizes = [6, 10, 16, 24, 40].map(sizeAt);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeLessThan(sizes[i - 1]);
    }
    // A small group still gets the size the rail has always had.
    expect(sizeAt(1)).toBe(46);
    expect(sizeAt(6)).toBe(46);
  });

  it("gives the person who just scanned a bigger pill than the rest", () => {
    const list = scans(8);
    list[0] = { ...list[0], atMs: NOW - 2_000 };
    const tree = ScanRail({ scans: list, accent: "#3b82f6", nowMs: NOW });
    const [fresh, next] = elements(tree).filter((el) =>
      /^Racer\d+$/.test(textOf(el.props.children)),
    );
    expect(Number(fresh.props.style?.fontSize)).toBeGreaterThan(Number(next.props.style?.fontSize));
  });

  it("is laid out in flow — nothing in it positions itself over the session", () => {
    const tree = ScanRail({ scans: scans(12), accent: "#3b82f6", nowMs: NOW });
    for (const el of elements(tree)) {
      expect(el.props.style?.position).toBeUndefined();
    }
  });
});

describe("railType", () => {
  it("steps down monotonically and never below a readable floor", () => {
    let last = Number.POSITIVE_INFINITY;
    for (let n = 1; n <= 40; n++) {
      const { font, fresh } = railType(n);
      expect(font).toBeLessThanOrEqual(last);
      expect(fresh).toBeGreaterThan(font);
      // 24px on a 1920-wide canvas is the smallest thing on any of these walls.
      expect(font).toBeGreaterThanOrEqual(24);
      last = font;
    }
  });
});
