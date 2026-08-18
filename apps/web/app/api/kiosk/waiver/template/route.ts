import { NextRequest, NextResponse } from "next/server";
import { PANDORA_DEFAULT_LOCATION_ID, PANDORA_LOCATION_MAP } from "@/lib/pandora-locations";
import { inhouseWaiverTemplate, type WaiverLang } from "~/features/kiosk/waiver/templates";
import { resolveWaiverTemplate, waiverTemplateCacheLabel } from "~/features/waiver/template-cache";

/**
 * In-house waiver template (behind `kioskWaiverInhouseEnabled()`, gated in the
 * pandora.ts client wrapper). Returns OUR OWN legal body (adult/minor × en/es)
 * so we can translate it — but KEEPS BMI's real `contentID` and `duration` so the
 * signature still goes through the existing, incident-hardened BMI sign path
 * (POST /api/pandora/waiver) completely unchanged. That is what makes serving our
 * own text safe without rebuilding the money/gating-sensitive sign flow.
 *
 * GET ?age=25&location=headpinz&lang=es  → { id, contentID (BMI's), name, duration, body (ours) }
 *
 * If BMI can't hand us a contentID, we fail exactly like today — a signature
 * needs a BMI contentID to record, so there is no silent divergence.
 *
 * ── The contentID no longer costs a vendor call per load (2026-08-18) ───────
 * It comes from ~/features/waiver/template-cache: cached per (location,
 * adult|minor) — the two templates BMI actually has, proven by probe — fresh for
 * an hour, retained 30 days and served when Pandora is unreachable. This route
 * was 21 × 500 in the hour Pandora degraded, all of it spent re-fetching an
 * identifier that changes only when BMI revises the waiver document.
 */

function resolveLocation(key: string | null): string {
  return (key && PANDORA_LOCATION_MAP[key]) || PANDORA_DEFAULT_LOCATION_ID;
}

function normalizeLang(raw: string | null): WaiverLang {
  return raw === "es" ? "es" : "en";
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ageRaw = searchParams.get("age");
  const locKey = searchParams.get("location");
  const lang = normalizeLang(searchParams.get("lang"));
  const locationID = resolveLocation(locKey);

  if (!ageRaw) {
    return NextResponse.json({ error: "age required" }, { status: 400 });
  }
  const age = parseInt(ageRaw, 10);
  if (!Number.isFinite(age)) {
    return NextResponse.json({ error: "age must be a number" }, { status: 400 });
  }

  // The body + variant come from US; the contentID/duration come from BMI so the
  // existing sign path keeps working. Age drives adult vs minor on both sides.
  const ours = inhouseWaiverTemplate(age, lang);

  try {
    const resolved = await resolveWaiverTemplate({ locationID, age });
    if (!resolved.ok) {
      console.error(
        `[kiosk-waiver-template] BMI contentID lookup failed (${resolved.reason}): ${resolved.detail}`,
      );
      return NextResponse.json(
        {
          error:
            resolved.reason === "no-contentid"
              ? "No waiver template found"
              : "Waiver template not found",
        },
        { status: resolved.status },
      );
    }
    const bmi = resolved.template;

    // OUR text + variant name, BMI's contentID + duration (so signing is unchanged).
    const merged = {
      id: String(bmi.id || ours.id),
      contentID: bmi.contentID,
      name: ours.name,
      duration: bmi.duration ?? ours.duration,
      body: ours.body,
    };
    console.log(
      `[kiosk-waiver-template] served in-house ${lang} body (bodyLen=${merged.body.length}) ` +
        `with BMI contentID=${merged.contentID} [${waiverTemplateCacheLabel(resolved)}]`,
    );
    return NextResponse.json(merged);
  } catch (err) {
    console.error("[kiosk-waiver-template] error:", err);
    return NextResponse.json({ error: "Failed to load waiver" }, { status: 500 });
  }
}
