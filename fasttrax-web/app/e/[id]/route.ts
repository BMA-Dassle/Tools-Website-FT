import { NextRequest, NextResponse } from "next/server";
import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";

/**
 * Serve stored email HTML as a web page — used for SMS short links.
 * URL: /e/{id}
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) return new NextResponse("Not found", { status: 404 });

  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await redis.connect();
    const html = await redis.get(`email:view:${id}`);
    redis.disconnect();
    if (!html) return new NextResponse("This link has expired.", { status: 404 });
    return new NextResponse(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  } catch {
    redis.disconnect();
    return new NextResponse("Failed to load.", { status: 500 });
  }
}
