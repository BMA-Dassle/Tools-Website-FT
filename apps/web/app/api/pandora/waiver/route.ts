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

    // Pandora wraps: { success: true, data: { id, contentID, name, duration, body } }
    const template = raw?.data ?? raw;

    if (!template || !template.contentID) {
      console.error(`[pandora-waiver] unexpected shape:`, JSON.stringify(raw).substring(0, 300));
      return NextResponse.json({ error: "No waiver template found" }, { status: 404 });
    }

    // Pass through — Pandora field names match our PandoraWaiverTemplate type.
    // `duration` is in YEARS (BMI semantics; all locations return 1).
    const normalized = {
      id: String(template.id || ""),
      contentID: String(template.contentID),
      name: template.name || "",
      duration: template.duration ?? 1,
      body: template.body || "",
    };

    console.log(
      `[pandora-waiver] template "${normalized.name}" contentID=${normalized.contentID} bodyLen=${normalized.body.length}`,
    );
    return NextResponse.json(normalized);
  } catch (err) {
    console.error("[pandora-waiver] search error:", err);
    return NextResponse.json({ error: "Failed to fetch waiver" }, { status: 500 });
  }
}

/** Is this person's waiver valid RIGHT NOW? Salvage probe for the sign retry
 *  loop below — a Pandora write-then-500 (or a concurrent sign) shows up here
 *  as a future waiverExpiry, which is the business outcome we actually need. */
async function waiverNowValid(locationID: string, personID: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${locationID}/${personID}?picture=false&allRelated=false`,
      { headers: { Authorization: `Bearer ${API_KEY}` }, cache: "no-store" },
    );
    const data = await res.json();
    const expiry = data?.data?.waiverExpiry ? new Date(data.data.waiverExpiry) : null;
    return !!expiry && !Number.isNaN(expiry.getTime()) && expiry > new Date();
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { personID, waiverContentID, signature, location, invalidationDate, sigPersonID } = body;

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

    // Every log line carries the full sign context — the 2026-07-18 kiosk
    // failures were undiagnosable because errors logged neither WHO was being
    // signed nor with what (owner: "maybe add logging to this?").
    const meta = `person=${personID} signer=${sigPersonID || personID} content=${waiverContentID} loc=${locationID} sig=${sigBuffer.length}B invalidation=${invalidationDate || "default"}`;

    // Build multipart/form-data body manually
    const boundary = `----PandoraWaiver${Date.now()}`;
    const parts: Buffer[] = [];

    function addField(name: string, value: string) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    }

    addField("locationID", locationID);
    addField("personID", personID);
    addField("waiverContentID", waiverContentID);
    // Signer defaults to the person themselves; a guardian signing a minor's
    // waiver passes their own (SHORT Pandora) id here instead.
    addField("sigPersonID", sigPersonID || personID);
    addField("invalidationDate", invalidationDate || "");

    // Signature file part
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="signature"; filename="signature.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
    );
    parts.push(sigBuffer);
    parts.push(Buffer.from("\r\n"));

    // Closing boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const multipartBody = Buffer.concat(parts);

    // Pandora (Azure App Service) throws transient 5xx "Unexpected Error
    // Occured" bursts — the same pathology every OTHER Pandora call here
    // already retries (pandoraCreatePerson 3x, getWithRetry, the state -3
    // confirm 3x). Sign was the one unretried call: kiosk guests saw the raw
    // error on the signature screen and "it worked the second time" (owner
    // 2026-07-18 — five 500s in the 00:50–00:55Z window; a live probe minutes
    // later signed the same person + fresh persons 4/4, confirming transient).
    // Retry server-side; before each retry AND after final failure, probe
    // whether the waiver actually landed (a write-then-500 leaves a valid
    // waiver behind) and salvage instead of failing the guest.
    let lastError: { status: number; message: string } | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, 800 * (attempt - 1)));
        if (await waiverNowValid(locationID, personID)) {
          console.log(
            `[pandora-waiver] salvaged — waiver already valid after failed attempt(s) (${meta})`,
          );
          return NextResponse.json({ ok: true, waiverID: null, alreadyValid: true });
        }
      }

      let res: Response;
      try {
        res = await fetch(`${PANDORA_URL}/bmi/waiver`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body: multipartBody,
        });
      } catch (err) {
        lastError = { status: 502, message: "Pandora unreachable" };
        console.error(`[pandora-waiver] sign attempt ${attempt}/3 network error (${meta}):`, err);
        continue;
      }

      const data = await res.json().catch(() => null);

      // Pandora wraps: { success, data: { waiverID } }. A 200 with success:false
      // or no waiverID is a NON-write — treat it as a failure, never a success.
      // (This is the bug that silently lost ~240 Health Net waivers on 2026-06-18.)
      const waiverID = data?.data?.waiverID || data?.waiverID;
      if (res.ok && data?.success !== false && waiverID) {
        console.log(
          `[pandora-waiver] signed waiver for person ${personID}: waiverID=${waiverID} (attempt ${attempt}/3, ${meta})`,
        );
        return NextResponse.json({ ok: true, waiverID });
      }

      lastError = {
        status: res.ok ? 502 : res.status,
        message: data?.message || data?.data?.message || "Waiver signing failed",
      };
      console.error(
        `[pandora-waiver] sign attempt ${attempt}/3 failed status=${res.status} success=${data?.success} id=${waiverID ?? "none"} (${meta}):`,
        JSON.stringify(data).substring(0, 300),
      );

      // A real 4xx (bad person/template) won't improve with retries.
      if (!res.ok && res.status < 500) break;
    }

    // Final salvage: did one of the "failed" attempts actually write?
    if (await waiverNowValid(locationID, personID)) {
      console.log(`[pandora-waiver] salvaged after final attempt — waiver is valid (${meta})`);
      return NextResponse.json({ ok: true, waiverID: null, alreadyValid: true });
    }

    return NextResponse.json(
      { error: lastError?.message || "Waiver signing failed" },
      { status: lastError?.status || 502 },
    );
  } catch (err) {
    console.error("[pandora-waiver] sign error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Waiver signing failed" },
      { status: 500 },
    );
  }
}
