import { redirect } from "next/navigation";
import { headers } from "next/headers";
import redis from "@/lib/redis";

export const dynamic = "force-dynamic";

/**
 * Short URL resolver: /s/{code} → redirects to the stored full URL.
 *
 * Also tracks click counts so the admin SMS log can show whether a
 * racer opened their e-ticket link. Click data lives at
 * `click:{code}` as a Redis hash:
 *   first    — ISO timestamp of the first click
 *   firstUa  — User-Agent of the first click
 *   last     — ISO timestamp of the most recent click
 *   lastUa   — User-Agent of the most recent click
 *   count    — total click count (raw, not deduped per client)
 *
 * TTL matches the short-url TTL (90 days) so history persists even
 * after the underlying ticket record expires.
 *
 * We attempt to skip obvious link-preview bots (iMessage preview, WhatsApp,
 * Facebook, Slack, etc.) so the count reflects real humans as closely as
 * possible. Nothing is bulletproof — iMessage in particular doesn't always
 * identify itself — so treat counts as "opened at least once" rather than
 * an exact human-click count.
 */

const CLICK_TTL = 60 * 60 * 24 * 90; // 90 days
const BOT_UA_RE = /bot\b|crawler|spider|preview|facebookexternalhit|whatsapp|telegrambot|slackbot|linkedinbot|discordbot|googlebot|bingbot|applebot|pinterestbot|curl\/|wget\/|python-requests|httpx/i;

async function trackClick(code: string): Promise<void> {
  try {
    const hdrs = await headers();
    const ua = (hdrs.get("user-agent") || "").slice(0, 200);
    if (BOT_UA_RE.test(ua)) return;

    const now = new Date().toISOString();
    const key = `click:${code}`;
    const pipeline = redis.pipeline();
    pipeline.hsetnx(key, "first", now);
    pipeline.hsetnx(key, "firstUa", ua);
    pipeline.hset(key, "last", now);
    pipeline.hset(key, "lastUa", ua);
    pipeline.hincrby(key, "count", 1);
    pipeline.expire(key, CLICK_TTL);
    await pipeline.exec();
  } catch {
    // Best-effort — never let tracking break the redirect.
  }
}

export default async function ShortUrlRedirect({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const url = await redis.get(`short:${code}`);

  if (!url) {
    redirect("/");
  }

  await trackClick(code);
  redirect(url);
}
