import { NextRequest, NextResponse } from "next/server";
import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";
const REDIS_KEY = "pov:codes"; // Redis SET of available codes
const REDIS_USED_KEY = "pov:used"; // Redis HASH of used codes → { usedAt, billId, email }

function getRedis() {
  return new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
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

    // Claim a code (get next available and mark as used)
    if (action === "claim") {
      const billId = searchParams.get("billId") || "";
      const email = searchParams.get("email") || "";
      const qty = parseInt(searchParams.get("qty") || "1", 10);

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

    return NextResponse.json({ error: "Use ?action=stats, ?action=check&code=X, or ?action=claim&qty=1&billId=X&email=X" }, { status: 400 });
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
