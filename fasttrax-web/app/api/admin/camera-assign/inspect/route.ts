import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";

/**
 * GET /api/admin/camera-assign/inspect?keys=9,46,4
 *
 * Read-only diagnostic. For each camera/system key supplied, returns
 * whatever's stored in:
 *   system-watch:{key}     — current (last-write-wins) assignment
 *   system-history:{key}   — time-indexed sorted set (all assignments
 *                            that have ever been made for that key)
 *
 * Use this after a scan to confirm the record actually got saved and
 * under the expected key name (camera hardware id vs. system/base id).
 *
 * Also accepts ?prefix=system-watch (or system-history) to SCAN for
 * all keys under that prefix when you don't know what to look up.
 *
 * Auth: middleware gates /api/admin/camera-assign/* on ADMIN_CAMERA_TOKEN.
 */

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const keysRaw = (searchParams.get("keys") || "").trim();
    const prefixRaw = (searchParams.get("prefix") || "").trim();

    const out: Record<string, unknown> = {};

    if (prefixRaw) {
      // Scan all keys matching the prefix. Cap at 2000 for safety.
      const pattern = prefixRaw.endsWith("*") ? prefixRaw : `${prefixRaw}*`;
      const found: string[] = [];
      let cursor = "0";
      do {
        const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
        cursor = next;
        for (const k of batch) {
          found.push(k);
          if (found.length >= 2000) { cursor = "0"; break; }
        }
      } while (cursor !== "0");
      out.prefixScan = { pattern, count: found.length, keys: found.slice(0, 100) };
    }

    if (keysRaw) {
      const ids = keysRaw.split(",").map((s) => s.trim()).filter(Boolean);
      const perKey: Record<string, unknown> = {};
      for (const id of ids) {
        const watchKey = `system-watch:${id}`;
        const historyKey = `system-history:${id}`;
        const watchRaw = await redis.get(watchKey);
        // Sorted set: return all members with scores (ts epoch ms)
        const history = await redis.zrange(historyKey, 0, -1, "WITHSCORES");
        const historyParsed: Array<{ score: number; value: unknown }> = [];
        for (let i = 0; i < history.length; i += 2) {
          const scoreNum = Number(history[i + 1]);
          let parsed: unknown = history[i];
          try { parsed = JSON.parse(history[i]); } catch { /* leave as string */ }
          historyParsed.push({ score: scoreNum, value: parsed });
        }
        perKey[id] = {
          watchKey,
          watch: watchRaw ? (safeParse(watchRaw) ?? watchRaw) : null,
          historyKey,
          history: historyParsed,
        };
      }
      out.keys = perKey;
    }

    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[camera-assign/inspect]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "inspect failed" },
      { status: 500 },
    );
  }
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
