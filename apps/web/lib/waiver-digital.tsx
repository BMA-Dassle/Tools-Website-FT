import { ImageResponse } from "next/og";
import { resolvePandoraLocation } from "@/lib/pandora-locations";

/**
 * Digital waiver acceptance → Pandora/BMI.
 *
 * Records an electronic waiver acceptance as a "Digitally Accepted" mark (NOT a
 * synthetic hand-drawn signature) against a BMI person via Pandora's
 * `POST /v2/bmi/waiver`. Used by:
 *   - the forward accept-checkbox flow (per-guest, live), and
 *   - the one-time backfill of guests who provably accepted online but whose
 *     acceptance never persisted (the silent-failure incident, 2026-06-18).
 *
 * ── Why this exists / the bug it fixes ──────────────────────────────────────
 * The original waiver route checked only the HTTP status from Pandora — never
 * the wrapped `data.success` flag or the returned `waiverID` — and the UI
 * ignored the id too. A `200`-with-no-write rendered as "success" while BMI
 * recorded nothing. `signWaiverDigital()` treats a missing/false `success` or a
 * missing `waiverID` as a hard failure, so a non-write can never look like a win.
 */

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";

/** Single material waiver text in effect for these events (no minors). */
export const WAIVER_TERMS_VERSION = "v1-2026-06-18";

/** Validity window for an event waiver — event-scoped (event + buffer), NOT the
 *  template's default duration. Owner decision 2026-06-18: 5 days. */
export const WAIVER_VALID_DAYS = 5;

export interface WaiverTemplate {
  contentID: string;
  duration: number;
  name: string;
}

// Cache the (location → adult waiver template) lookup; it's the same template
// for every adult and the Pandora API cold-starts, so we fetch it at most once.
const templateCache = new Map<string, WaiverTemplate>();

/** Fetch (and cache) the age-appropriate adult waiver template for a location. */
export async function getWaiverTemplate(locationId: string, age = 35): Promise<WaiverTemplate> {
  const cached = templateCache.get(locationId);
  if (cached) return cached;

  const res = await fetch(`${PANDORA_URL}/bmi/waiver/search?locationID=${locationId}&age=${age}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`waiver template search ${res.status}: ${text.slice(0, 200)}`);
  }
  const raw = await res.json();
  const t = raw?.data ?? raw;
  if (!t?.contentID) throw new Error("no waiver template contentID returned");
  const tmpl: WaiverTemplate = {
    contentID: String(t.contentID),
    duration: t.duration ?? 365,
    name: t.name || "",
  };
  templateCache.set(locationId, tmpl);
  return tmpl;
}

/**
 * Render the visible "Digitally Accepted" signature mark as a PNG buffer.
 * System font only (the bundled-font fetch is flaky on cold starts — see
 * app/apple-icon.tsx). Dark text on white so it reads in BMI's waiver viewer.
 */
export async function renderDigitallyAcceptedPng(opts: {
  name: string;
  dateEt: string;
  termsVersion?: string;
}): Promise<Buffer> {
  const { name, dateEt, termsVersion = WAIVER_TERMS_VERSION } = opts;
  const img = new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        background: "#ffffff",
        color: "#0a0a0a",
        fontFamily: "system-ui, sans-serif",
        padding: "36px 48px",
      }}
    >
      <div style={{ fontSize: 56, fontWeight: 800, letterSpacing: -1 }}>Digitally Accepted</div>
      <div style={{ fontSize: 34, fontWeight: 600, marginTop: 6 }}>{name}</div>
      <div style={{ fontSize: 24, color: "#444", marginTop: 14 }}>
        {`Accepted electronically · ${dateEt}`}
      </div>
      <div style={{ fontSize: 18, color: "#666", marginTop: 8 }}>
        {`Waiver terms ${termsVersion} · Electronic acceptance per E-SIGN / FL UETA §668.50. No hand-drawn signature captured.`}
      </div>
    </div>,
    { width: 1000, height: 420 },
  );
  return Buffer.from(await img.arrayBuffer());
}

/** Build the multipart/form-data body Pandora's waiver endpoint expects. */
function buildWaiverMultipart(params: {
  boundary: string;
  locationID: string;
  personID: string;
  waiverContentID: string;
  invalidationDate: string;
  pngBuffer: Buffer;
}): Buffer {
  const { boundary, locationID, personID, waiverContentID, invalidationDate, pngBuffer } = params;
  const parts: Buffer[] = [];
  const field = (name: string, value: string) =>
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  field("locationID", locationID);
  field("personID", personID);
  field("waiverContentID", waiverContentID);
  field("sigPersonID", personID); // adult accepts for themselves
  field("invalidationDate", invalidationDate);
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="signature"; filename="signature.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
  );
  parts.push(pngBuffer);
  parts.push(Buffer.from("\r\n"));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

export interface SignWaiverDigitalResult {
  ok: true;
  waiverID: string;
  invalidationDate: string;
  termsVersion: string;
  /** True when the person already had a valid waiver and we skipped the push. */
  skipped: boolean;
}

/** Read a person's current waiver expiry (ms epoch, 0 if none/unreadable). */
async function waiverExpiryMs(locationID: string, personId: string): Promise<number> {
  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${locationID}/${personId}?picture=false&allRelated=false`,
      { headers: { Authorization: `Bearer ${API_KEY}` }, cache: "no-store" },
    );
    const d = await res.json();
    return d?.data?.waiverExpiry ? new Date(d.data.waiverExpiry).getTime() : 0;
  } catch {
    return 0;
  }
}

/**
 * Record a digital waiver acceptance for one person in BMI via Pandora.
 *
 * Renders the "Digitally Accepted" mark (unless a pre-rendered `pngBuffer` is
 * supplied by a client) and uploads it as the signature. THROWS on any
 * non-success — including Pandora `200` with `success:false` or a missing
 * `waiverID` — so callers can never mistake a non-write for a success.
 */
export async function signWaiverDigital(opts: {
  personId: string;
  name: string;
  locationKey?: string | null;
  dateEt?: string;
  pngBuffer?: Buffer;
  /** Skip the push (return skipped:true) if the person already has a valid waiver. */
  skipIfValid?: boolean;
}): Promise<SignWaiverDigitalResult> {
  const { personId, name } = opts;
  if (!personId) throw new Error("personId required");
  if (!API_KEY) throw new Error("SWAGGER_ADMIN_KEY not configured");

  const locationID = resolvePandoraLocation(opts.locationKey);

  // Don't overwrite an existing valid waiver (e.g. a prior real signature).
  if (opts.skipIfValid && (await waiverExpiryMs(locationID, personId)) > Date.now()) {
    return {
      ok: true,
      waiverID: "",
      invalidationDate: "",
      termsVersion: WAIVER_TERMS_VERSION,
      skipped: true,
    };
  }

  const tmpl = await getWaiverTemplate(locationID);
  // Event-scoped validity (WAIVER_VALID_DAYS), overriding the template's own
  // duration — we don't want a year-long waiver from a one-event acceptance.
  const invalidationDate = new Date(Date.now() + WAIVER_VALID_DAYS * 864e5)
    .toISOString()
    .split("T")[0];

  const dateEt =
    opts.dateEt ||
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      dateStyle: "long",
      timeStyle: "short",
    }).format(new Date());

  const png =
    opts.pngBuffer ??
    (await renderDigitallyAcceptedPng({ name, dateEt, termsVersion: WAIVER_TERMS_VERSION }));

  const boundary = `----PandoraWaiver${Date.now()}`;
  const body = buildWaiverMultipart({
    boundary,
    locationID,
    personID: personId,
    waiverContentID: tmpl.contentID,
    invalidationDate,
    pngBuffer: png,
  });

  const res = await fetch(`${PANDORA_URL}/bmi/waiver`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    // Buffer → Uint8Array: a valid BodyInit (Buffer isn't, per the fetch types).
    body: new Uint8Array(body),
  });

  const text = await res.text();
  let data: {
    success?: boolean;
    message?: string;
    waiverID?: string;
    data?: { waiverID?: string; message?: string };
  } = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* non-JSON body handled below */
  }
  const waiverID = data?.data?.waiverID || data?.waiverID;

  // The fix: a write is only a success if Pandora says so AND returns an id.
  if (!res.ok || data?.success === false || !waiverID) {
    const msg =
      data?.message || data?.data?.message || (text ? text.slice(0, 200) : `HTTP ${res.status}`);
    throw new Error(
      `waiver sign failed (status=${res.status} success=${data?.success} id=${waiverID ?? "none"}): ${msg}`,
    );
  }

  return {
    ok: true,
    waiverID: String(waiverID),
    invalidationDate,
    termsVersion: WAIVER_TERMS_VERSION,
    skipped: false,
  };
}
