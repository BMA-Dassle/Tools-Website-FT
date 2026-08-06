/**
 * Is this webhook delivery really from PassKit?
 *
 * PASSKIT MINTS THE SECRET, WE DO NOT. The portal generates a base64 secret and
 * shows it once; there is no field to paste a token of our own, and the REST API
 * has no webhook resource at all (every spelling 404s — measured 2026-08-06). So
 * the first version of this endpoint, which checked a bearer token WE chose, could
 * never have matched a single real delivery.
 *
 * WHAT PASSKIT SENDS IS NOT DOCUMENTED for our region, and we cannot ask the API.
 * Rather than guess one scheme and be silently wrong, this accepts any proof that
 * REQUIRES POSSESSION OF THE SECRET, and reports which one matched so the log from
 * the first real delivery tells us what PassKit actually does. Once that is known,
 * delete the branches that never fire.
 *
 * Every accepted form still demands the secret, so breadth here costs no security:
 *   - the secret presented verbatim (Authorization / X-*-Secret / ?secret=)
 *   - HMAC-SHA256 over the RAW body, in hex or base64, against any
 *     signature-ish header
 *
 * The HMAC is tried with the secret as literal ASCII **and** as base64-decoded key
 * bytes. PassKit's secret is base64 and vendors split roughly evenly on which they
 * use as the key; getting that wrong is the difference between "verified" and a
 * webhook that looks broken forever.
 *
 * NEVER loosen this to "any POST is fine". A verified delivery DELETES a guest's
 * PassKit record.
 */
import { createHmac, timingSafeEqual } from "crypto";

export interface WebhookVerdict {
  verified: boolean;
  /** Which proof matched — logged so the real scheme becomes known from one
   *  delivery instead of a guessing cycle per deploy. */
  via: string | null;
  /** Header names present on the request, for the same reason. Names only:
   *  a signature VALUE is not a secret, but a mis-set header could carry one. */
  headerNames: string[];
}

/** Headers a vendor might put a signature in. Matched loosely because we are
 *  discovering the name, not asserting it. */
const SIGNATURE_HEADER = /signature|hmac|digest|checksum/i;
/** Headers a vendor might put the raw shared secret in. */
const SECRET_HEADER = /^(authorization|x-[a-z-]*secret|x-[a-z-]*token|x-api-key)$/i;

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual THROWS on a length mismatch, which would turn a wrong
  // signature into a 500 instead of a refusal.
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Both readings of a base64 secret: the literal string, and the bytes it encodes. */
function candidateKeys(secret: string): Buffer[] {
  const keys = [Buffer.from(secret, "utf8")];
  try {
    const decoded = Buffer.from(secret, "base64");
    // Only a genuinely different reading is worth a second HMAC.
    if (decoded.length > 0 && decoded.toString("base64") === secret) keys.push(decoded);
  } catch {
    /* not base64 — the utf8 reading is the only one */
  }
  return keys;
}

/**
 * @param rawBody the body EXACTLY as received. Re-serialising parsed JSON changes
 *   bytes (key order, whitespace) and the HMAC will never match — this is the
 *   single most common reason a signature check fails against a working sender.
 */
export function verifyPassKitWebhook(
  headers: Headers,
  url: string,
  rawBody: string,
): WebhookVerdict {
  const headerNames = [...headers.keys()].sort();
  const secret = process.env.PASSKIT_WEBHOOK_SECRET;
  // Closed until configured: this endpoint deletes guest credentials.
  if (!secret) return { verified: false, via: null, headerNames };

  // 1. The secret presented verbatim.
  for (const [name, value] of headers.entries()) {
    if (!SECRET_HEADER.test(name)) continue;
    const bare = value.replace(/^Bearer\s+/i, "");
    if (eq(bare, secret)) return { verified: true, via: `header:${name}`, headerNames };
  }
  try {
    if (eq(new URL(url).searchParams.get("secret") ?? "", secret)) {
      return { verified: true, via: "query:secret", headerNames };
    }
  } catch {
    /* unparseable URL is not a proof */
  }

  // 2. HMAC-SHA256 over the raw body, any signature-ish header, hex or base64.
  const digests = new Set<string>();
  for (const key of candidateKeys(secret)) {
    const mac = createHmac("sha256", key).update(rawBody, "utf8").digest();
    digests.add(mac.toString("hex"));
    digests.add(mac.toString("base64"));
  }
  for (const [name, value] of headers.entries()) {
    if (!SIGNATURE_HEADER.test(name)) continue;
    // Some vendors prefix the algorithm ("sha256=abc…"); compare both readings.
    for (const candidate of [value.trim(), value.trim().replace(/^[a-z0-9]+=/i, "")]) {
      for (const digest of digests) {
        if (eq(candidate, digest)) return { verified: true, via: `hmac:${name}`, headerNames };
      }
    }
  }

  return { verified: false, via: null, headerNames };
}
