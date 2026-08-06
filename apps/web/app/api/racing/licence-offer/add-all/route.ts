import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { codeForPersonId } from "~/features/kiosk/license/code-cache";
import { lookupMemberMatches } from "~/features/kiosk/license/lookup.server";
import { issueLicencePass } from "~/features/racing/wallet/licence-pass";
import { buildLicenceMeta } from "~/features/racing/wallet/licence-meta";
import { passUrls } from "~/lib/api/passkit";
import {
  buildPkpassesBundle,
  fetchPkpass,
  PKPASSES_CONTENT_TYPE,
  type BundleEntry,
} from "~/features/racing/wallet/pkpasses";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/racing/licence-offer/add-all?billId=… — every racer on the booking,
 * added to this phone in one tap.
 *
 * APPLE ONLY, and not by preference. Apple's `.pkpasses` bundle is just a ZIP of
 * signed passes, so we can assemble one from passes PassKit already issued.
 * Google's equivalent needs several objects inside ONE signed JWT, which only
 * the issuer can mint — PassKit hands us a per-pass `.gpay` link and no way to
 * merge them. So the button is offered on Apple, and Google users add each
 * racer from their row.
 *
 * A PARENT'S PHONE IS THE POINT. Four kids' licences on one device is the case
 * this exists for; each racer can still add their own from the QR on their row.
 *
 * BILLING: this ISSUES every pass in the party — a tap on "add all" is four
 * monthly records, not one. That is the deal the guest is making by tapping it,
 * and the same lazy rule as everywhere else (nothing is created by rendering
 * the page). The reconcile sweep deletes any of them that never reach a device.
 *
 * Possession of the billId is the auth, the same bar the confirmation page
 * applies, and every personId must actually be on that booking.
 */
interface BookingRacer {
  personId?: string | null;
  racerName?: string | null;
  heatStart?: string | null;
  track?: string | null;
  heatName?: string | null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const billId = (new URL(req.url).searchParams.get("billId") || "").trim();
  if (!/^\d+$/.test(billId)) {
    return NextResponse.json({ error: "billId required" }, { status: 400 });
  }

  let record: { racers?: BookingRacer[] } | null = null;
  try {
    const raw = await redis.get(`bookingrecord:${billId}`);
    record = raw ? JSON.parse(raw) : null;
  } catch {
    record = null;
  }
  if (!record?.racers?.length) {
    return NextResponse.json({ error: "no racers on this booking" }, { status: 404 });
  }

  // One entry per PERSON — a racer booked into two heats appears twice and must
  // not be handed two copies of the same licence.
  const seen = new Set<string>();
  const racers: BookingRacer[] = [];
  for (const r of record.racers) {
    const pid = String(r?.personId ?? "").trim();
    if (!/^\d+$/.test(pid) || seen.has(pid)) continue;
    seen.add(pid);
    racers.push(r);
  }

  // In parallel: a party of six should not be six sequential Office round trips
  // plus six issues plus six downloads while someone holds a phone.
  const results = await Promise.all(
    racers.map(async (r) => {
      const personId = String(r.personId ?? "").trim();
      try {
        let code = await codeForPersonId(personId).catch(() => null);
        if (!code) {
          const matches = await lookupMemberMatches(personId).catch(() => null);
          code = matches?.[0]?.loginCode || null;
        }
        if (!code) return null; // no BMI tag — nothing to put in a barcode

        const meta = await buildLicenceMeta({
          personId,
          code,
          fullName: String(r.racerName ?? "").trim() || "Racer",
          heat: r.heatStart
            ? {
                scheduledStart: String(r.heatStart),
                track: String(r.track ?? ""),
                heatNumber: Number(String(r.heatName ?? "").replace(/\D+/g, "")) || null,
              }
            : null,
        });

        const issued = await issueLicencePass({ personId, meta });
        if (!issued.ok || !issued.memberId) return null;

        // Fetch the signed pass, WAITING for PassKit to finish rendering it.
        // We issued it moments ago, and until the render completes PassKit
        // answers 200 with an HTML page — so `res.ok` proves nothing and an
        // unchecked read puts a web page in the bundle. iOS then refuses the
        // whole thing with "your pass cannot be installed at this time",
        // naming none of the four. Bytes are copied verbatim: each pass carries
        // its own signature and re-packing would invalidate it.
        const bytes = await fetchPkpass(passUrls(issued.memberId).apple);
        if (!bytes) return null;

        return { name: `${personId}.pkpass`, bytes } as BundleEntry;
      } catch {
        return null;
      }
    }),
  );

  const entries: BundleEntry[] = results.filter((e): e is BundleEntry => e !== null);
  if (entries.length === 0) {
    return NextResponse.json({ error: "no passes could be built" }, { status: 502 });
  }

  const bundle = buildPkpassesBundle(entries);
  return new NextResponse(new Uint8Array(bundle), {
    headers: {
      "Content-Type": PKPASSES_CONTENT_TYPE,
      "Content-Disposition": 'attachment; filename="fasttrax-licences.pkpasses"',
      "Content-Length": String(bundle.length),
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
