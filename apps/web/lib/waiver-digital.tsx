import { ImageResponse } from "next/og";
import { resolvePandoraLocation, isKnownPandoraLocationId } from "@/lib/pandora-locations";
import { resolveWaiverTemplate, waiverBandForAge } from "~/features/waiver/template-cache";

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

// In-process L1 in front of the shared Redis cache: within one lambda the same
// template is asked for once per signer, and this saves the Redis hop. Keyed by
// (location, band) — keying by location alone silently handed a MINOR signer the
// adult template that an earlier adult call had parked there.
const templateCache = new Map<string, WaiverTemplate>();

/**
 * Fetch (and cache) the age-appropriate waiver template for a location.
 *
 * The lookup itself, its retry policy and its 30-day outage fallback all live in
 * ~/features/waiver/template-cache, shared with the two waiver routes — the
 * Pandora API cold-starts and 5xx's under concurrent load, and a single
 * un-retried failure here kills the whole sign. A retained contentID is what
 * keeps event signing alive through a vendor wobble.
 */
export async function getWaiverTemplate(locationId: string, age = 35): Promise<WaiverTemplate> {
  const l1Key = `${locationId}:${waiverBandForAge(age)}`;
  const cached = templateCache.get(l1Key);
  if (cached) return cached;

  const resolved = await resolveWaiverTemplate({ locationID: locationId, age });
  if (!resolved.ok) {
    throw new Error(`waiver template search failed (${resolved.reason}): ${resolved.detail}`);
  }
  const tmpl: WaiverTemplate = {
    contentID: resolved.template.contentID,
    // Duration is in YEARS (BMI template semantics) — unused here (event
    // waivers override with WAIVER_VALID_DAYS) but kept coherent.
    duration: resolved.template.duration,
    name: resolved.template.name,
  };
  templateCache.set(l1Key, tmpl);
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
  /** WHO SIGNED. Defaults to the person themselves (an adult accepting for
   *  themselves, this module's original and only caller). A minor's waiver must
   *  pass the GUARDIAN's id — see the note in `signWaiverDigital`. */
  sigPersonID?: string;
}): Buffer {
  const { boundary, locationID, personID, waiverContentID, invalidationDate, pngBuffer } = params;
  const signerID = params.sigPersonID?.trim() || personID;
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
  field("sigPersonID", signerID);
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
    if (!res.ok || !d?.data) {
      // 0 means "no waiver on file", and callers use it for skipIfValid — so an
      // UNREADABLE record makes us re-sign someone who is already covered. A
      // null birthdate makes this endpoint 500 ("Response Validator Error"),
      // and booking creates people without one. Re-signing is harmless, so the
      // behaviour stands; being unable to tell the two apart is not.
      console.warn(
        `[waiver-digital] person ${personId} UNREADABLE (HTTP ${res.status}) — ` +
          `treating as no waiver; a null birthdate causes this and is repairable`,
      );
      return 0;
    }
    return d.data.waiverExpiry ? new Date(d.data.waiverExpiry).getTime() : 0;
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
  /**
   * The template the signer ACTUALLY read. Omit and this function looks one up
   * for `age = 35` — an ADULT template — which is correct for the event
   * digital-accept path it was written for and WRONG for anyone else. The kiosk
   * sign route passes the contentID it rendered, so a queued minor's waiver is
   * filed against the minor document rather than an adult one they never saw.
   */
  waiverContentID?: string;
  /**
   * The expiry we PRESENTED, as "YYYY-MM-DD". Omit and the event-scoped
   * `WAIVER_VALID_DAYS` (5) wins, which silently shortens a kiosk waiver the
   * guest was shown as valid for the template's full year.
   */
  invalidationDate?: string;
  /**
   * WHO SIGNED, when that is not the person themselves — a parent or guardian
   * signing for a minor. Omit for a self-sign.
   *
   * This module was written for adults accepting for themselves and hardcoded
   * the signer to `personId`, so a queued MINOR waiver recorded the child as
   * their own signer and the guardian's consent vanished from the record. That
   * is worse than the wrong template or the short expiry: it is the one field
   * that makes a minor's waiver mean anything.
   *
   * Note for callers: Pandora must be able to resolve BOTH ids on the center's
   * local server, so a guardian-signed push belongs behind the `persons-local`
   * barrier with both people named — not `person-local` on the minor alone.
   */
  signerPersonId?: string;
  /** Skip the push (return skipped:true) if the person already has a valid waiver. */
  skipIfValid?: boolean;
  /**
   * The RESOLVED Pandora location id the signature was captured at, for callers
   * that already hold it. Wins over `locationKey`.
   *
   * Exists because `resolvePandoraLocation` falls back to FastTrax for anything it
   * cannot map, and a caller with the real id had no way to say so. The queued
   * waiver push carried `PPTR5G2N0QXF7` (HeadPinz Naples) for its barrier, passed
   * no `locationKey`, and so signed against FastTrax — where a Naples person id
   * does not exist, because BMI ids do not cross centers. Two Naples guests' waivers
   * retried for 23 minutes and were on course to give up (2026-08-13, rows #809/#811).
   *
   * It fails LOUDLY rather than silently defaulting: an id we cannot recognise is a
   * wrong-centre write waiting to happen.
   */
  locationId?: string | null;
}): Promise<SignWaiverDigitalResult> {
  const { personId, name } = opts;
  if (!personId) throw new Error("personId required");
  if (!API_KEY) throw new Error("SWAGGER_ADMIN_KEY not configured");

  if (opts.locationId && !isKnownPandoraLocationId(opts.locationId)) {
    throw new Error(
      `unknown Pandora location "${opts.locationId}" — refusing to sign, ` +
        `because the fallback would file this waiver at the wrong center`,
    );
  }
  const locationID = opts.locationId || resolvePandoraLocation(opts.locationKey);

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

  // A caller that KNOWS which document was signed passes its contentID; only
  // fall back to the age-35 adult lookup when nobody told us (event path).
  const contentID = opts.waiverContentID?.trim() || (await getWaiverTemplate(locationID)).contentID;
  // Event-scoped validity (WAIVER_VALID_DAYS), overriding the template's own
  // duration — we don't want a year-long waiver from a one-event acceptance.
  // A caller-supplied date wins: it is the expiry the signer was actually shown,
  // and quietly substituting 5 days for it makes our record disagree with the
  // one they agreed to.
  const invalidationDate =
    opts.invalidationDate?.trim() ||
    new Date(Date.now() + WAIVER_VALID_DAYS * 864e5).toISOString().split("T")[0];

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
    waiverContentID: contentID,
    invalidationDate,
    pngBuffer: png,
    sigPersonID: opts.signerPersonId,
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
