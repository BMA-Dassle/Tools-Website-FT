import { NextRequest, NextResponse } from "next/server";
import { PANDORA_DEFAULT_LOCATION_ID, PANDORA_LOCATION_MAP } from "@/lib/pandora-locations";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";

function resolveLocation(key: string | null): string {
  return (key && PANDORA_LOCATION_MAP[key]) || PANDORA_DEFAULT_LOCATION_ID;
}

/**
 * GET  ?age=25&location=headpinz  → Fetch age-appropriate waiver template
 * POST { personID, waiverContentID, signature (base64 PNG), location?, invalidationDate? }
 *      → Sign waiver
 */

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const age = searchParams.get("age");
  const locKey = searchParams.get("location");
  const locationID = resolveLocation(locKey);

  if (!age) {
    return NextResponse.json({ error: "age required" }, { status: 400 });
  }

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
      console.error(`[pandora-waiver] search failed ${res.status}: ${text.substring(0, 200)}`);
      return NextResponse.json({ error: "Waiver template not found" }, { status: res.status });
    }

    const raw = await res.json();
    console.log(`[pandora-waiver] raw keys: ${JSON.stringify(Object.keys(raw))}`);

    // Pandora wraps responses in { success, data, message }
    // data may be an array (multiple waivers by age) — pick the first match
    const payload = raw?.data ?? raw;
    const template = Array.isArray(payload) ? payload[0] : payload;

    if (!template) {
      return NextResponse.json({ error: "No waiver template found" }, { status: 404 });
    }

    console.log(`[pandora-waiver] template keys: ${JSON.stringify(Object.keys(template))}`);
    console.log(`[pandora-waiver] template sample: ${JSON.stringify(template).substring(0, 500)}`);

    // Normalize to our PandoraWaiverTemplate shape
    const normalized = {
      id: template.id || template.waiverContentID || "",
      contentID: template.waiverContentID || template.contentID || "",
      name: template.name || template.waiverName || "",
      duration: template.duration ?? template.validDays ?? 365,
      body: template.body || template.content || template.waiverBody || "",
    };

    console.log(`[pandora-waiver] template: id=${normalized.id} contentID=${normalized.contentID} bodyLen=${normalized.body.length}`);
    return NextResponse.json(normalized);
  } catch (err) {
    console.error("[pandora-waiver] search error:", err);
    return NextResponse.json({ error: "Failed to fetch waiver" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { personID, waiverContentID, signature, location, invalidationDate } = body;

    if (!personID || !waiverContentID || !signature) {
      return NextResponse.json(
        { error: "personID, waiverContentID, and signature required" },
        { status: 400 },
      );
    }

    const locationID = resolveLocation(location || null);

    // Convert base64 PNG signature to a Buffer for multipart upload
    const sigBase64 = signature.replace(/^data:image\/png;base64,/, "");
    const sigBuffer = Buffer.from(sigBase64, "base64");

    // Build multipart/form-data body manually
    const boundary = `----PandoraWaiver${Date.now()}`;
    const parts: Buffer[] = [];

    function addField(name: string, value: string) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ));
    }

    addField("locationID", locationID);
    addField("personID", personID);
    addField("waiverContentID", waiverContentID);
    addField("sigPersonID", personID); // adult signs for themselves
    addField("invalidationDate", invalidationDate || "");

    // Signature file part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="signature"; filename="signature.png"\r\nContent-Type: image/png\r\n\r\n`,
    ));
    parts.push(sigBuffer);
    parts.push(Buffer.from("\r\n"));

    // Closing boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const multipartBody = Buffer.concat(parts);

    const res = await fetch(`${PANDORA_URL}/bmi/waiver`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody,
    });

    const data = await res.json();

    if (!res.ok) {
      console.error(`[pandora-waiver] sign failed ${res.status}:`, JSON.stringify(data).substring(0, 300));
      return NextResponse.json({ error: data.message || "Waiver signing failed" }, { status: res.status });
    }

    console.log(`[pandora-waiver] signed waiver for person ${personID}: waiverID=${data.waiverID}`);
    return NextResponse.json({ ok: true, waiverID: data.waiverID });
  } catch (err) {
    console.error("[pandora-waiver] sign error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Waiver signing failed" },
      { status: 500 },
    );
  }
}
