import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { Redis } from "ioredis";
import { randomUUID } from "crypto";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
const FROM_NAME = "FastTrax Entertainment";
const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || "";
const VOX_API_KEY = process.env.VOX_API_KEY || "";
const VOX_FROM_FASTTRAX = "+12394819666";
const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";

// Level config
const LEVEL_CONFIG: Record<string, {
  color1: string;
  color2: string;
  accent: string;
  description: string;
  prevLevel: string;
}> = {
  Intermediate: {
    color1: "#7E57C2",
    color2: "#5E35B1",
    accent: "#5E35B1",
    description: "The karts run at a significantly higher speed — plan for a bigger jump than you might expect.",
    prevLevel: "Starter",
  },
  Pro: {
    color1: "#E53935",
    color2: "#C62828",
    accent: "#C62828",
    description: "Pro karts are the fastest we offer — this is the top tier and demands precise, experienced driving.",
    prevLevel: "Intermediate",
  },
};

// ── Template loader ────────────────────────────────────────────────────────

let template: string | null = null;
function getTemplate(): string {
  if (!template) {
    template = readFileSync(join(process.cwd(), "emails", "level-up.html"), "utf-8");
  }
  return template;
}

// ── SendGrid ───────────────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
    });
    return res.ok || res.status === 202;
  } catch {
    return false;
  }
}

// ── Voxtelesys SMS ─────────────────────────────────────────────────────────

async function sendSms(to: string, body: string): Promise<boolean> {
  if (!VOX_API_KEY || !to) return false;
  try {
    const res = await fetch("https://smsapi.voxtelesys.net/api/v2/sms", {
      method: "POST",
      headers: { "Authorization": `Bearer ${VOX_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to, from: VOX_FROM_FASTTRAX, body }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Build email ────────────────────────────────────────────────────────────

function renderEmail(data: {
  racerName: string;
  levelName: "Intermediate" | "Pro";
  bestLapTime: string;
  trackName: string;
  sessionTime: string;
  bookingLink: string;
}): string {
  const cfg = LEVEL_CONFIG[data.levelName];
  const isIntermediate = data.levelName === "Intermediate";
  const isPro = data.levelName === "Pro";

  // Progression chart colors — highlight unlocked levels
  const starterBg = "#E8F8F8";
  const starterBorder = "#00B8BA";
  const starterStatus = "Complete ✓";

  const intermediateBg = (isIntermediate || isPro) ? "#F0EBF8" : "#F5F5F5";
  const intermediateBorder = (isIntermediate || isPro) ? "#7E57C2" : "#CCCCCC";
  const intermediateStatus = isPro ? "Complete ✓" : isIntermediate ? "Just Unlocked! 🔓" : "Locked";

  const proBg = isPro ? "#FFEBEE" : "#F5F5F5";
  const proBorder = isPro ? "#E53935" : "#CCCCCC";
  const proStatus = isPro ? "Just Unlocked! 🔓" : "The ultimate test";

  let html = getTemplate();
  html = html.replace(/\^RacerName\(\)\$/g, data.racerName);
  html = html.replace(/\^LevelName\(\)\$/g, data.levelName);
  html = html.replace(/\^LevelColor1\(\)\$/g, cfg.color1);
  html = html.replace(/\^LevelColor2\(\)\$/g, cfg.color2);
  html = html.replace(/\^LevelAccent\(\)\$/g, cfg.accent);
  html = html.replace(/\^LevelDescription\(\)\$/g, cfg.description);
  html = html.replace(/\^BestLapTime\(\)\$/g, data.bestLapTime);
  html = html.replace(/\^TrackName\(\)\$/g, data.trackName);
  html = html.replace(/\^SessionTime\(\)\$/g, data.sessionTime);
  html = html.replace(/\^BookingLink\(\)\$/g, data.bookingLink);
  html = html.replace(/\^StarterBg\(\)\$/g, starterBg);
  html = html.replace(/\^StarterBorder\(\)\$/g, starterBorder);
  html = html.replace(/\^StarterStatus\(\)\$/g, starterStatus);
  html = html.replace(/\^IntermediateBg\(\)\$/g, intermediateBg);
  html = html.replace(/\^IntermediateBorder\(\)\$/g, intermediateBorder);
  html = html.replace(/\^IntermediateStatus\(\)\$/g, intermediateStatus);
  html = html.replace(/\^ProBg\(\)\$/g, proBg);
  html = html.replace(/\^ProBorder\(\)\$/g, proBorder);
  html = html.replace(/\^ProStatus\(\)\$/g, proStatus);
  return html;
}

// ── POST handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const {
      persId,
      email,
      phone,
      racerName,
      levelName,
      bestLapTime,
      trackName,
      sessionTime,
      loginCode,
      smsOptIn,
    } = await req.json();

    if (!persId || !levelName || !racerName) {
      return NextResponse.json({ error: "persId, levelName, racerName required" }, { status: 400 });
    }
    if (!LEVEL_CONFIG[levelName]) {
      return NextResponse.json({ error: "levelName must be Intermediate or Pro" }, { status: 400 });
    }

    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
    try {
      await redis.connect();

      // Dedup: one level-up email per person per level, ever
      const dedupKey = `levelup:sent:${persId}:${levelName}`;
      const already = await redis.get(dedupKey);
      if (already) {
        redis.disconnect();
        return NextResponse.json({ success: true, duplicate: true });
      }

      // Build booking link — auto-login via loginCode if available
      const bookingLink = loginCode
        ? `${BASE_URL}/book/race?code=${encodeURIComponent(loginCode)}`
        : `${BASE_URL}/book/race`;

      // Render email HTML
      const html = renderEmail({
        racerName,
        levelName,
        bestLapTime,
        trackName,
        sessionTime,
        bookingLink,
      });

      // Store web version for SMS short link
      const viewId = randomUUID();
      const viewKey = `email:view:${viewId}`;
      await redis.set(viewKey, html, "EX", 30 * 24 * 60 * 60); // 30 days
      const webViewUrl = `${BASE_URL}/e/${viewId}`;

      // Create short URL for SMS
      let shortUrl = webViewUrl;
      try {
        const shortRes = await fetch(`${BASE_URL}/api/s`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: webViewUrl }),
        });
        if (shortRes.ok) {
          const shortData = await shortRes.json();
          if (shortData.shortUrl) shortUrl = shortData.shortUrl;
        }
      } catch { /* use full URL as fallback */ }

      // Send email
      let emailSent = false;
      if (email) {
        const subject = `🏆 You're now ${levelName}! — FastTrax`;
        emailSent = await sendEmail(email, subject, html);
      }

      // Send SMS
      let smsSent = false;
      if (phone && smsOptIn) {
        const smsBody = `🏆 LEVEL UP! ${racerName}, you qualified for ${levelName}!\nBest lap: ${bestLapTime} on ${trackName}.\nSee what this means & book your next race:\n${shortUrl}`;
        const normalized = phone.startsWith("+") ? phone : `+1${phone.replace(/\D/g, "")}`;
        smsSent = await sendSms(normalized, smsBody);
      }

      // Log send
      const log = {
        type: "level-up",
        persId,
        email,
        levelName,
        racerName,
        bestLapTime,
        trackName,
        emailSent,
        smsSent,
        sentAt: new Date().toISOString(),
      };
      await redis.set(dedupKey, JSON.stringify(log), "EX", 365 * 24 * 60 * 60); // 1 year

      redis.disconnect();
      return NextResponse.json({ success: true, emailSent, smsSent, webViewUrl, shortUrl });
    } catch (err) {
      redis.disconnect();
      throw err;
    }
  } catch (err) {
    console.error("[level-up] error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
