/**
 * "Does BMI ITSELF already hold a current waiver for this person?" — cached, and
 * NEVER on the render path.
 *
 * WHY THIS MODULE EXISTS (2026-08-18). The BMI sync panel asks this question of
 * every recently-added guest who has no signature of ours on file, because the
 * commonest reason for a missing `waiver_signatures` row is the happy one: they
 * already hold a valid waiver, so the kiosk never asked them to sign. Getting
 * that right is what stopped the board crying wolf (rebecca wolfson, 2026-08-13).
 *
 * It was asked LIVE, inline, inside `listRecentGuestAdds` — two attempts, 12s
 * each, five people at a time. That was affordable while Pandora answered in
 * ~3.7s. It is not affordable now: measured 2026-08-18, roughly half of all
 * requests to `bma-pandora-api.azurewebsites.net/v2/bmi/*` never answer at all
 * (30s+, `/sessions` as well as `/person`), so a batch of five almost always
 * contains at least one hang and the whole phase took 26.8s and 29.5s on two
 * consecutive runs of today's real data. The panel is polled every 20s, so the
 * board asked for a second copy before the first had returned, and the modal
 * sat on "Nothing to show" for half a minute.
 *
 * THE RULE THIS ENCODES: a vendor we do not control must never be between the
 * operator and a screen full of data we already have. The queue rows, the waiver
 * pushes and the guest adds all live in Neon and render in ~200ms. The coverage
 * answer is an ENRICHMENT on top of them, so it is served from cache if we have
 * it and refreshed AFTER the response (`after()` in the route) if we do not. A
 * missing answer costs one poll of accuracy — 20 seconds — never a blocked page.
 *
 * NOT `waiverValidNow` from ~/features/kiosk/waiver/valid-count, which looks like
 * the same question and is not: it unions Pandora with
 * `hasUnexpiredCapturedWaiver`, i.e. with signatures WE captured whatever their
 * push outcome. That union is right for the kiosk roster (a guest who signed is
 * done, whether or not BMI has caught up) and wrong here — "we hold a signature
 * BMI never got" is precisely the state this panel exists to surface, so folding
 * it in would paint the false green the panel is the alarm for. Hence a separate
 * cache key: a different question deserves a different answer, not a shared one.
 *
 * Server-only. It imports Redis, so it must never be pulled into
 * `bmi-sync-view.ts`, which is in the client bundle graph (`chips.tsx` imports
 * `onsitePillCopy` from it) and would fail the build with `Can't resolve 'tls'`.
 */
import redis from "@/lib/redis";

/** FastTrax racing — where kiosk waiver joins are added, and the same default the
 *  sync cron and barrier probe use. A person id from another centre simply 404s
 *  here, which fails closed (still shown as owed) rather than wrongly cleared. */
const RACING_LOCATION_ID = "LAB52GY480CJF";

const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";

function cacheKey(personId: string): string {
  return `admin:bmi-sync:bmi-waiver:${personId}`;
}

/**
 * A waiver that BMI says is current does not stop being current for a year, so a
 * positive answer is cheap to keep. A negative one is the volatile side — the
 * guest may be signing at the desk right now — and expires fast enough that the
 * board is never more than a couple of polls behind them.
 */
const COVERED_TTL_SECONDS = 6 * 60 * 60;
const NOT_COVERED_TTL_SECONDS = 120;

/**
 * One attempt per person per refresh, and a GENEROUS one: nobody is waiting, and
 * the vendor's good answers arrive at 2.4–9.6s when they arrive at all (measured
 * 2026-08-18). The retry that used to make fail-closed honest is the refresh
 * CADENCE now — the board polls every 20s, so an unanswered person is simply
 * asked again, without anyone watching a spinner in between.
 */
const LOOKUP_TIMEOUT_MS = 20_000;
/** Same ceiling the kiosk roster uses — Pandora is not to be flooded. */
const LOOKUP_CONCURRENCY = 5;
/**
 * Stop STARTING lookups past this. Whatever is left is picked up by the next
 * poll; the alternative is a background task that outlives the route's
 * `maxDuration` and gets killed mid-flight with nothing written.
 */
const REFRESH_DEADLINE_MS = 40_000;
/**
 * ONE ASKER PER PERSON. The board polls every 20s and a refresh can outlast a
 * poll, so without a claim the same people get asked two and three times over —
 * piling load onto the exact vendor that is already failing to answer. Same
 * SET NX shape the track-session reader uses for the same reason; the TTL is the
 * lookup budget, so a crashed asker frees the person rather than pinning them.
 */
const CLAIM_TTL_SECONDS = Math.ceil(LOOKUP_TIMEOUT_MS / 1000) + 5;

/**
 * What the cache currently knows. A key that is ABSENT is not "no": it is "we
 * have not got an answer", and the caller must render it as such rather than
 * telling staff a guest owes a waiver we never actually asked about.
 */
export async function cachedWaiverCoverage(personIds: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const ids = [...new Set(personIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const vals = await redis.mget(...ids.map(cacheKey));
    ids.forEach((id, i) => {
      const v = vals[i];
      if (v === "1") out.set(id, true);
      else if (v === "0") out.set(id, false);
    });
  } catch (err) {
    // Redis down → every id stays unresolved, which renders as "still checking".
    console.warn("[waiver-coverage] cache read failed:", err);
  }
  return out;
}

/**
 * Ask Pandora, once per person, and cache what it says.
 *
 * Called from `after()` — its latency is off the request path by construction,
 * so the only thing that matters here is that it cannot run away: one bounded
 * attempt, five at a time, and every failure is swallowed.
 *
 * UNREADABLE IS NOT "NO". A timeout, a network error or a 500 (the vendor's own
 * schema rejecting a null-birthdate record) leaves the key UNSET, so the row keeps
 * saying "still checking" and we ask again next poll. Caching a vendor blip as a
 * negative is how a covered guest gets pinned to "owes a waiver" for the TTL —
 * the same mistake `waiverValidNow` documents at its own 500 branch.
 */
export async function refreshWaiverCoverage(personIds: string[]): Promise<void> {
  const ids = [...new Set(personIds.filter(Boolean))];
  if (ids.length === 0 || !process.env.SWAGGER_ADMIN_KEY) return;
  const started = Date.now();
  let answered = 0;
  let asked = 0;
  let skipped = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(LOOKUP_CONCURRENCY, ids.length) }, async () => {
    while (next < ids.length && Date.now() - started < REFRESH_DEADLINE_MS) {
      const id = ids[next++];
      if (!(await claim(id))) {
        skipped++;
        continue;
      }
      asked++;
      const verdict = await bmiHoldsCurrentWaiver(id);
      if (verdict === null) continue; // unreadable — ask again next time
      answered++;
      try {
        await redis.setex(
          cacheKey(id),
          verdict ? COVERED_TTL_SECONDS : NOT_COVERED_TTL_SECONDS,
          verdict ? "1" : "0",
        );
      } catch {
        /* cache write failed — the answer is simply not kept */
      }
    }
  });
  await Promise.all(workers);
  /**
   * Logged every time, because this line IS our read on the vendor. A run that
   * reports 0 of 11 answered is a Pandora outage stated in our own words, and it
   * is the only place it shows now that the failure no longer reaches the screen
   * as a hang.
   */
  console.log(
    `[waiver-coverage] ${answered}/${asked} answered (${skipped} already being asked, ` +
      `${ids.length - asked - skipped} left for the next poll) in ${Date.now() - started}ms`,
  );
}

/** Win the right to ask about this person, or leave them to whoever already has
 *  it. Redis down → everyone asks, which is the old behaviour, not a new bug. */
async function claim(personId: string): Promise<boolean> {
  try {
    const res = await redis.set(`${cacheKey(personId)}:asking`, "1", "EX", CLAIM_TTL_SECONDS, "NX");
    return res === "OK";
  } catch {
    return true;
  }
}

/**
 * `true` = BMI holds a waiver valid past now. `false` = BMI answered and it does
 * not. `null` = we could not get an answer, which is neither.
 */
async function bmiHoldsCurrentWaiver(personId: string): Promise<boolean | null> {
  try {
    const res = await fetch(
      `${PANDORA_URL}/bmi/person/${RACING_LOCATION_ID}/${personId}?picture=false&allRelated=false`,
      {
        headers: { Authorization: `Bearer ${process.env.SWAGGER_ADMIN_KEY || ""}` },
        cache: "no-store",
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      },
    );
    // 404 = not this centre's person: a real answer, and the fail-closed one.
    if (res.status === 404) return false;
    // 500 = the record exists but the vendor cannot serialise it (null birthdate).
    // That is "we cannot tell", and must not be cached as "no".
    if (!res.ok) return null;
    const d = (await res.json()) as { success?: boolean; data?: { waiverExpiry?: string | null } };
    if (!d?.success) return null;
    const exp = d.data?.waiverExpiry ? Date.parse(d.data.waiverExpiry) : NaN;
    return Number.isFinite(exp) && exp > Date.now();
  } catch {
    // Timeout or network. Not an answer.
    return null;
  }
}
