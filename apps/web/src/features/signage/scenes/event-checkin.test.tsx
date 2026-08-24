import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { SceneEventCheckin } from "./SceneEventCheckin";
import { SceneEventWelcome } from "./SceneEventWelcome";
import { resolveScreenConfig } from "../defaults";
import { sceneHasData, isSceneImplemented } from "./registry";
import type { SceneProps } from "../director/types";
import type { TvFeed, VipEntry, WelcomeEntry } from "../types";

/**
 * TV5's resting state: the check-in signpost.
 *
 * Two things are worth locking down, and neither is styling. First, that the panel
 * says WHERE to check in — the whole reason it exists is that ads on the events wing
 * told a guest nothing. Second, and more importantly, that the events board can never
 * again render NOTHING: it is substituted onto a wing directly, so a null return is a
 * black panel at the end of a five-TV wall.
 *
 * Rendered by calling the component and walking the element tree rather than through
 * react-dom, matching venue-logo.test.tsx: a root-hoisted react 18 from another
 * workspace shadows apps/web's react 19 in this repo's install layout, and
 * react-dom/server refuses a mismatched pair.
 */

interface Node {
  type?: unknown;
  props?: Record<string, unknown> & { children?: ReactNode };
}

/**
 * The component a scene DELEGATED to, or null when it drew the panel itself.
 *
 * Calling a component returns elements; it does not render them, so a delegated
 * scene is a leaf here and its copy is unreachable. Identity is the right assertion
 * anyway — the claim is "this branch hands the panel to that scene", and matching on
 * words would pass just as well if the wrong scene happened to share a phrase.
 */
function delegate(node: ReactNode): unknown {
  const el = node as Node | null;
  return typeof el?.type === "function" ? el.type : null;
}

/**
 * Every string ANYWHERE in the tree's props, including the plain objects a card is
 * handed (a party's title arrives as `entry.title`, not as children).
 */
function deepStrings(node: ReactNode): string[] {
  const out: string[] = [];
  const fromValue = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(fromValue);
    else if (v && typeof v === "object") {
      const el = v as Node;
      if (el.props) visit(v as ReactNode);
      else Object.values(v as Record<string, unknown>).forEach(fromValue);
    }
  };
  const visit = (n: ReactNode) => {
    if (n == null || typeof n === "boolean" || typeof n === "number") return;
    if (typeof n === "string") {
      out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    const el = n as Node;
    for (const [key, value] of Object.entries(el.props ?? {})) {
      if (key === "children") visit(value as ReactNode);
      else fromValue(value);
    }
  };
  visit(node);
  return out;
}

/** Every string of copy in the tree, joined — what a guest can read off the glass. */
function words(node: ReactNode): string {
  const out: string[] = [];
  const visit = (n: ReactNode) => {
    if (n == null || typeof n === "boolean") return;
    if (typeof n === "string" || typeof n === "number") {
      out.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    const el = n as Node;
    // A component this scene composes (KioskCallout, TvBrandLogo) is an element whose
    // own copy lives behind a `text` prop rather than in children, so read both.
    if (typeof el.props?.text === "string") out.push(el.props.text);
    visit(el.props?.children as ReactNode);
  };
  visit(node);
  return out.join(" | ");
}

/** The front-desk wall's TV5: position 4 of 5, the events wing. */
const TV5 = resolveScreenConfig(
  {
    playlist: [
      { scene: "open-now", slots: 7, span: "middle" },
      { scene: "vip-showcase", slots: 2, span: "wall" },
    ],
    wall: {
      wallId: "hpfm-front-desk",
      position: 4,
      count: 5,
      gapPct: 12,
      outsideScene: "event-welcome",
    },
  } as never,
  "HPFM",
);

function props(feed: Partial<TvFeed> | null, scene: string): SceneProps {
  return {
    feed: feed === null ? null : (feed as TvFeed),
    nowMs: 1_755_600_000_000,
    offset: 0,
    venue: "HPFM",
    config: TV5,
    decision: { scene },
    demo: "off",
  } as unknown as SceneProps;
}

describe("the events wing at rest", () => {
  it("says WHERE to check in, and names the kiosk below", () => {
    const copy = words(SceneEventCheckin(props(null, "event-checkin")));
    expect(copy).toContain("Event Check-In");
    // "THE kiosk below", never "any": the ad rotation sells the whole bank, this
    // panel names the machine standing under it.
    expect(copy).toContain("Check in on the kiosk below");
    expect(copy).not.toMatch(/any kiosk/i);
  });

  it("promises only what kiosk check-in actually does", () => {
    // Capability copy matches the capability: find the reservation, finish the
    // party's waivers, check the whole party in. Nothing about shoes, and no claim
    // that the desk can be skipped for anything else.
    const copy = words(SceneEventCheckin(props(null, "event-checkin")));
    expect(copy).toContain("Find your reservation");
    expect(copy).toContain("waivers");
    expect(copy).toContain("Check everyone in at once");
  });

  it("is ALWAYS populated — it is the empty state, so it cannot have one", () => {
    expect(sceneHasData("event-checkin", null)).toBe(true);
    expect(sceneHasData("event-checkin", {} as TvFeed)).toBe(true);
  });

  it("is built in this deploy, which is what lets a wing fall to it", () => {
    // The understudy goes through the same refusal as every other scene, so an
    // unbuilt name would silently paint house ads instead.
    expect(isSceneImplemented("event-checkin")).toBe(true);
  });
});

describe("the events board never renders nothing", () => {
  const party = (title: string): WelcomeEntry =>
    ({
      id: title,
      title,
      startsAtLabel: "7:00 PM",
      guestCount: 12,
      firstStopLabel: "Bowling",
      building: "HeadPinz Fort Myers",
      isVip: false,
    }) as WelcomeEntry;

  it("falls to the signpost with no events and no VIPs", () => {
    const tree = SceneEventWelcome(props({ events: [], vip: null }, "event-welcome"));
    expect(tree).not.toBeNull();
    expect(delegate(tree)).toBe(SceneEventCheckin);
  });

  it("falls to the signpost when a VIP is known but is NOT in its greeting window", () => {
    // THE DISAGREEMENT THAT BLANKED THE PANEL. `sceneHasData` counts a VIP the moment
    // the feed carries one; the scene counts one only inside its greeting window. A
    // party booked for much later today satisfies the first and not the second, so the
    // wing was selected and then drew nothing.
    const farOff: VipEntry = {
      id: "vip-1",
      title: "The Reyes party",
      schedule: [
        { label: "Bowling", iso: new Date(1_755_600_000_000 + 9 * 3_600_000).toISOString() },
      ],
    } as unknown as VipEntry;
    const feed = { events: [], vip: [farOff] };

    expect(sceneHasData("event-welcome", feed as unknown as TvFeed)).toBe(true);
    const tree = SceneEventWelcome(props(feed, "event-welcome"));
    expect(tree).not.toBeNull();
    expect(delegate(tree)).toBe(SceneEventCheckin);
  });

  it("still shows the parties when there ARE parties", () => {
    const tree = SceneEventWelcome(
      props({ events: [party("The Whitfield party")], vip: null }, "event-welcome"),
    );
    expect(delegate(tree)).not.toBe(SceneEventCheckin);
    expect(deepStrings(tree)).toContain("The Whitfield party");
  });
});
