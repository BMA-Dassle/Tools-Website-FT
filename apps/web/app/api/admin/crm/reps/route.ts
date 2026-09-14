import { z } from "zod";
import { canonicalizePhone } from "@/lib/participant-contact";
import { writeAudit } from "~/features/crm/core/data/audit-db";
import { CrmHttpError, withCrmRoute } from "~/features/crm/core/http";
import { listReps } from "~/features/crm/reps";
import { patchRepContact, repUsingDid } from "~/features/crm/reps/data/reps-db";
import { RepContactPatchSchema } from "~/features/crm/reps/schemas";

/**
 * /api/admin/crm/reps — the roster's CONTACT ROUTING.
 *
 *   GET             → every rep with their 3CX extension and texting DID
 *   PATCH {repId,…} → set one rep's extension and/or DID   (director only)
 *
 * Owner, 2026-09-14: "Need a spot to enter 3cx ext and did for sms that we will
 * use with voxtelesys." Both columns have been read since PR1 — `dial.ts`
 * refuses a call without an extension, `consent.ts` refuses a text without a
 * DID, and the inbound webhook's allow-list is the union of active DIDs — so
 * Calls and outbound SMS were dark for want of this form and nothing else.
 *
 * DIRECTOR ONLY, and audited. A DID decides which guest conversations land on
 * whose screen and which inbound numbers the webhook will accept at all;
 * getting one wrong silently reroutes a guest's replies.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the screen needs; never the whole rep row. */
function contactRows(reps: Awaited<ReturnType<typeof listReps>>) {
  return reps
    .filter((r) => r.active)
    .map((r) => ({
      id: r.id,
      slug: r.slug,
      displayName: r.displayName,
      initials: r.initials,
      role: r.role,
      threecxExtension: r.threecxExtension,
      voxDid: r.voxDid,
    }));
}

export const GET = withCrmRoute(z.object({}), async () => ({
  reps: contactRows(await listReps()),
}));

export const PATCH = withCrmRoute(
  RepContactPatchSchema,
  async ({ input, user }) => {
    const reps = await listReps({ includeInactive: true });
    const rep = reps.find((r) => r.id === input.repId);
    if (!rep) throw new CrmHttpError(404, "rep_not_found");

    /**
     * A DID IS STORED E.164 OR NOT AT ALL.
     *
     * `sms/service/dids.ts` canonicalises before it compares, so "239-555-1234"
     * typed here would build an allow-list entry that never matches the `to`
     * on an inbound webhook — the number would look configured and silently
     * receive nothing. Normalising at the door means the column and the
     * comparison always agree.
     */
    let voxDid: string | null | undefined;
    if (input.voxDid !== undefined) {
      const raw = (input.voxDid ?? "").trim();
      if (!raw) voxDid = null;
      else {
        const e164 = canonicalizePhone(raw);
        if (!e164) throw new CrmHttpError(400, "vox_did_not_a_phone_number");
        // Two reps on one number puts their guests in one thread with no way
        // to tell whose reply is whose. A SHARED number belongs to the Guest
        // Services bucket rep, which every agent already acts as.
        const clash = await repUsingDid(e164, rep.id);
        if (clash) {
          // The message IS the error string here — `CrmHttpError`'s third
          // argument is an Office prompt, not prose.
          throw new CrmHttpError(
            409,
            `${clash.displayName} already texts from that number — a shared number belongs on the Guest Services row, which every agent acts as`,
          );
        }
        voxDid = e164;
      }
    }

    let threecxExtension: string | null | undefined;
    if (input.threecxExtension !== undefined) {
      const raw = (input.threecxExtension ?? "").trim();
      // Digits only: the extension is compared to a 3CX `dn` verbatim
      // (`calls/service/match.ts`), and a stray space or "x" would never match.
      threecxExtension = raw ? raw.replace(/\D/g, "") : null;
      if (raw && !threecxExtension) throw new CrmHttpError(400, "extension_not_a_number");
    }

    const after = await patchRepContact(rep.id, { threecxExtension, voxDid });
    if (!after) throw new CrmHttpError(500, "rep_not_updated");

    await writeAudit({
      entity: "rep_contact",
      entityId: rep.slug,
      action: "update",
      actorEmail: user.email,
      before: { threecxExtension: rep.threecxExtension, voxDid: rep.voxDid },
      after: { threecxExtension: after.threecxExtension, voxDid: after.voxDid },
    });

    return { reps: contactRows(await listReps()) };
  },
  { director: true },
);
