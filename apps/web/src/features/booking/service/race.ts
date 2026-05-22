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
import type { Dispatch } from "react";
import type { Action } from "../state/machine";
import type { BookingSession, PartyMember, RaceItem } from "../state/types";
import { bmiAdapter, type BmiProposal } from "../data/bmi";

const LICENSE_PRODUCT_ID = "43473520";
const POV_PRODUCT_ID = "43746981";
const ADDON_PAGE_ID = "42730172";

// ── bookHeatsOnAdvance: book unbooked heats when leaving heat picker ────

export async function bookHeatsOnAdvance(
  session: BookingSession,
  item: RaceItem,
  dispatch: Dispatch<Action>,
): Promise<void> {
  let billId = session.bmiBillId;

  for (let i = 0; i < item.heats.length; i++) {
    const heat = item.heats[i];
    if (heat.bmiLineId) continue;
    if (!heat.heatId || !heat.productId) continue;

    const personId = heat.assignedTo
      ? (session.party.find((m) => m.id === heat.assignedTo)?.bmiPersonId ?? null)
      : null;

    const availability = await bmiAdapter.getAvailability({
      date: item.date!,
      productId: heat.productId,
      pageId: resolvePageId(heat.productId),
      quantity: 1,
    });
    const matchingProposal = findProposalForHeat(availability.proposals, heat.heatId);
    if (!matchingProposal) {
      throw new Error(`Heat at ${heat.heatId} is no longer available`);
    }

    const result = await bmiAdapter.bookHeat({
      productId: heat.productId,
      quantity: 1,
      proposal: matchingProposal,
      orderId: billId,
      personId,
    });

    if (!billId) {
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
  let billId = session.bmiBillId;

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
    const availability = await bmiAdapter.getAvailability({
      date: item.date!,
      productId: heat.productId,
      pageId: resolvePageId(heat.productId),
      quantity: 1,
    });
    const matchingProposal = findProposalForHeat(availability.proposals, heat.heatId);
    if (!matchingProposal) {
      throw new Error(`Heat at ${heat.heatId} no longer available for product ${heat.productId}`);
    }

    const result = await bmiAdapter.bookHeat({
      productId: heat.productId,
      quantity: 1,
      proposal: matchingProposal,
      orderId: billId,
      personId,
    });

    if (!billId) {
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

  // 2. Sell license for new racers (non-fatal)
  const newRacerCount = session.party.filter((m) => m.isNewRacer).length;
  let licenseSold = false;
  if (newRacerCount > 0) {
    licenseSold = await sellLicense(billId, newRacerCount);
  }

  // 3. Sell POV cameras (non-fatal)
  let povSold = false;
  if (item.povQuantity > 0) {
    povSold = await sellPov(billId, item.povQuantity);
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

export async function cancelRaceOrder(billId: string): Promise<void> {
  try {
    await fetch(`/api/bmi?endpoint=bill/${billId}/cancel`, { method: "DELETE" });
  } catch {
    console.warn("[race.cancel] bill cancel failed (non-fatal):", billId);
  }
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

// ── internal: POV sell via SMS proxy (different endpoint than BMI!) ──────

async function sellPov(billId: string, quantity: number): Promise<boolean> {
  try {
    const res = await fetch("/api/sms?endpoint=booking%2Fsell", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          productId: POV_PRODUCT_ID,
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
    console.log("[race.sellPov] sold", quantity, "POV camera(s) on bill", billId);
    return true;
  } catch (err) {
    console.warn("[race.sellPov] error (non-fatal):", err);
    return false;
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

// ── internal: resolve pageId for a BMI productId ────────────────────────

import { getRaceProductById } from "./race-products";

function resolvePageId(productId: string): string {
  const product = getRaceProductById(productId);
  if (product) return product.pageId;
  // Fallback: use the product's own ID as page ID (some addon products do this)
  return productId;
}

// ── internal: find a proposal matching a heat's start time ──────────────

function normalizeIso(s: string): string {
  return s.replace(/Z$/, "").replace(/\.\d{3}$/, "");
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
