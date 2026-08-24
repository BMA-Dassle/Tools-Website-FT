/**
 * The BMI waiver template lookup, cached — one reader for all three call sites.
 *
 * ── What this lookup is actually FOR ────────────────────────────────────────
 * `GET /bmi/waiver/search?locationID&age` returns the waiver template BMI will
 * accept a signature against: `contentID` (what the sign POST must reference),
 * `id`, `name`, `duration` (years) and BMI's own `body`. The kiosk serves OUR
 * hardcoded en/es body and keeps only BMI's contentID + duration, so that path is
 * paying a live vendor call per waiver load purely to look up an IDENTIFIER
 * (owner 2026-08-18: "why do we need the template every time when we have the
 * waiver hard coded in the site?"). The answer changes only when BMI revises the
 * waiver document — which is to say, almost never.
 *
 * On 2026-08-18, while Pandora was degraded, that cost 21 × 500 in one hour on
 * /api/kiosk/waiver/template alone (plus 6 on /api/pandora/waiver): kiosk guests
 * unable to load a waiver because an id we already knew was momentarily
 * unreachable.
 *
 * ── What it varies with — MEASURED, not assumed ─────────────────────────────
 * Probed 2026-08-18 across ages 5/12/13/17/18/25/40 at all three centers: every
 * center returns exactly TWO templates, splitting at 18 — the same boundary as
 * our own `waiverVariantForAge`. FastTrax and HeadPinz Fort Myers SHARE a pair
 * (minor contentID 20241498 / adult 19065376); Naples has its own (5958734 /
 * 5958737). `duration` was 1 everywhere.
 *
 * So the cache key is (locationID, adult|minor) — six keys for the estate, not
 * one per age. Any guest of any age lands on a warm key, which is the difference
 * between a cache that helps and a cache that fragments.
 *
 * ── Posture ─────────────────────────────────────────────────────────────────
 *   - FRESH WINDOW 1h: a genuine BMI revision is picked up within the hour.
 *   - RETAINED 30 days, served only when the live call fails. Signing against
 *     the last known contentID is strictly better than not signing at all: if
 *     BMI has since invalidated it the sign POST fails exactly as it does today.
 *   - Retries only when they are the difference between an answer and a dead
 *     end: 3 attempts on a cold key, 1 when we hold a copy to fall back on.
 *     Piling retries onto a degrading vendor is what turned 2026-08-14 into an
 *     outage (see tasks/lessons.md).
 */
import redis from "@/lib/redis";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";

/** Fresh window — long enough to make the lookup free, short enough that a real
 *  waiver revision lands the same hour. */
const FRESH_WINDOW_MS = 60 * 60 * 1000;

/** Retention for the outage fallback. A contentID stays valid for months. */
const RETENTION_SECONDS = 30 * 24 * 60 * 60;

const UPSTREAM_TIMEOUT_MS = 8_000;

/** BMI's own banding, established by probe (see header) — NOT a copy of our
 *  template gate. `template-cache.test.ts` asserts the two still agree, so a
 *  change to either side surfaces as a failing test rather than a mis-keyed
 *  cache. */
export type WaiverBand = "adult" | "minor";
export function waiverBandForAge(age: number): WaiverBand {
  return age < 18 ? "minor" : "adult";
}

/** Shape both waiver routes already hand out, and the sign path already reads. */
export interface WaiverTemplateFields {
  id: string;
  contentID: string;
  name: string;
  duration: number;
  /** BMI's own body. The kiosk replaces it with ours; /api/pandora/waiver passes
   *  it through unchanged. */
  body: string;
}

export type WaiverTemplateSource = "fresh" | "cache" | "stale";

export type WaiverTemplateResult =
  | {
      ok: true;
      template: WaiverTemplateFields;
      source: WaiverTemplateSource;
      /** Age of the copy served; null when it came from Pandora just now. */
      ageMs: number | null;
      /** Why the live call failed, when a retained copy is being served. */
      staleReason: string | null;
    }
  | {
      ok: false;
      /** Status to report — the upstream's own, or 502/504 when it never answered. */
      status: number;
      reason: string;
      /** Upstream body, trimmed, for the caller's `details` field. */
      detail: string;
    };

interface Envelope {
  template: WaiverTemplateFields;
  cachedAt: number;
}

function cacheKey(locationID: string, band: WaiverBand): string {
  return `pandora:waiver-template:v1:${locationID}:${band}`;
}

/** Pull the fields we depend on out of Pandora's wrapper, or null if this is not
 *  a usable template. A response with no contentID cannot be signed against, so
 *  it is a failure however healthy the status code looked. */
function normalize(raw: unknown): WaiverTemplateFields | null {
  const t = ((raw as { data?: unknown })?.data ?? raw) as Record<string, unknown> | null;
  if (!t || t.contentID == null || String(t.contentID).trim() === "") return null;
  return {
    id: String(t.id ?? ""),
    contentID: String(t.contentID),
    name: typeof t.name === "string" ? t.name : "",
    duration: typeof t.duration === "number" ? t.duration : 1,
    body: typeof t.body === "string" ? t.body : "",
  };
}

async function readEnvelope(key: string): Promise<Envelope | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope;
    if (!env?.template?.contentID || typeof env.cachedAt !== "number") return null;
    return env;
  } catch (err) {
    console.warn("[waiver-template] cache read failed:", err);
    return null;
  }
}

/** The live lookup. Separated so tests can drive the whole policy without a
 *  network, and so all three callers share one timeout. */
export type WaiverTemplateFetcher = (
  locationID: string,
  age: number,
) => Promise<{ status: number; body: string }>;

const liveFetcher: WaiverTemplateFetcher = async (locationID, age) => {
  const res = await fetch(`${PANDORA_URL}/bmi/waiver/search?locationID=${locationID}&age=${age}`, {
    headers: { Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}` },
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return { status: res.status, body: await res.text() };
};

/**
 * Resolve the waiver template for (location, age) — Redis first inside the fresh
 * window, live otherwise, retained copy when live fails.
 */
export async function resolveWaiverTemplate(opts: {
  locationID: string;
  age: number;
  /** Skip the fresh window and re-read from Pandora. Still falls back to stale. */
  forceFresh?: boolean;
  fetcher?: WaiverTemplateFetcher;
}): Promise<WaiverTemplateResult> {
  const { locationID, age, forceFresh = false, fetcher = liveFetcher } = opts;
  const band = waiverBandForAge(age);
  const key = cacheKey(locationID, band);

  const cached = await readEnvelope(key);
  if (cached && !forceFresh) {
    const ageMs = Date.now() - cached.cachedAt;
    if (ageMs >= 0 && ageMs < FRESH_WINDOW_MS) {
      return { ok: true, template: cached.template, source: "cache", ageMs, staleReason: null };
    }
  }

  const stale = (reason: string): WaiverTemplateResult | null =>
    cached
      ? {
          ok: true,
          template: cached.template,
          source: "stale",
          ageMs: Date.now() - cached.cachedAt,
          staleReason: reason,
        }
      : null;

  // Retry only buys something when there is nothing to fall back on.
  const attempts = cached ? 1 : 3;
  let lastStatus = 502;
  let lastReason = "unreachable";
  let lastDetail = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 400 * (attempt - 1)));
    let live: { status: number; body: string };
    try {
      live = await fetcher(locationID, age);
    } catch (err) {
      lastStatus = 504;
      lastReason = err instanceof Error ? err.message : "fetch-failed";
      lastDetail = "";
      continue;
    }

    if (live.status >= 400) {
      lastStatus = live.status;
      lastReason = `pandora-${live.status}`;
      lastDetail = live.body.slice(0, 200);
      // A 4xx is a real answer about a real request — retrying it just repeats
      // the same mistake at the vendor's expense.
      if (live.status < 500) break;
      continue;
    }

    let template: WaiverTemplateFields | null = null;
    try {
      template = normalize(JSON.parse(live.body));
    } catch {
      template = null;
    }
    if (!template) {
      lastStatus = 404;
      lastReason = "no-contentid";
      lastDetail = live.body.slice(0, 200);
      continue;
    }

    // Write-through, fire-and-forget: a Redis hiccup must not fail a good answer.
    redis
      .set(key, JSON.stringify({ template, cachedAt: Date.now() }), "EX", RETENTION_SECONDS)
      .catch((err) => console.warn("[waiver-template] cache write failed:", err));

    return { ok: true, template, source: "fresh", ageMs: null, staleReason: null };
  }

  const fallback = stale(lastReason);
  if (fallback) {
    console.warn(
      `[waiver-template] ${locationID}/${band} live lookup failed (${lastReason}) — ` +
        `serving the retained contentID`,
    );
    return fallback;
  }
  return { ok: false, status: lastStatus, reason: lastReason, detail: lastDetail };
}

/** One line for the logs / response headers: which copy was used, how old. */
export function waiverTemplateCacheLabel(
  result: Extract<WaiverTemplateResult, { ok: true }>,
): string {
  if (result.source === "fresh") return "FRESH";
  const seconds = Math.round((result.ageMs ?? 0) / 1000);
  return result.source === "stale"
    ? `STALE-${result.staleReason} (${seconds}s old)`
    : `CACHE (${seconds}s old)`;
}
