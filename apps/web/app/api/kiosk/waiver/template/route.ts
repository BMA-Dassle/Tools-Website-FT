import { NextRequest, NextResponse } from "next/server";
import { PANDORA_DEFAULT_LOCATION_ID, PANDORA_LOCATION_MAP } from "@/lib/pandora-locations";
import { inhouseWaiverTemplate, type WaiverLang } from "~/features/kiosk/waiver/templates";

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
 * If BMI can't hand us a contentID (Azure down), we fail exactly like today — a
 * signature needs a BMI contentID to record, so there is no silent divergence.
 */

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";

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
    const res = await fetch(
      `${PANDORA_URL}/bmi/waiver/search?locationID=${locationID}&age=${age}`,
      {
        headers: { Authorization: `Bearer ${API_KEY}` },
        cache: "no-store",
      },
    );
    if (!res.ok) {
      const text = await res.text();
      console.error(
        `[kiosk-waiver-template] BMI contentID lookup failed ${res.status}: ${text.substring(0, 200)}`,
      );
      return NextResponse.json({ error: "Waiver template not found" }, { status: res.status });
    }
    const raw = await res.json();
    const bmi = raw?.data ?? raw;
    if (!bmi || !bmi.contentID) {
      console.error(
        `[kiosk-waiver-template] unexpected BMI shape:`,
        JSON.stringify(raw).substring(0, 300),
      );
      return NextResponse.json({ error: "No waiver template found" }, { status: 404 });
    }

    // OUR text + variant name, BMI's contentID + duration (so signing is unchanged).
    const merged = {
      id: String(bmi.id || ours.id),
      contentID: String(bmi.contentID),
      name: ours.name,
      duration: bmi.duration ?? ours.duration,
      body: ours.body,
    };
    console.log(
      `[kiosk-waiver-template] served in-house ${lang} body (bodyLen=${merged.body.length}) with BMI contentID=${merged.contentID}`,
    );
    return NextResponse.json(merged);
  } catch (err) {
    console.error("[kiosk-waiver-template] error:", err);
    return NextResponse.json({ error: "Failed to load waiver" }, { status: 500 });
  }
}
