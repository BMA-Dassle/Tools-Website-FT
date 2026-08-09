import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import redis from "@/lib/redis";
import { makeDisplayName } from "@/lib/display-name";
import { clientKeyForLocation } from "~/features/daily-events/service";
import { upsertJoin, setJoinAttachStatus } from "~/features/kiosk/data/kiosk-waiver-joins-db";
import { registerProjectPersonServer } from "~/features/kiosk/waiver/bmi-attach";
import { resolveAttachOrderId } from "~/features/kiosk/waiver/attach-order-id";
import { kioskWaiverBmiAttachEnabled } from "~/features/kiosk/flags";
import { CENTER_TO_BMI_LOCATION_IDS, isValidCenter } from "~/features/kiosk/waiver/locations";
import { rosterCacheKey, personValidCacheKey } from "~/features/kiosk/waiver/cache";

export const dynamic = "force-dynamic";

/**
 * POST /api/kiosk/waiver/join — a guest (account + valid waiver, just handled
 * on the kiosk) joins a reservation.
 *
 * Sequence is the house hard rule: 1) persist the join to Neon FIRST —
 * unconditional, before any external call; 2) attach to BMI as a
 * projectPerson only behind KIOSK_WAIVER_BMI_ATTACH (probe-gated — see
 * bmi-attach.ts); 3) bust the roster caches. A BMI failure is still ok:true —
 * the guest experience never depends on the external API, and the roster
 * route unions the Neon row in.
 */

const bodySchema = z.object({
  center: z.string(),
  locationId: z.number().int(),
  projectId: z.string().regex(/^\d+$/),
  personId: z.string().regex(/^\d+$/),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().default(""),
  // NULLISH, not optional. The at-home /waiver flow has no kiosk and sends an
  // explicit `kioskId: null` (useReservationJoinAttach defaults it to null, and
  // JSON.stringify keeps nulls) — and zod's .optional() accepts `undefined` but
  // REJECTS `null`, so every at-home join 400'd on body validation before the
  // Neon insert. That is why kiosk_waiver_joins had zero rows table-wide while
  // guests were being told "we have them saved to your reservation": the only
  // other caller, the kiosk group-waiver flow, sends a real string kioskId and
  // is flag-OFF by default, so nothing ever exercised the working path.
  // (Proven live 2026-08-07: two signatures, two 400s, zero rows.)
  kioskId: z.string().trim().max(64).nullish(),
});

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch (err) {
    // LOUD. A silent 400 here is invisible to the guest (the UI still says
    // "saved to your reservation") and invisible in Neon (no row is written),
    // so the only trace was the status code in Vercel's log.
    console.error(
      "[kiosk-waiver-join] REJECTED body — nobody was attached to the reservation:",
      err instanceof z.ZodError ? JSON.stringify(err.issues) : err,
    );
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }
  const { center, locationId, projectId, personId, firstName, lastName, kioskId } = parsed;
  if (!isValidCenter(center) || !CENTER_TO_BMI_LOCATION_IDS[center].includes(locationId)) {
    return NextResponse.json({ ok: false, error: "Invalid center/location" }, { status: 400 });
  }

  const displayName = makeDisplayName(firstName, lastName);

  // 1) Neon first — the durable record; never gated on BMI.
  let alreadyAttached = false;
  try {
    const row = await upsertJoin({
      projectId,
      locationId,
      personId,
      displayName,
      firstName,
      lastName,
      kioskId: kioskId ?? null,
    });
    alreadyAttached = row.bmiAttachStatus === "attached";
  } catch (error) {
    console.error("[kiosk-waiver] join persist failed:", error);
    return NextResponse.json({ ok: false, error: "Could not save" }, { status: 500 });
  }

  // 2) BMI attach — probe-gated, idempotent (double-tap safe), non-fatal.
  let attach: "bmi" | "neon-only" = "neon-only";
  if (alreadyAttached) {
    attach = "bmi";
  } else if (kioskWaiverBmiAttachEnabled()) {
    const clientKey = clientKeyForLocation(locationId);
    // THE bug the A3 probe found: this route holds a projectId, but the
    // public-booking endpoint's `orderId` is a BILL id. Passing the projectId made
    // BMI look up `billId + 1` and answer
    //   200 {"success":false,"errorMessage":"Cannot find the reservation for bill …"}
    // The kiosk CHECK-IN flow always got this right — it passes a billId — so the
    // conversion belongs here, at the caller that has the wrong id, not inside the
    // shared function where it would have broken check-in.
    //
    // …and the SECOND half of that bug, live until 2026-08-09: the conversion was
    // pure arithmetic, which only ever described OUR OWN bookings. A group
    // function's project is Office-created and its bill lives in another series,
    // so projectId−1 named nothing and every group-function signer failed. The
    // resolver now VERIFIES the id against the order API instead of assuming it.
    // See ~/features/kiosk/waiver/attach-order-id.
    if (!clientKey) {
      await setJoinAttachStatus(
        projectId,
        personId,
        "failed",
        `no clientKey for locationId ${locationId}`,
      ).catch(() => {});
    } else {
      try {
        const resolved = await resolveAttachOrderId({ clientKey, projectId });
        if (!resolved) {
          // Previously this branch wrote NO status at all, leaving the row
          // 'pending' forever — a failure that showed up in no query and no
          // sweep. It is a failure; it is recorded as one.
          await setJoinAttachStatus(
            projectId,
            personId,
            "failed",
            `no public-booking order resolves for project ${projectId}`,
          ).catch(() => {});
        } else {
          const result = await registerProjectPersonServer({
            clientKey,
            orderId: resolved.orderId,
            personId,
            firstName,
            lastName,
          });
          if (result.ok) {
            attach = "bmi";
            await setJoinAttachStatus(projectId, personId, "attached").catch(() => {});
          } else {
            await setJoinAttachStatus(
              projectId,
              personId,
              "failed",
              `${result.status} (orderId ${resolved.orderId} via ${resolved.source}): ` +
                result.body.slice(0, 260),
            ).catch(() => {});
          }
        }
      } catch (error) {
        await setJoinAttachStatus(
          projectId,
          personId,
          "failed",
          error instanceof Error ? error.message : "attach error",
        ).catch(() => {});
      }
    }
  } else {
    await setJoinAttachStatus(projectId, personId, "skipped").catch(() => {});
  }

  // 3) Bust the roster caches so the next refetch shows the new signer.
  redis.del(rosterCacheKey(projectId)).catch(() => {});
  redis.del(personValidCacheKey(personId)).catch(() => {});

  return NextResponse.json({ ok: true, attach, displayName });
}
