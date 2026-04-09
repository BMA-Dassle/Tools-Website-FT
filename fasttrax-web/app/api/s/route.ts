import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { randomBytes } from "crypto";

const SHORT_TTL = 90 * 24 * 60 * 60; // 90 days

/**
 * POST /api/s — Create a short URL
 * Body: { url: string }
 * Returns: { code: string, shortUrl: string }
 */
export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

    // Generate a 6-char alphanumeric code
    const code = randomBytes(4).toString("base64url").slice(0, 6);
    await redis.set(`short:${code}`, url, "EX", SHORT_TTL);

    const base = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";
    return NextResponse.json({ code, shortUrl: `${base}/s/${code}` });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
