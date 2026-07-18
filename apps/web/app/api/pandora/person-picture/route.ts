import { NextRequest, NextResponse } from "next/server";
import {
  insertPersonPhoto,
  markPersonPhotoUploaded,
  bumpPersonPhotoAttempt,
  getPendingPersonPhotos,
} from "@/lib/person-photo-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/pandora/person-picture — kiosk waiver-time guest photo → BMI.
 *
 * Persist-first: the PNG lands in Neon (kiosk_person_photos) BEFORE the
 * Pandora attempt, so an upstream blip never loses a captured photo. One
 * inline Pandora attempt keeps the guest moving (the waiver screen isn't
 * blocked on retries); failures stay queued and GET ?sweep=1 retries them
 * (call it manually or from a cron).
 *
 * Pandora: POST /bmi/person/picture — multipart {locationID, personID,
 * picture(PNG ≤1MB)}. personID is a RAW BMI id string — never Number() it.
 */

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const MAX_PNG_BYTES = 1_000_000; // Pandora's documented 1MB cap

/** Kiosk location slug → Pandora/BMI location id (same map the state-flip
 *  calls use — racing lives at FastTrax, HeadPinz FM/Naples for the rest). */
const LOCATION_IDS: Record<string, string> = {
  fasttrax: "LAB52GY480CJF",
  headpinz: "TXBSQN0FEKQ11",
  naples: "PPTR5G2N0QXF7",
};

async function uploadToPandora(args: {
  locationId: string;
  personId: string;
  png: Buffer;
}): Promise<{ ok: boolean; detail: string }> {
  const pandoraKey = process.env.SWAGGER_ADMIN_KEY || "";
  const form = new FormData();
  form.append("locationID", args.locationId);
  form.append("personID", args.personId);
  form.append("picture", new Blob([new Uint8Array(args.png)], { type: "image/png" }), "photo.png");
  try {
    const res = await fetch(`${PANDORA_BASE}/bmi/person/picture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pandoraKey}` },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      message?: string;
    } | null;
    if (res.ok && data?.success !== false) return { ok: true, detail: "uploaded" };
    return { ok: false, detail: `HTTP ${res.status}${data?.message ? `: ${data.message}` : ""}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "fetch failed" };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      personId?: string;
      location?: string;
      pngBase64?: string;
    } | null;
    const personId = body?.personId?.trim();
    const locationId = LOCATION_IDS[body?.location ?? ""] ?? null;
    if (!personId || !/^\d{1,20}$/.test(personId) || !locationId || !body?.pngBase64) {
      return NextResponse.json(
        { error: "personId, location, and pngBase64 are required" },
        { status: 400 },
      );
    }
    let png: Buffer;
    try {
      png = Buffer.from(body.pngBase64, "base64");
    } catch {
      return NextResponse.json({ error: "invalid pngBase64" }, { status: 400 });
    }
    // PNG magic + size sanity — never forward junk to BMI.
    if (png.length < 100 || png.length > MAX_PNG_BYTES || png.readUInt32BE(0) !== 0x89504e47) {
      return NextResponse.json({ error: "picture must be a PNG under 1MB" }, { status: 400 });
    }

    // 1. Persist FIRST (hard rule) — a DB failure is surfaced, not papered over.
    const rowId = await insertPersonPhoto({ personId, locationId, png });

    // 2. One inline Pandora attempt (the guest is mid-waiver — don't hold them
    //    for retries; the sweep owns the rest).
    const attempt = await uploadToPandora({ locationId, personId, png });
    if (attempt.ok) {
      await markPersonPhotoUploaded(rowId);
      console.log(`[person-picture] uploaded person=${personId} row=${rowId}`);
      return NextResponse.json({ ok: true, uploaded: true });
    }
    await bumpPersonPhotoAttempt(rowId, attempt.detail);
    console.error(
      `[person-picture] Pandora upload failed (queued row=${rowId} person=${personId}): ${attempt.detail}`,
    );
    return NextResponse.json({ ok: true, uploaded: false, queued: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "photo save failed";
    console.error("[person-picture] error:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** GET ?sweep=1 — retry queued photos (manual or cron). Small + idempotent. */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("sweep") !== "1") {
    return NextResponse.json({ error: "sweep=1 required" }, { status: 400 });
  }
  const pending = await getPendingPersonPhotos(10);
  let uploaded = 0;
  for (const p of pending) {
    if (!p.png) continue;
    const attempt = await uploadToPandora({
      locationId: p.locationId,
      personId: p.personId,
      png: p.png,
    });
    if (attempt.ok) {
      await markPersonPhotoUploaded(p.id);
      uploaded++;
    } else {
      await bumpPersonPhotoAttempt(p.id, attempt.detail);
    }
  }
  return NextResponse.json({ ok: true, pending: pending.length, uploaded });
}
