/**
 * Golden rule (owner 2026-09-01): "how much $ per location; the highest is
 * where we should charge it."
 *
 * The WEB deposit order / payment / gift card must book at the entity holding
 * the LARGEST share of the cart's charged value — not at HeadPinz merely
 * because a HeadPinz product is present. The old rule put the card at the
 * MINORITY entity on every mixed cart, which is what drove $48k of HPFM→FT
 * gift-card transfer over 90 days.
 *
 * Revenue routing is deliberately NOT changed here — the day-of order still
 * books to the entity that owns each product.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/redis", () => ({ default: {} }));

import { buildCombinedLineItems, resolveChargeLocationId } from "./unified-reserve";
import { SQUARE_LOCATIONS } from "~/features/booking/data/square-catalog-map";
import {
  emptySession,
  newItem,
  type AttractionItem,
  type BookingSession,
  type RaceSimItem,
} from "../state/types";

/** FastTrax dollars: $14/racer weekday (2026-08-24 is a Monday). */
function simItem(racerCount = 2): RaceSimItem {
  return {
    ...(newItem("racesim") as RaceSimItem),
    id: "rs1",
    date: "2026-08-24",
    productKind: "single",
    productSlug: "sim-single",
    trackKey: "a",
    racerCount,
    slot: "2026-08-24T15:00:00",
    assignedTo: [],
  } as RaceSimItem;
}

/** HeadPinz dollars by default; `duck-pin` is the FastTrax carve-out. */
function attrItem(price: number, qty = 1, slug = "gel-blaster"): AttractionItem {
  return {
    ...(newItem("attraction") as AttractionItem),
    id: `a-${slug}-${price}-${qty}`,
    slug,
    date: "2026-08-24",
    slot: "2026-08-24T15:00:00",
    qty,
    productId: "8976680",
    price,
  } as AttractionItem;
}

function webSession(items: BookingSession["items"]): BookingSession {
  return {
    ...emptySession({ entryBrand: "fasttrax" }),
    center: "fort-myers",
    items,
  } as BookingSession;
}

describe("entityCents attribution", () => {
  it("attributes race-sim value to FastTrax and attraction value to HeadPinz", () => {
    const { entityCents } = buildCombinedLineItems(webSession([simItem(2), attrItem(12)]));
    expect(entityCents).toEqual({ fasttrax: 2800, headpinz: 1200 });
  });

  it("routes the duck-pin attraction to FastTrax, not HeadPinz", () => {
    const { entityCents } = buildCombinedLineItems(webSession([attrItem(10, 2, "duck-pin")]));
    expect(entityCents).toEqual({ fasttrax: 2000, headpinz: 0 });
  });

  it("sums to the charged subtotal when no entity-neutral line is present", () => {
    const { entityCents, totalPriceCents } = buildCombinedLineItems(
      webSession([simItem(3), attrItem(12, 4)]),
    );
    expect(entityCents.fasttrax + entityCents.headpinz).toBe(totalPriceCents);
  });
});

describe("resolveChargeLocationId — golden rule", () => {
  it("single-entity FastTrax cart charges at FastTrax (unchanged)", () => {
    expect(resolveChargeLocationId(webSession([simItem(2)]))).toBe(SQUARE_LOCATIONS.FASTTRAX_FM);
  });

  it("single-entity HeadPinz cart charges at HeadPinz (unchanged)", () => {
    expect(resolveChargeLocationId(webSession([attrItem(12)]))).toBe(SQUARE_LOCATIONS.HEADPINZ_FM);
  });

  it("mixed cart charges at FastTrax when racing holds the most dollars", () => {
    // The live leak shape: a big race line plus one small gel-blaster add-on.
    // The OLD rule sent this to HeadPinz purely because gel-blaster was present.
    const session = webSession([simItem(8), attrItem(12, 1)]); // $112 FT vs $12 HP
    expect(resolveChargeLocationId(session)).toBe(SQUARE_LOCATIONS.FASTTRAX_FM);
  });

  it("mixed cart charges at HeadPinz when the attraction holds the most dollars", () => {
    const session = webSession([simItem(1), attrItem(12, 6)]); // $14 FT vs $72 HP
    expect(resolveChargeLocationId(session)).toBe(SQUARE_LOCATIONS.HEADPINZ_FM);
  });

  it("a tie falls back to the day-of owner, so behaviour never flaps", () => {
    const session = webSession([simItem(1), attrItem(14, 1)]); // $14 vs $14
    // Day-of owner for a cart containing a HeadPinz attraction is HeadPinz.
    expect(resolveChargeLocationId(session)).toBe(SQUARE_LOCATIONS.HEADPINZ_FM);
  });

  it("Naples resolves its HeadPinz side to the Naples location", () => {
    const session = {
      ...webSession([attrItem(12, 3)]),
      center: "naples",
    } as BookingSession;
    expect(resolveChargeLocationId(session)).toBe(SQUARE_LOCATIONS.HEADPINZ_NAP);
  });
});
