/**
 * Race booking service — implements the hold/confirm/cancel contract
 * for RaceItem.
 *
 * hold() books all BMI lines for one RaceItem:
 *   1. Book each heat (bmiAdapter.bookHeat) — sequential, orderId chains
 *   2. Sell license for new racers (booking/sell via BMI proxy)
 *   3. Sell POV cameras (booking/sell via SMS proxy — different endpoint!)
 *   4. Book addon activities (booking/book via bmiAdapter — needs fresh proposals)
 *
 * BMI ID precision: the adapter handles stringifyWithRawIds internally.
 * The license/POV sells use raw JSON template literals because their
 * payload shapes differ from the adapter's booking/book format.
 */
import { racerNeedsLicense } from "./license";
import type { Dispatch } from "react";
import type { Action } from "../state/machine";
import type { BookingSession, PartyMember, RaceItem, RaceHeatAssignment } from "../state/types";
import { packageIdForCategory, racePackageIds, raceItemFullyPackaged } from "../state/types";
import { crossCategoryCollisionMessage, findCrossCategorySameStart } from "./conflict";
import {
  bmiAdapter,
  type BmiProposal,
  type BmiAvailabilityResponse,
  type BmiBlock,
} from "../data/bmi";
import { registerContact } from "./bmi-register";
import { getPackage } from "./packages";
import { bookingAddonsEnabled, getBookingAddon } from "../data/addon-catalog";
import { addonEligibleMembers } from "./addon-charge";
import {
  evaluateRaceRestrictions,
  type RestrictionBlock,
  type TrackTierBlock,
} from "./race-restriction-rules";

const LICENSE_PRODUCT_ID = "43473520";
const POV_PRODUCT_ID = "43746981";
/** $0 POV build product — books POV as a $0 line so the bill stays a $0 credit
 *  under the $0 model; the POV money ($4.99/racer) is charged on Square. */
const POV_ZERO_PRODUCT_ID = "50361293";
const ADDON_PAGE_ID = "42730172";

/**
 * Is this RaceItem eligible for the v2 "$0 BMI build product + Square charges
 * the registry price" model? Now covers SINGLE races, COMBOS (3-Packs), and
 * PACKAGES (Rookie Pack / Ultimate Qualifier) — every one routes each heat to a
 * $0 build pair via `resolveBuildPair` (by `(category,tier,track)` parts for
 * package/combo heats, by productId for single races). POV rides its own $0
 * product (50361293, see `sellPov`) so it no longer forces the legacy path.
 *
 * Only race-day ADD-ONS still drop to legacy (they have no $0 build product).
 *
 * When true: heats (+ bundled license + POV) are $0 on the BMI bill → the whole
 * bill is a $0 credit, and Square charges the real price (single race + license,
 * combo pack total, or package bundle total).
 */
export function raceUsesZeroBmiModel(item: RaceItem): boolean {
  if (item.heats.length === 0) return false;
  if (item.addons.some((a) => a.qty > 0)) return false;
  for (const heat of item.heats) {
    const pair = resolveBuildPair({
      productId: heat.productId,
      category: heat.category,
      tier: heat.tier,
      track: heat.track,
    });
    if (!pair) return false;
  }
  return true;
}

/**
 * POV cameras owed for one RaceItem — the SINGLE source for the $0 POV
 * bill-line qty (sellPov, below) AND the kiosk code-claim qty
 * (unified-reserve → kiosk-post-reserve), so the two can never drift.
 *
 * Package POV is per CATEGORY (adult/junior variants are separate packages):
 * each variant with `includesPov` covers exactly ITS category's unique racers
 * (Ultimate Qualifier, Rookie Pack packages). `item.povQuantity` covers the
 * non-packaged remainder — the individual Viewpoints upsell and combos
 * (ComboSteps sets povQuantity = includedPovPerRacer × racers — no separate
 * combo term here or it double-counts).
 */
export function computeRaceItemPovQty(item: RaceItem, party: BookingSession["party"]): number {
  let povQty = 0;
  for (const category of ["adult", "junior"] as const) {
    const pkg = getPackage(packageIdForCategory(item, category));
    if (!pkg?.includesPov) continue;
    const catRacers = new Set(
      item.heats
        .filter((h) => (h.category ?? "adult") === category)
        .map((h) => h.assignedTo)
        .filter(Boolean),
    ).size;
    povQty += catRacers || 1;
  }
  if (!raceItemFullyPackaged(item, party)) povQty += item.povQuantity;
  return povQty;
}

/**
 * Party members whose race video is NOT already covered by their category's
 * selected package. The POV upsell step offers cameras for exactly this many
 * racers (and hides when it's zero) — a racer whose package carries
 * `includesPov` must never be counted into the "Add for all N" offer, or a
 * partially-packaged party gets sold a camera the bundle already includes.
 */
export function povUncoveredRacers<M extends { category?: "adult" | "junior" }>(
  item: Pick<RaceItem, "packageIdAdult" | "packageIdJunior">,
  party: M[],
): M[] {
  return party.filter(
    (m) => !getPackage(packageIdForCategory(item, m.category ?? "adult"))?.includesPov,
  );
}

export function povUncoveredRacerCount(
  item: Pick<RaceItem, "packageIdAdult" | "packageIdJunior">,
  party: Array<{ category?: "adult" | "junior" }>,
): number {
  return povUncoveredRacers(item, party).length;
}

/**
 * Heat indices that should book the `+license` $0 build product: the FIRST heat
 * of each NEW racer. Guarantees a multi-heat new racer gets the license exactly
 * once. Deterministic by heat order, so it's stable across retries and across
 * bookHeatsOnAdvance / holdRaceItem. Harmless on the legacy path (the target
 * resolver ignores `withLicense` when there's no build pair).
 */
function licenseHeatIndices(session: BookingSession, item: RaceItem): Set<number> {
  const indices = new Set<number>();
  const seen = new Set<string>();
  for (let i = 0; i < item.heats.length; i++) {
    const memberId = item.heats[i].assignedTo;
    if (!memberId || seen.has(memberId)) continue;
    const member = session.party.find((m) => m.id === memberId);
    // VERIFIED licence state, the same source the $4.99 Square line reads
    // (service/license.ts): a returning racer whose annual licence lapsed books
    // the +licence twin, and a racer who already holds one never does.
    // licensePrepaid (race-pack "Race today" hand-off) counts as holding one, so
    // it can't book a SECOND grant.
    if (!member || !racerNeedsLicense(member)) continue;
    seen.add(memberId);
    indices.add(i);
  }
  return indices;
}

/**
 * Cart-level cross-category guard (owner 2026-07-19): within one session an
 * adult heat and a junior heat may not share the same (track, start). Adult
 * and junior races are DIFFERENT BMI products sold into ONE physical session,
 * so neither BMI's capacity gate nor the per-racer spacing rules stop the
 * double-book. The grids grey these slots, but a stale availability cache (60s
 * staleTime, keys shared with the cross-tier fan-out) can let a pick through —
 * this runs before ANY BMI write and throws a guest-readable message (it
 * surfaces verbatim in the kiosk toast / hold-error card).
 */
function assertNoCrossCategoryCollision(session: BookingSession, item: RaceItem): void {
  const heats = session.items
    .filter((i): i is RaceItem => i.kind === "race")
    // The passed `item` carries the freshest heats — React state in
    // session.items can lag one dispatch behind it.
    .flatMap((i) => (i.id === item.id ? item : i).heats);
  const hit = findCrossCategorySameStart(heats);
  if (hit) throw new Error(crossCategoryCollisionMessage(hit.start, hit.track));
}

// ── bookHeatsOnAdvance: book unbooked heats when leaving heat picker ────

export async function bookHeatsOnAdvance(
  session: BookingSession,
  item: RaceItem,
  dispatch: Dispatch<Action>,
  onProgress?: (msg: string) => void,
): Promise<void> {
  assertNoCrossCategoryCollision(session, item);
  let billId = session.bmiBillId;

  // Pre-count remaining heats so progress reads "Reserving heat 1 of N"
  // for the customer's mental model, not "1 of all-heats-including-
  // already-booked-ones".
  const unbooked = item.heats.filter((h) => !h.bmiLineId && h.heatId && h.productId);
  let bookedCount = 0;
  const totalToBook = unbooked.length;
  const licenseHeats = licenseHeatIndices(session, item);

  for (let i = 0; i < item.heats.length; i++) {
    const heat = item.heats[i];
    if (heat.bmiLineId) continue;
    if (!heat.heatId || !heat.productId) continue;

    bookedCount += 1;
    onProgress?.(
      totalToBook > 1 ? `Reserving heat ${bookedCount} of ${totalToBook}…` : "Reserving your heat…",
    );

    const personId = heat.assignedTo
      ? (session.party.find((m) => m.id === heat.assignedTo)?.bmiPersonId ?? null)
      : null;

    // v2 books against the $0 build product (raceOnly, or the +license twin for
    // a new racer's first heat); falls back to the priced product until the $0
    // products are wired in. Build + priced share a dayplanner, so the picked
    // heat time still resolves.
    const target = bmiBookingTarget(heat.productId, {
      withLicense: licenseHeats.has(i),
      category: heat.category,
      tier: heat.tier,
      track: heat.track,
    });
    const availability = await bmiAdapter.getAvailability({
      date: item.date!,
      productId: target.productId,
      pageId: target.pageId,
      quantity: 1,
    });
    const matchingProposal = findProposalForHeat(availability.proposals, heat.heatId);
    if (!matchingProposal) {
      throw new Error(`Heat at ${heat.heatId} is no longer available`);
    }
    await assertHeatBookable(session, heat, availability, item.date);

    const { result, billId: billAfter } = await bookHeatWithFreshBillRetry({
      bookArgs: {
        productId: target.productId,
        quantity: 1,
        proposal: matchingProposal,
        orderId: billId,
        personId,
      },
      item,
      // bookedCount incremented above for THIS attempt — >1 means a prior heat
      // just booked on the bill, so it's alive and a fresh-bill retry is wrong.
      anythingBookedThisRun: bookedCount > 1,
      dispatch,
    });
    billId = billAfter;

    // The RESPONSE's orderId is AUTHORITATIVE. When the order we chained onto
    // is cancelled (a deselect that empties a Pending-online order makes BMI
    // auto-cancel it), booking/book does NOT error — it silently creates a
    // fresh order and returns ITS id. Keeping the stale id strands every later
    // line on invisible new W-numbers and every removeItem answers "Order is
    // cancelled" (live find 2026-07-19: one lingering reservation per re-pick).
    // Adopting the returned id also covers the brand-new-bill case (!billId).
    if (result.rawOrderId && result.rawOrderId !== billId) {
      billId = result.rawOrderId;
      dispatch({ type: "setBmiBillId", id: billId });
      // Attach the customer to the (possibly brand-new) bill immediately (v1
      // parity: registerContactPerson) so a reservation never exists without
      // a contact. Non-fatal.
      await registerContact(billId, session.contact, session.party);
    }

    dispatch({
      type: "updateHeat",
      itemId: item.id,
      heatIndex: i,
      patch: { bmiLineId: result.billLineId },
    });
  }

  // POV + package/combo memo — ONCE, after heats book (guarded by item.povSold).
  // The $0 POV product keeps the bill a $0 credit; the POV money is charged on
  // Square (inside the package bundle, or as a standalone POV line). Packages set
  // includesPov (not povQuantity), so derive the qty from the package + racers.
  if (billId && !item.povSold) {
    const povQty = computeRaceItemPovQty(item, session.party);
    // A failed sellPov must NOT set povSold — that flag is the only retry
    // gate, so marking it on failure meant the $0 POV line never reached the
    // bill (and the confirmation page had no POV line to claim codes from).
    // Trade-off: while sellPov keeps failing, the disclaimer memo below can
    // re-append on each advance — duplicate memo text is cosmetic; a racer
    // with no POV is not.
    const povOk = povQty > 0 ? await sellPov(billId, povQty, raceUsesZeroBmiModel(item)) : true;
    let wroteMemo = false;
    // Package disclaimer trail (e.g. Ultimate Qualifier qualification terms) so
    // ops sees the acknowledgment at check-in. v1 parity (page.tsx booking/memo).
    // Deduped across the item's packages — the adult + junior variants of one
    // family share the same memo text, which should land once, not twice.
    const memos = [
      ...new Set(
        racePackageIds(item)
          .map((id) => getPackage(id)?.disclaimers?.billMemo)
          .filter((m): m is string => !!m),
      ),
    ];
    for (const memo of memos) {
      await writeBillMemo(billId, memo);
      wroteMemo = true;
    }
    // NOTE: the combo VIP memo is NOT written here. BMI's booking/memo is a
    // single OVERWRITING field, and the confirmation page rewrites it once via
    // buildReservationMemo (Express Lane + booking URL + combo note + POV +
    // paid). A separate write here gets clobbered — and surfaced wrong. The
    // combo note (with the assigned bowling lane) is composed there instead.
    if (povOk && (povQty > 0 || wroteMemo)) {
      dispatch({
        type: "updateItem",
        id: item.id,
        patch: { povSold: true } as Partial<RaceItem>,
      });
    }
  }

  // Retail add-on $0 BMI lines (headsock "pre-purchase" record) — povSold's
  // exact once-only contract via addonsBmiSold. Money is on Square; this is
  // the ops-visible reservation record the owner asked for (2026-08-10).
  if (billId && !item.addonsBmiSold) {
    const plan = addonZeroSellPlan(item, session.party);
    if (plan.length > 0 && (await sellAddonZeroLines(billId, plan))) {
      dispatch({
        type: "updateItem",
        id: item.id,
        patch: { addonsBmiSold: true } as Partial<RaceItem>,
      });
    }
  }
}

// ── holdPickedHeats: eager hold of a just-picked block (all-or-nothing) ──

export interface HoldHeatsResult {
  ok: boolean;
  /** Lines booked in this pick — committed on success, released on failure. */
  booked: Array<{ heatIndex: number; bmiLineId: string | null }>;
  /** Latest bill id (set even on partial failure, so the caller releases on the
   *  right bill — this pick may have lazily created it). */
  billId: string | null;
  error?: string;
}

/**
 * Eagerly hold the heats a customer JUST picked — fired on block click (single
 * racer) or on racer-selection confirm (multi), so the spot is held the instant
 * it's chosen instead of when they leave the grid (a race against other guests
 * on busy days). Books every still-unbooked heat in `item` — which is exactly
 * the new pick, since prior picks were already held eagerly.
 *
 * ALL-OR-NOTHING: on any failure it returns `ok:false` WITHOUT committing the
 * failed line and reports the lines that DID succeed in `booked`, so the caller
 * can release them — a partially-booked block never orphans on the bill.
 *
 * Heats only. POV + the package disclaimer memo stay on the advance-time path
 * (bookHeatsOnAdvance), which still runs as an idempotent backstop.
 */
/**
 * bookHeat with a one-shot FRESH-BILL retry (owner 2026-07-18: "why not create
 * a new order"). Chaining onto a bill BMI already auto-cancelled (the
 * Pending-Online timeout) "books" but returns no orderId → the guest got
 * "Couldn't hold that heat — BMI booking returned no orderId" with no way
 * forward. When NOTHING is held yet anywhere on the item (so heats can't split
 * across two bills), drop the dead bill and book onto a brand-new one; the
 * caller's `if (!billId)` block then adopts the fresh id + attaches the
 * contact. Anything-already-held keeps the old fail-fast (charge-time
 * rebuildRaceBillIfExpired remains the deep-recovery path).
 */
async function bookHeatWithFreshBillRetry(args: {
  bookArgs: Parameters<typeof bmiAdapter.bookHeat>[0];
  item: RaceItem;
  anythingBookedThisRun: boolean;
  dispatch: Dispatch<Action>;
}): Promise<{ result: Awaited<ReturnType<typeof bmiAdapter.bookHeat>>; billId: string | null }> {
  const { bookArgs, item, anythingBookedThisRun, dispatch } = args;
  try {
    return { result: await bmiAdapter.bookHeat(bookArgs), billId: bookArgs.orderId ?? null };
  } catch (err) {
    const deadChainedBill =
      bookArgs.orderId != null &&
      err instanceof Error &&
      err.message.includes("returned no orderId") &&
      !anythingBookedThisRun &&
      !item.heats.some((h) => h.bmiLineId);
    if (!deadChainedBill) throw err;
    console.warn(
      `[race] bill ${bookArgs.orderId} appears dead (no orderId on book) — retrying on a FRESH bill`,
    );
    dispatch({ type: "setBmiBillId", id: null });
    const result = await bmiAdapter.bookHeat({ ...bookArgs, orderId: null });
    return { result, billId: null };
  }
}

export async function holdPickedHeats(
  session: BookingSession,
  item: RaceItem,
  dispatch: Dispatch<Action>,
): Promise<HoldHeatsResult> {
  // Cross-category double-book is a pick error, not a transient hold failure —
  // report it through the result shape the picker already renders.
  try {
    assertNoCrossCategoryCollision(session, item);
  } catch (err) {
    return {
      ok: false,
      booked: [],
      billId: session.bmiBillId,
      error: err instanceof Error ? err.message : "Adults and juniors can't share a heat.",
    };
  }
  let billId = session.bmiBillId;
  const licenseHeats = licenseHeatIndices(session, item);
  const booked: Array<{ heatIndex: number; bmiLineId: string | null }> = [];

  for (let i = 0; i < item.heats.length; i++) {
    const heat = item.heats[i];
    if (heat.bmiLineId) continue; // already held (prior picks) — retry-safe
    if (!heat.heatId || !heat.productId) continue;

    const personId = heat.assignedTo
      ? (session.party.find((m) => m.id === heat.assignedTo)?.bmiPersonId ?? null)
      : null;
    const target = bmiBookingTarget(heat.productId, {
      withLicense: licenseHeats.has(i),
      category: heat.category,
      tier: heat.tier,
      track: heat.track,
    });

    try {
      const availability = await bmiAdapter.getAvailability({
        date: item.date!,
        productId: target.productId,
        pageId: target.pageId,
        quantity: 1,
      });
      const matchingProposal = findProposalForHeat(availability.proposals, heat.heatId);
      if (!matchingProposal) throw new Error("that time just filled up");
      await assertHeatBookable(session, heat, availability, item.date);

      const { result, billId: billAfter } = await bookHeatWithFreshBillRetry({
        bookArgs: {
          productId: target.productId,
          quantity: 1,
          proposal: matchingProposal,
          orderId: billId,
          personId,
        },
        item,
        anythingBookedThisRun: booked.length > 0,
        dispatch,
      });
      billId = billAfter;

      // Response orderId is AUTHORITATIVE — adopt it whenever it differs (BMI
      // silently reparents onto a fresh order when the chained order was
      // cancelled, e.g. after a deselect emptied it; see bookHeatsOnAdvance).
      if (result.rawOrderId && result.rawOrderId !== billId) {
        billId = result.rawOrderId;
        dispatch({ type: "setBmiBillId", id: billId });
        // Attach the customer to the (possibly brand-new) bill immediately so
        // a reservation never exists without a contact. Non-fatal.
        await registerContact(billId, session.contact, session.party);
      }
      booked.push({ heatIndex: i, bmiLineId: result.billLineId });
    } catch (err) {
      return {
        ok: false,
        booked,
        billId,
        error: err instanceof Error ? err.message : "couldn't hold that heat",
      };
    }
  }

  // All lines held — commit their bmiLineIds to the cart.
  for (const b of booked) {
    dispatch({
      type: "updateHeat",
      itemId: item.id,
      heatIndex: b.heatIndex,
      patch: { bmiLineId: b.bmiLineId },
    });
  }
  return { ok: true, booked, billId };
}

// ── hold: book all BMI lines for a single RaceItem ──────────────────────

export interface RaceHoldResult {
  bmiBillId: string;
  licenseSold: boolean;
  povSold: boolean;
  addonResults: Array<{ addonId: string; booked: boolean }>;
}

export async function holdRaceItem(
  session: BookingSession,
  item: RaceItem,
  dispatch: Dispatch<Action>,
): Promise<RaceHoldResult> {
  assertNoCrossCategoryCollision(session, item);
  let billId = session.bmiBillId;
  const licenseHeats = licenseHeatIndices(session, item);

  // 1. Book each heat that hasn't been booked yet
  for (let i = 0; i < item.heats.length; i++) {
    const heat = item.heats[i];
    if (heat.bmiLineId) continue; // already booked (retry-safe)
    if (!heat.heatId || !heat.productId) continue;

    // Ensure the assigned party member has a bmiPersonId
    let personId: string | null = null;
    if (heat.assignedTo) {
      const member = session.party.find((m) => m.id === heat.assignedTo);
      if (member) {
        personId = await ensurePersonId(member, session, dispatch);
      }
    }

    // Build a minimal proposal from the heat pick. The heat picker
    // stored block.start as heatId — we reconstruct the proposal shape
    // that bmiAdapter.bookHeat expects.
    // v2 books against the $0 build product (raceOnly, or the +license twin for
    // a new racer's first heat); falls back to the priced product until the $0
    // products are wired in. Build + priced share a dayplanner, so the picked
    // heat time still resolves.
    const target = bmiBookingTarget(heat.productId, {
      withLicense: licenseHeats.has(i),
      category: heat.category,
      tier: heat.tier,
      track: heat.track,
    });
    const availability = await bmiAdapter.getAvailability({
      date: item.date!,
      productId: target.productId,
      pageId: target.pageId,
      quantity: 1,
    });
    const matchingProposal = findProposalForHeat(availability.proposals, heat.heatId);
    if (!matchingProposal) {
      throw new Error(`Heat at ${heat.heatId} no longer available for product ${heat.productId}`);
    }
    await assertHeatBookable(session, heat, availability, item.date);

    const result = await bmiAdapter.bookHeat({
      productId: target.productId,
      quantity: 1,
      proposal: matchingProposal,
      orderId: billId,
      personId,
    });

    // Response orderId is AUTHORITATIVE — adopt it whenever it differs (BMI
    // silently reparents onto a fresh order when the chained order was
    // cancelled; see bookHeatsOnAdvance).
    if (result.rawOrderId && result.rawOrderId !== billId) {
      billId = result.rawOrderId;
      dispatch({ type: "setBmiBillId", id: billId });
    }

    dispatch({
      type: "updateHeat",
      itemId: item.id,
      heatIndex: i,
      patch: { bmiLineId: result.billLineId },
    });
  }

  if (!billId) {
    throw new Error("No BMI bill — book at least one heat before checkout");
  }

  // 2. Sell license for new racers (non-fatal). On the $0 model the license is
  // bundled into the new racer's +license build product (recorded in BMI at $0,
  // charged via Square), so the separate booking/sell is skipped.
  const newRacerCount = session.party.filter((m) => m.isNewRacer).length;
  let licenseSold = false;
  if (newRacerCount > 0) {
    licenseSold = raceUsesZeroBmiModel(item) ? true : await sellLicense(billId, newRacerCount);
  }

  // 3. Sell POV cameras (non-fatal) — guarded by item.povSold, the SAME flag
  // bookHeatsOnAdvance sets: without it this pay-time hold re-sold the $0 POV
  // line a second time, and BMI merged it into one line at DOUBLE quantity
  // (owner smoke 2026-08-10, W59788: 1 camera bought, "POV Video Issued" ×2).
  let povSold = item.povSold ?? false;
  if (item.povQuantity > 0 && !item.povSold) {
    povSold = await sellPov(billId, item.povQuantity, raceUsesZeroBmiModel(item));
    if (povSold) {
      dispatch({ type: "updateItem", id: item.id, patch: { povSold: true } as Partial<RaceItem> });
    }
  }

  // 3b. Retail add-on $0 BMI lines (headsock pre-purchase) — same once-only
  // guard as the advance-time path (addonsBmiSold), so whichever runs first
  // records it and the other no-ops.
  if (!item.addonsBmiSold) {
    const plan = addonZeroSellPlan(item, session.party);
    if (plan.length > 0 && (await sellAddonZeroLines(billId, plan))) {
      dispatch({
        type: "updateItem",
        id: item.id,
        patch: { addonsBmiSold: true } as Partial<RaceItem>,
      });
    }
  }

  // 4. Book addon activities (non-fatal per addon)
  const addonResults: RaceHoldResult["addonResults"] = [];
  for (const addon of item.addons) {
    if (addon.qty <= 0 || !addon.selectedTime || addon.bmiLineId) continue;
    const result = await bookAddon(billId, addon);
    addonResults.push({ addonId: addon.id, booked: result.booked });
    if (result.booked && result.bmiLineId) {
      // Rebuild addons array with this entry's bmiLineId patched in
      const patched = item.addons.map((a) =>
        a.id === addon.id ? { ...a, bmiLineId: result.bmiLineId } : a,
      );
      dispatch({
        type: "updateItem",
        id: item.id,
        patch: { addons: patched } as Partial<RaceItem>,
      });
    }
  }

  return { bmiBillId: billId, licenseSold, povSold, addonResults };
}

// ── confirm: finalize BMI bill after payment ────────────────────────────

export async function confirmRaceOrder(billId: string): Promise<string | null> {
  const result = await bmiAdapter.confirmPayment({ orderId: billId });
  return result.reservationNumber;
}

// ── cancel: cancel the BMI bill ─────────────────────────────────────────

/**
 * Did the cancel actually take? A cancelled bill carries no lines. This is the
 * only signal worth trusting: BMI's cancel replies with a bare `true`, so any
 * mismatch between what the proxy forwards and what this file expects turns a
 * SUCCESSFUL cancel into a logged failure (that is exactly what happened —
 * 2026-08-04, bill 63000000007234468: three "not confirmed" attempts, while the
 * Office project showed products:0 and all 13 schedule rows at stateId -4, i.e.
 * cancelled by us and holding nothing). Returns null when the read itself is
 * unavailable — never guess from an unreachable endpoint.
 */
async function billIsEmpty(billId: string, clientKey?: string): Promise<boolean | null> {
  try {
    const params = new URLSearchParams({ endpoint: `order/${billId}/overview` });
    if (clientKey) params.set("clientKey", clientKey);
    const res = await fetch(`/api/bmi?${params}`);
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { lines?: unknown[] } | null;
    return Array.isArray(data?.lines) ? data.lines.length === 0 : null;
  } catch {
    return null;
  }
}

/**
 * Cancel the whole BMI bill (releases every held heat/slot + the attached
 * contact). The abandon paths (kiosk start-over/idle-timeout, web
 * start-new-booking) depend on this landing, or the reservation keeps blocking
 * its heat until BMI's ~20-min auto-expire. So: retry transient failures, target
 * the bill's own tenant via `clientKey`, send with `keepalive` so a navigation
 * (kiosk self-update hard reload) can't kill an in-flight attempt — and when the
 * RESPONSE never confirms, check the EFFECT before crying failure.
 *
 * BMI answers a cancel with raw `true`. The proxy JSON-parses that, so the body
 * is the boolean `true`, not `{success:true}` — this function used to demand the
 * latter and therefore could never return true, no matter how well the cancel
 * worked. Both shapes are accepted now (a kiosk tab runs stale JS for days, so
 * old client + new proxy and vice versa both have to work), and the read-back
 * below is the backstop for any future shape drift. Never throws.
 */
export async function cancelRaceOrder(billId: string, clientKey?: string): Promise<boolean> {
  const params = new URLSearchParams({ endpoint: `bill/${billId}/cancel` });
  if (clientKey) params.set("clientKey", clientKey);
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`/api/bmi?${params}`, { method: "DELETE", keepalive: true });
      const body: unknown = await res.json().catch(() => null);
      const confirmed =
        body === true ||
        (typeof body === "object" && body !== null && (body as { success?: boolean }).success);
      if (res.ok && confirmed) return true;
      console.warn(`[race.cancel] attempt ${i}/${attempts} not confirmed:`, billId, res.status);
    } catch (err) {
      console.warn(`[race.cancel] attempt ${i}/${attempts} failed:`, billId, err);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
  }
  // Nothing confirmed — but "not confirmed" is not "not cancelled". Read the
  // bill: empty means the cancel landed and only the acknowledgement was lost.
  const empty = await billIsEmpty(billId, clientKey);
  if (empty === true) {
    console.warn(
      "[race.cancel] no confirmation, but the bill is empty — cancel took effect:",
      billId,
    );
    return true;
  }
  console.error(
    "[race.cancel] bill cancel NOT confirmed after retries:",
    billId,
    empty === false ? "— bill STILL HAS LINES, heats remain held" : "(bill read unavailable)",
  );
  return false;
}

// ── internal: license sell via BMI proxy ─────────────────────────────────

async function sellLicense(billId: string, quantity: number): Promise<boolean> {
  try {
    const body = `{"ProductId":${LICENSE_PRODUCT_ID},"Quantity":${quantity},"orderId":${billId}}`;
    const res = await fetch(`/api/bmi?${new URLSearchParams({ endpoint: "booking/sell" })}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) {
      console.warn("[race.sellLicense] failed:", res.status);
      return false;
    }
    const text = await res.text();
    const parsed = JSON.parse(text);
    if (parsed.success === false) {
      console.warn("[race.sellLicense] API error:", parsed.errorMessage);
      return false;
    }
    console.log("[race.sellLicense] sold", quantity, "license(s) on bill", billId);
    return true;
  } catch (err) {
    console.warn("[race.sellLicense] error (non-fatal):", err);
    return false;
  }
}

// ── internal: $0 add-on BMI lines (headsock etc.) ────────────────────────

/** The $0 BMI lines owed for this item's retail add-on selections — one entry
 *  per catalog add-on that carries a `bmiZeroProductId` (v1: "Headsock
 *  Pre-Purchase" 48952128), qty = ELIGIBLE selected racers (the same
 *  addonEligibleMembers seam the charge uses — the BMI record must never
 *  exceed what Square charged). Money stays on Square; this is ops
 *  visibility on the reservation bill, same as $0 POV. */
export function addonZeroSellPlan(
  item: RaceItem,
  party: PartyMember[],
): Array<{ slug: string; productId: string; quantity: number }> {
  if (!bookingAddonsEnabled()) return [];
  const out: Array<{ slug: string; productId: string; quantity: number }> = [];
  for (const sel of item.addonSelections ?? []) {
    const addon = getBookingAddon(sel.slug);
    if (!addon?.bmiZeroProductId) continue;
    const eligibleIds = new Set(addonEligibleMembers(addon, party).map((m) => m.id));
    const quantity = new Set(sel.memberIds.filter((id) => eligibleIds.has(id))).size;
    if (quantity > 0) out.push({ slug: sel.slug, productId: addon.bmiZeroProductId, quantity });
  }
  return out;
}

/** Sell the plan's $0 lines on the bill — sellPov's exact wire call. Returns
 *  true only if EVERY line landed (the caller's sold-flag semantics). */
async function sellAddonZeroLines(
  billId: string,
  plan: Array<{ slug: string; productId: string; quantity: number }>,
): Promise<boolean> {
  let allOk = true;
  for (const line of plan) {
    try {
      const res = await fetch("/api/sms?endpoint=booking%2Fsell", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          {
            productId: line.productId,
            pageId: null,
            quantity: line.quantity,
            billId,
            dynamicLines: null,
            sellKind: 0,
          },
        ]),
      });
      if (!res.ok) {
        console.warn(`[race.sellAddonZeroLines] ${line.slug} failed:`, res.status);
        allOk = false;
        continue;
      }
      console.log(
        `[race.sellAddonZeroLines] sold ${line.quantity} × ${line.slug} ($0 product ${line.productId}) on bill`,
        billId,
      );
    } catch (err) {
      console.warn(`[race.sellAddonZeroLines] ${line.slug} error (non-fatal):`, err);
      allOk = false;
    }
  }
  return allOk;
}

// ── internal: POV sell via SMS proxy (different endpoint than BMI!) ──────

async function sellPov(billId: string, quantity: number, zeroModel = false): Promise<boolean> {
  // $0 model → the $0 POV product (50361293): POV is a $0 BMI line, money on
  // Square. Legacy → the priced product (43746981), whose $5.00 lives in BMI's
  // OWN catalog — our POV_PRICE move to $4.99 does not reach it.
  const productId = zeroModel ? POV_ZERO_PRODUCT_ID : POV_PRODUCT_ID;
  try {
    const res = await fetch("/api/sms?endpoint=booking%2Fsell", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          productId,
          pageId: null,
          quantity,
          billId,
          dynamicLines: null,
          sellKind: 0,
        },
      ]),
    });
    if (!res.ok) {
      console.warn("[race.sellPov] failed:", res.status);
      return false;
    }
    console.log(
      "[race.sellPov] sold",
      quantity,
      `POV camera(s) (${zeroModel ? "$0" : "BMI-priced"} product ${productId}) on bill`,
      billId,
    );
    return true;
  } catch (err) {
    console.warn("[race.sellPov] error (non-fatal):", err);
    return false;
  }
}

/**
 * Append a memo to the BMI bill (package disclaimer trail). orderId is a 17-digit
 * bigint — raw-text injection only (never Number()/JSON.stringify on it). The
 * memo string is JSON-escaped. Non-fatal. Mirrors v1 `booking/memo`.
 */
async function writeBillMemo(billId: string, memo: string): Promise<void> {
  try {
    const body = `{"orderId":${billId},"memo":${JSON.stringify(memo)}}`;
    const res = await fetch(`/api/bmi?${new URLSearchParams({ endpoint: "booking/memo" })}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) console.warn("[race.writeBillMemo] failed:", res.status);
  } catch (err) {
    console.warn("[race.writeBillMemo] error (non-fatal):", err);
  }
}

// ── internal: addon booking via BMI (re-probes dayplanner for proposal) ─

async function bookAddon(
  billId: string,
  addon: RaceItem["addons"][number],
): Promise<{ booked: boolean; bmiLineId: string | null }> {
  try {
    const proposal = await probeAddonSlot(addon.id, addon.qty, addon.selectedTime!);
    if (!proposal) {
      console.warn("[race.bookAddon] slot no longer available:", addon.id, addon.selectedTime);
      return { booked: false, bmiLineId: null };
    }

    const result = await bmiAdapter.bookHeat({
      productId: addon.id,
      quantity: addon.qty,
      proposal,
      orderId: billId,
    });

    console.log("[race.bookAddon] booked", addon.id, "lineId:", result.billLineId);
    return { booked: true, bmiLineId: result.billLineId };
  } catch (err) {
    console.warn("[race.bookAddon] error (non-fatal):", addon.id, err);
    return { booked: false, bmiLineId: null };
  }
}

async function probeAddonSlot(
  productId: string,
  quantity: number,
  selectedTime: string,
): Promise<BmiProposal | null> {
  const res = await fetch("/api/sms?endpoint=dayplanner%2Fdayplanner", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      productId,
      pageId: ADDON_PAGE_ID,
      quantity,
      dynamicLines: null,
      date: selectedTime,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  for (const p of data.proposals ?? []) {
    const block = p.blocks?.[0]?.block;
    if (block?.start === selectedTime) {
      return p as BmiProposal;
    }
  }
  return null;
}

// ── internal: ensure party member has a bmiPersonId ─────────────────────

async function ensurePersonId(
  member: PartyMember,
  session: BookingSession,
  dispatch: Dispatch<Action>,
): Promise<string | null> {
  if (member.bmiPersonId) return member.bmiPersonId;
  if (!member.isNewRacer) return null; // returning racers without personId — skip

  // For new racers, create a BMI person from the billing contact
  const contact = session.contact;
  if (!contact.firstName || !contact.email || !contact.phone) return null;

  try {
    const { rawPersonId } = await bmiAdapter.createPerson({
      firstName: member.firstName,
      lastName: member.lastName ?? contact.lastName ?? "",
      email: contact.email,
      phone: contact.phone,
    });
    dispatch({
      type: "updatePartyMember",
      id: member.id,
      patch: { bmiPersonId: rawPersonId },
    });
    return rawPersonId;
  } catch (err) {
    console.warn("[race.ensurePersonId] createPerson failed (non-fatal):", err);
    return null;
  }
}

// ── internal: race-products lookups (imports hoisted; used above) ───────

import {
  bmiBookingTarget,
  getRaceProductById,
  isQualifiedForTier,
  resolveBuildPair,
  singleRaceProductsOnTrack,
} from "./race-products";

// ── internal: find a proposal matching a heat's start time ──────────────

function normalizeIso(s: string): string {
  return s.replace(/Z$/, "").replace(/\.\d{3}$/, "");
}

/**
 * Convert a naive center-local (America/New_York) wall-clock timestamp like
 * "2026-06-23T17:24:00" to true epoch ms. BMI returns heat times WITHOUT a
 * timezone, and this code runs server-side in UTC, so a naive `Date.parse`
 * would be off by the ET offset — fine for relative gap math, wrong for the
 * "within 60 min of now" override. Intl-based, no dependency, DST-correct.
 */
function centerWallClockToEpochMs(naiveIso: string): number {
  const guessUtc = Date.parse(naiveIso.replace(/Z$/, "") + "Z");
  if (!Number.isFinite(guessUtc)) return NaN;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(guessUtc));
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
  const renderedAsUtc = Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second);
  return guessUtc - (renderedAsUtc - guessUtc);
}

/**
 * Authoritative server-side guard: per-racer tier qualification (see the
 * inline block below) + config restriction rules (race-restriction-rules.ts).
 * Mirrors the client-side filters in RaceProductStep / RacerSelectorModal /
 * RaceHeatPickerStep so a stale client or a direct API call can't slip an
 * unqualified racer or a restricted heat (e.g. back-to-back Mega Pro) onto
 * the bill. Throws when the heat is blocked; no-op otherwise. `availability`
 * is the SAME response the caller just fetched for this heat's product, so
 * its freeSpots is the live global occupancy signal.
 */
async function assertHeatBookable(
  session: BookingSession,
  heat: RaceHeatAssignment,
  availability: BmiAvailabilityResponse,
  date: string | null | undefined,
): Promise<void> {
  if (!heat.heatId) return;
  const product = heat.productId ? getRaceProductById(heat.productId) : null;
  const tier = heat.tier ?? product?.tier;
  const track = heat.track ?? product?.track ?? null;
  if (!tier || !track) return;

  const toBlocks = (av: BmiAvailabilityResponse): RestrictionBlock[] =>
    av.proposals
      .map((p) => p.blocks?.[0]?.block)
      .filter((b): b is BmiBlock => !!b)
      .map((b) => ({
        startMs: centerWallClockToEpochMs(b.start),
        freeSpots: b.freeSpots,
        capacity: b.capacity,
      }));

  const productBlocks = toBlocks(availability);

  // Express-lane eligibility — mirrors RaceHeatPickerStep's allReturningHaveWaivers:
  // no new racer in the heat's category AND every returning racer has a valid waiver.
  const category = heat.category ?? product?.category ?? "adult";

  // Personal tier-qualification guard — mirrors the product filter + racer
  // selector so a stale client can't put an unqualified racer on an
  // Intermediate/Pro heat (2026-07-30 incident, bill 63000000006631238: a
  // "Qualified Junior Pro" substring-matched "pro" and booked adult Pro).
  // Scope: catalog products only (single races + same-tier 3-packs). Package
  // heats (Rookie Pack / Ultimate Qualifier) resolve no catalog product and
  // combo legs are itinerary-driven — both legitimately book above a racer's
  // current tier, so they're exempt. Judged on the session's memberships (the
  // same verified-lookup data the client gates on).
  if (product && tier !== "starter" && !session.comboSpecialId && heat.assignedTo) {
    const member = session.party.find((m) => m.id === heat.assignedTo);
    if (member) {
      const qualified =
        !member.isNewRacer && isQualifiedForTier(member.memberships ?? [], category, tier);
      if (!qualified) {
        const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
        throw new Error(
          `${member.firstName || "A racer"} isn't qualified for ${tierLabel} races yet — please pick a race at their level.`,
        );
      }
    }
  }
  const anyNewInCategory = session.party.some(
    (m) => (m.category ?? "adult") === category && m.isNewRacer,
  );
  const expressEligible =
    !anyNewInCategory &&
    session.party.filter((m) => !m.isNewRacer).every((m) => m.waiverValid === true);

  // Cross-tier occupancy for the rules that see past the candidate's own tier
  // (junior back-to-back + two-per-hour, the adult-Starter room reserve). An
  // occupied heat is tier-exclusive in BMI availability, so union every OTHER
  // single-race product on the candidate's track onto its own blocks. Adult
  // Starter candidates skip the fan-out — no cross-tier rule guards them.
  // Best-effort: a sibling fetch failure leaves that product out of the union
  // (rules degrade toward the candidate's own tier).
  let categoryTrackBlocks = productBlocks;
  let trackAllTierBlocks: TrackTierBlock[] | undefined;
  const isAdultStarter = tier === "starter" && category === "adult";
  if (!isAdultStarter && product && date) {
    const siblings = singleRaceProductsOnTrack(track, product.schedule, product.racerType).filter(
      (sib) => sib.productId !== product.productId,
    );
    const fetched = await Promise.all(
      siblings.map(async (sib) => {
        const sibTarget = bmiBookingTarget(sib.productId, {
          category: sib.category,
          tier: sib.tier,
          track: sib.track,
          withLicense: false,
        });
        try {
          const sibAv = await bmiAdapter.getAvailability({
            date,
            productId: sibTarget.productId,
            pageId: sibTarget.pageId,
            quantity: 1,
          });
          return { sib, blocks: toBlocks(sibAv) };
        } catch {
          return null; // best-effort — see note above
        }
      }),
    );
    trackAllTierBlocks = productBlocks.map((b) => ({ ...b, adultStarter: false }));
    const juniorSiblingBlocks: RestrictionBlock[] = [];
    for (const f of fetched) {
      if (!f) continue;
      const adultStarter = f.sib.tier === "starter" && f.sib.category === "adult";
      trackAllTierBlocks.push(...f.blocks.map((b) => ({ ...b, adultStarter })));
      if (category === "junior" && f.sib.category === "junior") {
        juniorSiblingBlocks.push(...f.blocks);
      }
    }
    if (juniorSiblingBlocks.length)
      categoryTrackBlocks = [...productBlocks, ...juniorSiblingBlocks];
  }

  const verdict = evaluateRaceRestrictions({
    tier,
    category,
    track,
    candidateStartMs: centerWallClockToEpochMs(heat.heatId),
    candidateStartLocal: heat.heatId, // heatId IS the naive wall-clock start string
    nowMs: Date.now(),
    productBlocks,
    categoryTrackBlocks,
    trackAllTierBlocks,
    expressEligible,
    isComboBooking: !!session.comboSpecialId,
  });
  if (verdict.blocked) throw new Error(verdict.reason ?? "That heat can't be booked.");
}

function findProposalForHeat(
  proposals: Array<{ blocks?: Array<{ block?: { start: string } }> }>,
  heatStart: string,
): BmiProposal | null {
  const target = normalizeIso(heatStart);
  for (const p of proposals) {
    const block = p.blocks?.[0]?.block;
    if (block && normalizeIso(block.start) === target) return p as BmiProposal;
  }
  return null;
}
