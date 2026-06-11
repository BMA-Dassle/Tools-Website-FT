/**
 * Server-side BMI bill rebuild — re-book a system-cancelled race booking's heats
 * into a FRESH bill, without re-charging (the customer already paid on Square).
 *
 * Used by the race-cancel-watch cron when BMI auto-cancels a paid hold and strips
 * its products. We can't reuse the client booking path (bmiAdapter fetches the
 * relative `/api/bmi`), so we drive the SAME proxy via absolute URLs — which
 * reuses BMI auth + raw-id handling AND lands every call in the proxy's
 * `bmi:api:log`. On top of that we capture each request/response here so the
 * caller can persist the full sequence as evidence for BMI.
 *
 * SAFETY: every BMI id (orderId / personId) is raw-string-injected, never passed
 * through JSON.stringify (17-digit bigints). The caller gates on system-cancel +
 * future + paid + not-already-rebuilt; this function additionally verifies the
 * rebuilt bill actually has products whose heat times match before reporting ok.
 */
import { stringifyWithRawIds } from "@ft/db";
import { bmiBookingTarget } from "./race-products";

export interface RebuildRacerHeat {
  productId: string;
  track: string | null;
  heatStart: string;
  personId: string | null;
  firstName: string;
  lastName?: string;
}

export interface RebuildContact {
  firstName: string;
  lastName?: string;
  email: string;
  phone: string;
}

export interface ApiCall {
  step: string;
  method: string;
  endpoint: string;
  requestBody?: string;
  status: number;
  responseBody: string;
  ms: number;
}

export interface RebuildResult {
  ok: boolean;
  oldBillId: string;
  newBillId: string | null;
  reservationNumber: string | null;
  bookedHeats: number;
  error: string | null;
  apiCalls: ApiCall[];
}

/** Normalize a BMI ISO to ET wall-clock minute for heat matching (mirrors
 *  race.ts normalizeIso): strip Z / tz offset / seconds. */
function normMinute(iso: string): string {
  return iso
    .replace(/Z$/, "")
    .replace(/[+-]\d{2}:\d{2}$/, "")
    .slice(0, 16);
}

interface ProposalBlock {
  productLineIds?: unknown[];
  block: { start: string; resourceId?: string | number };
}
interface Proposal {
  blocks: ProposalBlock[];
  productLineId?: string | null;
}

function findProposalForHeat(proposals: Proposal[], heatStart: string): Proposal | null {
  const target = normMinute(heatStart);
  for (const p of proposals) {
    const start = p.blocks?.[0]?.block?.start;
    if (start && normMinute(start) === target) return p;
  }
  return null;
}

/**
 * Rebuild the heats of `oldBillId` into a fresh BMI bill via the `/api/bmi`
 * proxy at `origin`. Returns the new bill id (or null + error) plus the full API
 * call log. Does NOT charge — confirms the new bill as a $0 credit (the Square
 * payment already settled the money on the old bill).
 */
export async function rebuildRaceBill(params: {
  origin: string;
  clientKey: string;
  oldBillId: string;
  date: string; // YYYY-MM-DD
  heats: RebuildRacerHeat[];
  contact: RebuildContact;
  pandoraLocationId?: string;
  pandoraKey?: string;
  /** When true: run availability + proposal matching only (read-only) and report
   *  whether every heat can be re-booked — never books/registers/confirms. For
   *  verifying the matching logic against a real booking without side effects. */
  dryRun?: boolean;
}): Promise<RebuildResult> {
  const { origin, clientKey, oldBillId, date, heats, contact, dryRun } = params;
  const apiCalls: ApiCall[] = [];
  const result: RebuildResult = {
    ok: false,
    oldBillId,
    newBillId: null,
    reservationNumber: null,
    bookedHeats: 0,
    error: null,
    apiCalls,
  };

  const proxy = async (
    step: string,
    method: "GET" | "POST",
    endpoint: string,
    body?: string,
    extraParams?: Record<string, string>,
  ): Promise<{ status: number; text: string }> => {
    const qs = new URLSearchParams({ endpoint, clientKey, ...(extraParams ?? {}) });
    const url = `${origin}/api/bmi?${qs.toString()}`;
    const t0 = Date.now();
    let status = 0;
    let text = "";
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body } : {}),
        cache: "no-store",
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      text = err instanceof Error ? err.message : "fetch error";
    }
    apiCalls.push({
      step,
      method,
      endpoint,
      requestBody: body ? body.slice(0, 1000) : undefined,
      status,
      responseBody: text.slice(0, 1500),
      ms: Date.now() - t0,
    });
    return { status, text };
  };

  if (!heats.length) {
    result.error = "no heats to rebuild";
    return result;
  }

  try {
    let newBillId: string | null = null;
    // Track which racer's FIRST heat gets the +license build product (new racers
    // only — they have no personId). Mirrors licenseHeatIndices.
    const firstHeatSeen = new Set<string>();

    for (const heat of heats) {
      if (!heat.heatStart || !heat.productId) continue;
      const racerKey = heat.personId ?? `${heat.firstName}:${heat.track}`;
      const isNewRacer = !heat.personId;
      const withLicense = isNewRacer && !firstHeatSeen.has(racerKey);
      firstHeatSeen.add(racerKey);

      const target = bmiBookingTarget(heat.productId, { withLicense, track: heat.track });

      // 1) Availability for the product on the date.
      const availPayload = JSON.stringify({
        ProductId: Number(target.productId),
        PageId: Number(target.pageId),
        Quantity: 1,
        OrderId: null,
        PersonId: null,
        DynamicLines: [],
      });
      const avail = await proxy("availability", "POST", "availability", availPayload, { date });
      if (avail.status >= 400) {
        result.error = `availability ${avail.status} for product ${heat.productId}`;
        return result;
      }
      let availData: { proposals?: Proposal[]; Proposals?: Proposal[] };
      try {
        availData = JSON.parse(avail.text);
      } catch {
        result.error = "availability returned non-JSON";
        return result;
      }
      const proposals = availData.proposals ?? availData.Proposals ?? [];
      const proposal = findProposalForHeat(proposals, heat.heatStart);
      if (!proposal) {
        result.error = `heat ${heat.heatStart} no longer available (slot filled or past)`;
        return result;
      }

      // Read-only verification: proposal found for this heat. Don't book.
      if (dryRun) {
        result.bookedHeats++;
        continue;
      }

      // 2) Book the heat onto the (new) bill — raw-inject orderId + personId.
      const bookPayload: Record<string, unknown> = {
        productId: String(target.productId),
        quantity: 1,
        resourceId: Number(proposal.blocks[0]?.block?.resourceId) || -1,
        proposal: {
          blocks: proposal.blocks.map((pb) => ({
            productLineIds: pb.productLineIds || [],
            block: { ...pb.block, resourceId: Number(pb.block?.resourceId) || -1 },
          })),
          productLineId: proposal.productLineId ?? null,
        },
      };
      const rawIds: Record<string, string> = {};
      if (newBillId) rawIds.orderId = newBillId;
      if (heat.personId) rawIds.personId = heat.personId;
      const bookBody = stringifyWithRawIds(bookPayload, { rawIds });
      const book = await proxy("booking/book", "POST", "booking/book", bookBody);
      if (book.status >= 400) {
        result.error = `booking/book ${book.status}: ${book.text.slice(0, 120)}`;
        return result;
      }
      // Extract the new orderId WITHOUT parsing (raw regex — bigint-safe).
      const m = book.text.match(/"orderId"\s*:\s*(\d+)/);
      if (!m) {
        result.error = "booking/book returned no orderId";
        return result;
      }
      if (!newBillId) newBillId = m[1];
      result.bookedHeats++;
    }

    if (dryRun) {
      result.ok = result.bookedHeats === heats.length;
      result.error = `dryRun — matched ${result.bookedHeats}/${heats.length} heats (not booked)`;
      return result;
    }

    if (!newBillId) {
      result.error = "no heats booked";
      return result;
    }
    result.newBillId = newBillId;

    // 3) Attach contact + verified racers to the new bill (raw-id injection).
    const phone = (contact.phone || "").replace(/\D/g, "");
    const contactBody =
      `{"orderId":${newBillId},` +
      JSON.stringify({
        firstName: contact.firstName,
        lastName: contact.lastName ?? "",
        email: contact.email,
        phone,
      }).slice(1);
    await proxy("registerContactPerson", "POST", "person/registerContactPerson", contactBody);

    const seenPersons = new Set<string>();
    for (const heat of heats) {
      if (!heat.personId || seenPersons.has(heat.personId)) continue;
      seenPersons.add(heat.personId);
      const pBody =
        `{"personId":${heat.personId},"orderId":${newBillId},` +
        JSON.stringify({ firstName: heat.firstName, lastName: heat.lastName ?? "" }).slice(1);
      await proxy("registerProjectPerson", "POST", "person/registerProjectPerson", pBody);
    }

    // 4) Confirm the new bill as a $0 credit (money already on Square).
    const confirmBody = `{"id":"${crypto.randomUUID()}","paymentTime":"${new Date().toISOString()}","amount":0,"orderId":${newBillId},"depositKind":2}`;
    const confirm = await proxy("payment/confirm", "POST", "payment/confirm", confirmBody);
    if (confirm.status < 400) {
      const rn = confirm.text.match(/"reservationNumber"\s*:\s*"(W\d+)"/);
      if (rn) result.reservationNumber = rn[1];
    }

    // 5) Pandora state → -3 (Confirmation) so BMI doesn't re-auto-cancel.
    if (params.pandoraKey && params.pandoraLocationId) {
      const projectId = (BigInt(newBillId) + BigInt(1)).toString();
      const t0 = Date.now();
      let pStatus = 0;
      let pText = "";
      try {
        const pr = await fetch(
          "https://bma-pandora-api.azurewebsites.net/v2/bmi/reservation/state",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${params.pandoraKey}`,
            },
            body: JSON.stringify({
              locationID: params.pandoraLocationId,
              projectId,
              stateID: "-3",
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        pStatus = pr.status;
        pText = (await pr.text()).slice(0, 200);
      } catch (err) {
        pText = err instanceof Error ? err.message : "pandora error";
      }
      apiCalls.push({
        step: "pandora/state",
        method: "POST",
        endpoint: "v2/bmi/reservation/state",
        requestBody: `projectId=${projectId} stateID=-3`,
        status: pStatus,
        responseBody: pText,
        ms: Date.now() - t0,
      });
    }

    // 6) Verify-after — the new bill must have products whose heat times match
    //    the originals. Guards against a partial / wrong-heat rebuild reporting
    //    success.
    const verify = await proxy("verify/overview", "GET", `order/${newBillId}/overview`);
    let lineCount = 0;
    const starts = new Set<string>();
    try {
      const ov = JSON.parse(verify.text) as {
        lines?: Array<{
          scheduledTime?: { start?: string };
          schedules?: Array<{ start?: string }>;
        }>;
      };
      lineCount = (ov.lines || []).length;
      for (const l of ov.lines || []) {
        const s = l.scheduledTime?.start ?? l.schedules?.[0]?.start;
        if (s) starts.add(normMinute(s));
      }
    } catch {
      /* leave lineCount 0 → fails verification below */
    }
    const expected = new Set(heats.map((h) => normMinute(h.heatStart)));
    const allMatched = [...expected].every((e) => starts.has(e));
    if (lineCount > 0 && allMatched) {
      result.ok = true;
    } else {
      result.error = `verify failed: lines=${lineCount} matchedHeats=${allMatched} (expected ${[...expected].join(",")}, got ${[...starts].join(",")})`;
    }
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : "rebuild error";
    return result;
  }
}
