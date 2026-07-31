/**
 * Gift-card GAN extraction for the split-tender flow — pure, no transport, no
 * React. One scanned line comes in; out comes either a GAN *candidate* (the
 * server-side lookup in service/split-tenders.ts is the real validator) or a
 * classified rejection the UI can phrase help around.
 *
 * Known Square shapes (mirrors code-entry/classify.ts ground truth):
 *   app QR        `sqgc://<16-digit GAN>`
 *   printed URL   `https://squareup.com/gift/<gan-ish segment>` or a
 *                 square.link short link; some carry the GAN as a query param.
 *
 * PCI-adjacent (mirrors card-reader/wedge.ts): NEVER log the payload or the
 * extracted candidate — a GAN is money. No console output in this module, and
 * consumers must keep candidates out of logs too (last4 only, server-side).
 */

export type GanExtraction =
  | { kind: "candidate"; gan: string }
  | { kind: "license" }
  | { kind: "url-unknown" }
  | { kind: "unrecognized" };

/** Square GANs are 16 digits; third-party imports can be alphanumeric and
 *  shorter/longer, so accept the same 8–20 alnum window the split-tender
 *  service enforces. */
const GAN_RE = /^[A-Za-z0-9]{8,20}$/;

/** Square gift-card app QR scheme. */
const SQGC_RE = /^sqgc:\/\/([A-Za-z0-9 -]+)$/i;

/** Scheme-less short/printed links still worth parsing as URLs. */
const BARE_SQUARE_HOST_RE = /^(?:www\.)?(?:square\.link|squareup\.com)\//i;

/** Query params that explicitly carry a GAN on printed/emailed links. */
const GAN_PARAMS = new Set(["gan", "gan_id", "card"]);

/** 8–20-char alnum path segments that are English/route words, not GANs.
 *  (Shorter words like "gift" or "pay" already fail the length test.) */
const COMMON_SEGMENTS = new Set([
  "activate",
  "balancecheck",
  "checkout",
  "confirmation",
  "customers",
  "dashboard",
  "download",
  "fasttrax",
  "fasttraxent",
  "giftcard",
  "giftcards",
  "headpinz",
  "locations",
  "purchase",
  "redemption",
  "register",
  "reservation",
  "reservations",
  "settings",
]);

/** Strip the separators a printed GAN (or a scanner) inserts, then gate. */
function normalizeGan(value: string): string | null {
  const compact = value.replace(/[\s-]+/g, "");
  return GAN_RE.test(compact) ? compact : null;
}

function extractFromUrl(raw: string): GanExtraction {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { kind: "url-unknown" };
  }

  // An explicit gan-like query param wins — but a present-yet-implausible
  // value means "this URL tried to carry a card and we can't read it", not
  // "go guess from the path".
  for (const [key, value] of url.searchParams) {
    if (!GAN_PARAMS.has(key.toLowerCase())) continue;
    const gan = normalizeGan(value);
    return gan ? { kind: "candidate", gan } : { kind: "url-unknown" };
  }

  // Otherwise: exactly ONE gan-plausible path segment or we don't guess.
  const plausible = url.pathname
    .split("/")
    .filter((seg) => GAN_RE.test(seg) && !COMMON_SEGMENTS.has(seg.toLowerCase()));
  return plausible.length === 1
    ? { kind: "candidate", gan: plausible[0] }
    : { kind: "url-unknown" };
}

/**
 * Classify one scanned line. Candidates are NOT verified cards — feed them to
 * lookupGiftCardForSplit and let Square say no.
 */
export function extractGanCandidate(payload: string): GanExtraction {
  const raw = payload.trim();
  if (!raw) return { kind: "unrecognized" };

  // A driver's license PDF417 — "@\x1e\rANSI 636…" — usually bursts as many
  // lines (the listener catches that), but a clipped first line alone would
  // otherwise strip down to a fake 8–20 alnum "GAN". Check it first.
  if (raw.startsWith("@") || raw.includes("ANSI ")) return { kind: "license" };

  const sqgc = SQGC_RE.exec(raw);
  if (sqgc) {
    const gan = normalizeGan(sqgc[1]);
    return gan ? { kind: "candidate", gan } : { kind: "unrecognized" };
  }

  if (/^https?:\/\//i.test(raw) || BARE_SQUARE_HOST_RE.test(raw)) return extractFromUrl(raw);

  const gan = normalizeGan(raw);
  return gan ? { kind: "candidate", gan } : { kind: "unrecognized" };
}
