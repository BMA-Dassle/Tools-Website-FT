import { NextRequest, NextResponse } from "next/server";
import { Redis } from "ioredis";
import { enqueueDepositFailure } from "@/lib/bmi-deposit-retry";

const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";
const REDIS_KEY = "pov:codes"; // Redis SET of available codes
const REDIS_USED_KEY = "pov:used"; // Redis HASH of used codes → { usedAt, billId | personId, email }

// Per-person idempotency for the e-ticket claim-from-credit flow.
// One key per personId; value is the bundle of issued codes plus
// metadata so subsequent visits return the same codes.
//   pov:claimed:person:{personId} → JSON {
//     codes: string[],
//     claimedAt: ISO,
//     sessionId, locationId,
//     creditAtClaim: number,
//     depositKindId: string,
//     depositDeducted: boolean
//   }
// 90-day TTL — long enough that a customer revisiting a week later
// still gets their codes back, but bounded so old keys eventually
// expire if BMI is permanently disconnected from the personId.
const CLAIM_TTL_SECONDS = 90 * 24 * 60 * 60;
function claimKey(personId: string): string {
  return `pov:claimed:person:${personId}`;
}

const SITE_BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
const PANDORA_INTERNAL_KEY = process.env.SWAGGER_ADMIN_KEY || "";
const VIEWPOINT_DEPOSIT_KIND_ID = process.env.VIEWPOINT_DEPOSIT_KIND_ID || "";

function getRedis() {
  return new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
}

interface ClaimRecord {
  codes: string[];
  claimedAt: string;
  sessionId: string;
  locationId: string;
  creditAtClaim: number;
  depositKindId: string;
  depositDeducted: boolean;
}

/** Read the current viewpointCredit for a participant by hitting the
 *  internal session-participants proxy with the trusted-caller header.
 *  Returns the credit number, or null if Pandora is degraded / the
 *  participant isn't on the session anymore (in which case we DO NOT
 *  issue codes — the participant must actually be on the heat). */
async function fetchParticipantCredit(
  locationId: string,
  sessionId: string,
  personId: string,
): Promise<number | null> {
  if (!PANDORA_INTERNAL_KEY) return null;
  try {
    const url = `${SITE_BASE}/api/pandora/session-participants?locationId=${encodeURIComponent(locationId)}&sessionId=${encodeURIComponent(sessionId)}&excludeUnpaid=false&prefer=cache`;
    const res = await fetch(url, {
      headers: {
        "x-pandora-internal": PANDORA_INTERNAL_KEY,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ personId: string | number; viewpointCredit?: number | null }> };
    const list = Array.isArray(json.data) ? json.data : [];
    const target = list.find((p) => String(p.personId) === String(personId));
    if (!target) return null;
    const c = target.viewpointCredit;
    if (typeof c !== "number" || !Number.isFinite(c)) return 0;
    return Math.max(0, Math.floor(c));
  } catch (err) {
    console.warn("[pov-codes/claim-from-credit] participant fetch failed:", err);
    return null;
  }
}

/** Decrement the BMI ViewPoint Credit balance. Returns true on
 *  success, false on any failure — caller flags the claim record so
 *  the sweep cron can retry. We never block code issuance on this
 *  call: the customer always gets their codes; we owe BMA the
 *  decrement, retry until it lands. */
async function deductDeposit(
  locationId: string,
  personId: string,
  amount: number,
): Promise<boolean> {
  if (!VIEWPOINT_DEPOSIT_KIND_ID) {
    console.error("[pov-codes/claim-from-credit] VIEWPOINT_DEPOSIT_KIND_ID not set");
    return false;
  }
  if (!PANDORA_INTERNAL_KEY) return false;
  try {
    const res = await fetch(`${SITE_BASE}/api/pandora/deposit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-pandora-internal": PANDORA_INTERNAL_KEY,
        "x-pandora-caller": "pov-codes/claim-from-credit",
      },
      body: JSON.stringify({
        locationId,
        personId,
        depositKindId: VIEWPOINT_DEPOSIT_KIND_ID,
        amount: -Math.abs(amount),
      }),
      cache: "no-store",
    });
    return res.ok;
  } catch (err) {
    console.warn("[pov-codes/claim-from-credit] deposit deduct threw:", err);
    return false;
  }
}

// ── GET: Check code status or get stats ─────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const code = searchParams.get("code");

  const redis = getRedis();
  try {
    await redis.connect();

    if (action === "stats") {
      const available = await redis.scard(REDIS_KEY);
      const used = await redis.hlen(REDIS_USED_KEY);
      return NextResponse.json({ available, used, total: available + used });
    }

    if (action === "check" && code) {
      const isAvailable = await redis.sismember(REDIS_KEY, code);
      const usedData = await redis.hget(REDIS_USED_KEY, code);
      if (isAvailable) return NextResponse.json({ status: "available" });
      if (usedData) return NextResponse.json({ status: "used", ...JSON.parse(usedData) });
      return NextResponse.json({ status: "unknown" });
    }

    // Claim N codes for a billId. Idempotent: if codes were already
    // claimed for this billId (via /admin backfill or a prior call),
    // return THEM instead of popping new ones from the pool. Without
    // this guard, a customer revisiting their confirmation page after
    // staff backfilled codes would see a fresh set on-screen that
    // doesn't match what's in the BMI memo / what the racer received
    // via SMS — and we'd silently consume more codes from the pool.
    //
    // Lookup: HSCAN pov:used for entries whose value contains this
    // billId. Cap the scan at COUNT 500 per page; the hash is small
    // enough (10s of thousands of codes) that this finishes in 1-2
    // round trips. Returns the matched codes in usedAt order so the
    // first claim is first in the array (deterministic for re-renders).
    if (action === "claim") {
      const billId = searchParams.get("billId") || "";
      const email = searchParams.get("email") || "";
      const qty = parseInt(searchParams.get("qty") || "1", 10);

      // Idempotency check — only meaningful when a billId is given.
      if (billId) {
        const existing: { code: string; usedAt: string }[] = [];
        let cursor = "0";
        do {
          const [next, fields] = await redis.hscan(
            REDIS_USED_KEY,
            cursor,
            "COUNT",
            500,
          );
          cursor = next;
          for (let i = 0; i < fields.length; i += 2) {
            try {
              const v = JSON.parse(fields[i + 1]);
              if (v && v.billId === billId) {
                existing.push({ code: fields[i], usedAt: v.usedAt || "" });
              }
            } catch { /* skip malformed entries */ }
          }
        } while (cursor !== "0");
        if (existing.length > 0) {
          existing.sort((a, b) => a.usedAt.localeCompare(b.usedAt));
          return NextResponse.json({
            codes: existing.map((e) => e.code),
            claimed: existing.length,
            cached: true,
          });
        }
      }

      // No prior claim — pop new codes.
      const codes: string[] = [];
      for (let i = 0; i < qty; i++) {
        const code = await redis.spop(REDIS_KEY);
        if (!code) break;
        await redis.hset(REDIS_USED_KEY, code, JSON.stringify({
          usedAt: new Date().toISOString(),
          billId,
          email,
        }));
        codes.push(code);
      }

      return NextResponse.json({ codes, claimed: codes.length });
    }

    // Claim N codes from a participant's BMI ViewPoint Credit balance.
    // Triggered when the e-ticket page sees `viewpointCredit > 0` on
    // their session-participants record.
    //
    //   GET /api/pov-codes?action=claim-from-credit
    //       &personId=46080884
    //       &locationId=LAB52GY480CJF
    //       &sessionId=39691551
    //
    // Idempotency: per-personId Redis key. Refresh / re-open the
    // ticket and you get the same codes back. Concurrent visits are
    // race-guarded via SET NX on the claim key — whoever wins the
    // write issues the codes; the loser reads the same record back.
    //
    // Anti-tamper: we ALWAYS re-verify the credit count from
    // Pandora regardless of any quantity hint in the URL — never
    // issue more codes than the participant actually has on file.
    if (action === "claim-from-credit") {
      const personId = (searchParams.get("personId") || "").trim();
      const locationId = (searchParams.get("locationId") || "").trim();
      const sessionId = (searchParams.get("sessionId") || "").trim();

      if (!/^\d+$/.test(personId)) {
        return NextResponse.json({ error: "invalid personId" }, { status: 400 });
      }
      if (!locationId) {
        return NextResponse.json({ error: "locationId required" }, { status: 400 });
      }
      if (!/^\d+$/.test(sessionId)) {
        return NextResponse.json({ error: "invalid sessionId" }, { status: 400 });
      }

      // 1. Existing-claim short-circuit. Same codes returned every
      //    time — second visit = cached: true, no Pandora calls.
      const key = claimKey(personId);
      const existing = await redis.get(key);
      if (existing) {
        try {
          const rec = JSON.parse(existing) as ClaimRecord;
          if (Array.isArray(rec.codes)) {
            return NextResponse.json({
              codes: rec.codes,
              claimed: rec.codes.length,
              cached: true,
              depositDeducted: rec.depositDeducted,
            });
          }
        } catch {
          // Corrupt record — fall through to a fresh claim.
        }
      }

      // 2. Anti-tamper: ask Pandora how many credits the person
      //    actually has on this session. If the participant isn't
      //    on the session or Pandora is degraded, refuse to claim.
      const credit = await fetchParticipantCredit(locationId, sessionId, personId);
      if (credit == null) {
        return NextResponse.json(
          { error: "could not verify credit (participant not on session or Pandora unavailable)" },
          { status: 502 },
        );
      }
      if (credit <= 0) {
        return NextResponse.json({ codes: [], claimed: 0, cached: false });
      }

      // 3. Race-guard: SET NX a placeholder claim record so two
      //    concurrent first-visit requests can't both pop codes.
      //    The winner replaces the placeholder with the real
      //    record; the loser falls back to the existing-claim path
      //    on its next round-trip (we just return what's there if
      //    we lose).
      const placeholder: ClaimRecord = {
        codes: [],
        claimedAt: new Date().toISOString(),
        sessionId,
        locationId,
        creditAtClaim: credit,
        depositKindId: VIEWPOINT_DEPOSIT_KIND_ID,
        depositDeducted: false,
      };
      const won = await redis.set(
        key,
        JSON.stringify(placeholder),
        "EX",
        CLAIM_TTL_SECONDS,
        "NX",
      );
      if (won !== "OK") {
        // Lost the race. Re-read the record the winner wrote.
        const winnerRaw = await redis.get(key);
        if (winnerRaw) {
          try {
            const rec = JSON.parse(winnerRaw) as ClaimRecord;
            if (Array.isArray(rec.codes) && rec.codes.length > 0) {
              return NextResponse.json({
                codes: rec.codes,
                claimed: rec.codes.length,
                cached: true,
                depositDeducted: rec.depositDeducted,
              });
            }
          } catch { /* fall through to error */ }
        }
        // The winner is mid-flight (placeholder still has empty
        // codes). Tell the caller to retry shortly.
        return NextResponse.json(
          { error: "claim in progress, retry in a moment" },
          { status: 409 },
        );
      }

      // 4. We won. Pop N codes from the pool.
      const issued: string[] = [];
      for (let i = 0; i < credit; i++) {
        const code = await redis.spop(REDIS_KEY);
        if (!code) break;
        await redis.hset(
          REDIS_USED_KEY,
          code,
          JSON.stringify({
            usedAt: new Date().toISOString(),
            personId,
            sessionId,
            locationId,
            source: "claim-from-credit",
          }),
        );
        issued.push(code);
      }

      // If the pool was empty (operations issue — staff needs to
      // import more codes), back the placeholder out so a future
      // retry can succeed once codes are available.
      if (issued.length === 0) {
        await redis.del(key);
        return NextResponse.json(
          { error: "no POV codes available — contact support" },
          { status: 503 },
        );
      }

      // 5. Decrement the BMI deposit balance. Best-effort — if it
      //    fails we still hand the codes to the customer, flag the
      //    record, AND enqueue a row in the durable retry table so
      //    the deposit-retry-sweep cron retries until it lands.
      //    Customer NEVER waits on BMA latency to see their codes.
      const deducted = await deductDeposit(locationId, personId, issued.length);

      const finalRec: ClaimRecord = {
        codes: issued,
        claimedAt: new Date().toISOString(),
        sessionId,
        locationId,
        creditAtClaim: credit,
        depositKindId: VIEWPOINT_DEPOSIT_KIND_ID,
        depositDeducted: deducted,
      };
      await redis.set(key, JSON.stringify(finalRec), "EX", CLAIM_TTL_SECONDS);

      // Durable retry queue. Without this, a deduct that fails on
      // the initial claim would only retry if the customer
      // revisited the e-ticket — which is not guaranteed. Sweep
      // cron picks this up within 5 min.
      if (!deducted && VIEWPOINT_DEPOSIT_KIND_ID) {
        await enqueueDepositFailure({
          source: "pov-claim",
          sourceRef: `${personId}-${sessionId}`,
          locationId,
          personId,
          depositKindId: VIEWPOINT_DEPOSIT_KIND_ID,
          amount: -Math.abs(issued.length),
          initialError: "addDeposit failed during initial claim",
          notes: `Codes issued: ${issued.length} of ${credit} credit`,
        });
      }

      console.log(
        `[pov-codes/claim-from-credit] person=${personId} loc=${locationId} session=${sessionId} issued=${issued.length}/${credit} deducted=${deducted}`,
      );

      return NextResponse.json({
        codes: issued,
        claimed: issued.length,
        cached: false,
        depositDeducted: deducted,
      });
    }

    return NextResponse.json({ error: "Use ?action=stats, ?action=check&code=X, ?action=claim&qty=1&billId=X&email=X, or ?action=claim-from-credit&personId=X&locationId=X&sessionId=X" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Redis error" }, { status: 500 });
  } finally {
    redis.disconnect();
  }
}

// ── POST: Bulk import codes ─────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  if (action === "import") {
    const body = await req.json();
    const codes: string[] = body.codes || [];

    if (!Array.isArray(codes) || codes.length === 0) {
      return NextResponse.json({ error: "Provide {codes: [...]}" }, { status: 400 });
    }

    const redis = getRedis();
    try {
      await redis.connect();

      // Filter out codes that are already used
      const pipeline = redis.pipeline();
      for (const code of codes) {
        pipeline.sismember(REDIS_KEY, code);
        pipeline.hexists(REDIS_USED_KEY, code);
      }
      const results = await pipeline.exec();

      const newCodes: string[] = [];
      for (let i = 0; i < codes.length; i++) {
        const alreadyAvailable = results?.[i * 2]?.[1];
        const alreadyUsed = results?.[i * 2 + 1]?.[1];
        if (!alreadyAvailable && !alreadyUsed) {
          newCodes.push(codes[i]);
        }
      }

      if (newCodes.length > 0) {
        // Batch add in chunks of 1000
        for (let i = 0; i < newCodes.length; i += 1000) {
          const chunk = newCodes.slice(i, i + 1000);
          await redis.sadd(REDIS_KEY, ...chunk);
        }
      }

      const total = await redis.scard(REDIS_KEY);
      return NextResponse.json({ imported: newCodes.length, skipped: codes.length - newCodes.length, totalAvailable: total });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Redis error" }, { status: 500 });
    } finally {
      redis.disconnect();
    }
  }

  // Mark a specific code as used
  if (action === "use") {
    const body = await req.json();
    const { code, billId, email } = body;
    if (!code) return NextResponse.json({ error: "Provide {code, billId, email}" }, { status: 400 });

    const redis = getRedis();
    try {
      await redis.connect();
      const removed = await redis.srem(REDIS_KEY, code);
      await redis.hset(REDIS_USED_KEY, code, JSON.stringify({
        usedAt: new Date().toISOString(),
        billId: billId || "",
        email: email || "",
      }));
      return NextResponse.json({ success: true, wasAvailable: removed === 1 });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Redis error" }, { status: 500 });
    } finally {
      redis.disconnect();
    }
  }

  return NextResponse.json({ error: "Use ?action=import or ?action=use" }, { status: 400 });
}
