import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { getGroupEvent } from "@/lib/group-events";

const TTL = 60 * 60 * 24 * 7; // 7 days

/**
 * Heat roster CRUD for group events.
 *
 * Redis key: groupevent:{slug}:roster:{track}:{heatStart}
 * Type: HASH — email → displayName (e.g. "Eric O.")
 *
 * GET  ?slug=...             → all rosters for the event
 * POST { slug, track, heatStart, email, displayName } → add guest to heat
 * DELETE { slug, track, heatStart, email }             → remove guest from heat
 */

function rosterKey(slug: string, track: string, heatStart: string): string {
  return `groupevent:${slug}:roster:${track}:${heatStart}`;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug");
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });

  const event = getGroupEvent(slug);
  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

  // Scan for all roster keys for this event
  const pattern = `groupevent:${slug}:roster:*`;
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");

  // Build roster map: { "Red:2026-06-19T09:00:00": ["Eric O.", "Sarah J."] }
  const rosters: Record<string, string[]> = {};
  for (const key of keys) {
    const all = await redis.hgetall(key);
    const names = Object.values(all);
    if (names.length === 0) continue;

    // Key format: groupevent:{slug}:roster:{track}:{heatStart}
    const parts = key.split(":");
    const heatStart = parts.slice(4).join(":"); // Rejoin in case ISO has colons
    const track = parts[3];
    rosters[`${track}:${heatStart}`] = names;
  }

  return NextResponse.json({ rosters });
}

export async function POST(req: NextRequest) {
  try {
    const { slug, track, heatStart, email, displayName } = await req.json();
    if (!slug || !track || !heatStart || !email || !displayName) {
      return NextResponse.json(
        { error: "slug, track, heatStart, email, displayName required" },
        { status: 400 },
      );
    }

    const event = getGroupEvent(slug);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    const key = rosterKey(slug, track, heatStart);
    await redis.hset(key, email.toLowerCase(), displayName);
    await redis.expire(key, TTL);

    console.log(`[group-roster] added ${displayName} (${email}) to ${track} ${heatStart}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[group-roster] POST error:", err);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { slug, track, heatStart, email } = await req.json();
    if (!slug || !track || !heatStart || !email) {
      return NextResponse.json(
        { error: "slug, track, heatStart, email required" },
        { status: 400 },
      );
    }

    const event = getGroupEvent(slug);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });

    const key = rosterKey(slug, track, heatStart);
    await redis.hdel(key, email.toLowerCase());

    console.log(`[group-roster] removed ${email} from ${track} ${heatStart}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[group-roster] DELETE error:", err);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}
