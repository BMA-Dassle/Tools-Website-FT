/**
 * Self-test: is a QAMF center LIVE on the Bowling Reservations API?
 *
 * Confirms our BMA credentials can (a) mint a bowling_reservations token
 * scoped to the center and (b) read its web offers + lane list. A center
 * that answers with offers/lanes is provisioned and bookable — the green
 * light to start migrating BMI duckpin -> QAMF duckpin.
 *
 * Usage: npx tsx scripts/qamf-center-live-check.ts [centerId ...]
 * Default: 11542 (FastTrax), with 9172 (Fort Myers) as a known-good control.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import Redis from "ioredis";

try {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!(k in process.env) || !process.env[k]) process.env[k] = v;
  }
} catch {
  /* rely on env */
}

const TOKEN_URL = "https://api.qubicaamf.com/oauth2/token";
const BASE = "https://api.qubicaamf.com/bowling-reservations";
const API_VER = "2025-12-01.1.0";

const centers = process.argv.slice(2).map(Number).filter(Boolean);
const CENTERS = centers.length ? centers : [11542, 9172];

/** Prefer a fresh per-center mint (creds present); fall back to the Redis-cached token. */
async function tokenFor(centerId: number): Promise<{ token: string; via: string }> {
  const id = process.env.QAMF_BOWLING_CLIENT_ID;
  const secret = process.env.QAMF_BOWLING_CLIENT_SECRET;
  if (id && secret) {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: secret,
      scope: "bowling_reservations",
      center_id: String(centerId),
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`mint failed: ${res.status} ${txt.slice(0, 200)}`);
    return { token: (JSON.parse(txt) as { access_token: string }).access_token, via: "mint" };
  }
  // No creds locally — use the prod-cached operator token (Vercel-only creds).
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("no creds and no REDIS_URL");
  const r = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await r.connect();
    const exact = await r.get(`qamf:bowling:access-token:${centerId}`);
    if (exact) return { token: exact, via: `redis:${centerId}` };
    const fallback = await r.get(`qamf:bowling:access-token:9172`);
    if (fallback) return { token: fallback, via: "redis:9172(cross-center)" };
    throw new Error("no cached token in Redis");
  } finally {
    r.disconnect();
  }
}

async function get(path: string, token: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "api-version": API_VER,
      accept: "application/json",
    },
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

async function main() {
  for (const id of CENTERS) {
    console.log(`\n${"=".repeat(60)}\ncenter ${id}\n${"=".repeat(60)}`);
    let token: string;
    try {
      const t = await tokenFor(id);
      token = t.token;
      console.log(`  token: ${t.via}`);
    } catch (e) {
      console.log(`  TOKEN ERROR: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // 1) Web offers — the clearest "center is live & configured" signal.
    const off = await get(`/centers/${id}/weboffers`, token);
    console.log(`  GET /weboffers -> HTTP ${off.status}`);
    if (off.ok) {
      try {
        const parsed = JSON.parse(off.text);
        const arr = (Array.isArray(parsed) ? parsed : (parsed.WebOffers ?? [])) as Array<{
          Id: number;
          Title: string;
          IsEnabled: boolean;
          OpenType: string;
          Options?: Record<
            string,
            Array<{ Id: number; Minutes?: number; GamesPerPlayer?: number }>
          >;
        }>;
        console.log(`    ${arr.length} offer(s):`);
        for (const o of arr) {
          const opts = Object.entries(o.Options ?? {})
            .flatMap(([type, list]) =>
              (list ?? []).map(
                (x) =>
                  `${type}:${x.Id}${x.Minutes ? `(${x.Minutes}m)` : x.GamesPerPlayer ? `(${x.GamesPerPlayer}g)` : ""}`,
              ),
            )
            .join(", ");
          console.log(
            `      [${o.IsEnabled ? "on " : "off"}] id=${String(o.Id).padEnd(4)} ${o.OpenType.padEnd(9)} "${o.Title}"${opts ? "  " + opts : ""}`,
          );
        }
      } catch {
        console.log(`    body: ${off.text.slice(0, 300)}`);
      }
    } else {
      console.log(`    body: ${off.text.slice(0, 300)}`);
    }

    // 2) Lanes — confirms the center has a physical config exposed.
    const lanes = await get(`/centers/${id}/lanes`, token);
    console.log(`  GET /lanes -> HTTP ${lanes.status}`);
    if (lanes.ok) {
      try {
        const parsed = JSON.parse(lanes.text);
        const arr = (Array.isArray(parsed) ? parsed : (parsed.Lanes ?? [])) as unknown[];
        console.log(`    ${arr.length} lane(s) reported`);
      } catch {
        console.log(`    body: ${lanes.text.slice(0, 200)}`);
      }
    } else {
      console.log(`    body: ${lanes.text.slice(0, 200)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
