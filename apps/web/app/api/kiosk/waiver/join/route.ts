import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import redis from "@/lib/redis";
import { makeDisplayName } from "@/lib/display-name";
import { clientKeyForLocation } from "~/features/daily-events/service";
import { upsertJoin, setJoinAttachStatus } from "~/features/kiosk/data/kiosk-waiver-joins-db";
import { registerProjectPersonServer } from "~/features/kiosk/waiver/bmi-attach";
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
  kioskId: z.string().trim().max(64).optional(),
});

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
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
    if (clientKey) {
      try {
        const result = await registerProjectPersonServer({
          clientKey,
          projectId,
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
            `${result.status}: ${result.body.slice(0, 300)}`,
          ).catch(() => {});
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
