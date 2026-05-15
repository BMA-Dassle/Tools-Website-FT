/**
 * Diagnose VIP Fri-Sun availability issue.
 * Usage: npx tsx scripts/debug-vip-fri-sun.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { neon } from "@neondatabase/serverless";

try {
  const envPath = resolve(process.cwd(), ".env.local");
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
} catch {
  /* rely on env */
}

const DATABASE_URL = process.env.DATABASE_URL!;
const sql = neon(DATABASE_URL);

const TOKEN_URL = "https://api.qubicaamf.com/oauth2/token";
const BASE = "https://api.qubicaamf.com/bowling-reservations";
const API_VER = "2025-12-01.1.0";

async function mintToken(centerId: number): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.QAMF_BOWLING_CLIENT_ID!,
    client_secret: process.env.QAMF_BOWLING_CLIENT_SECRET!,
    scope: "bowling_reservations",
    center_id: String(centerId),
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Token mint failed: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function checkAvailability(centerId: number, offerId: number, date: string, token: string) {
  const month = parseInt(date.slice(5, 7), 10);
  const tz = month >= 3 && month <= 11 ? "-04:00" : "-05:00";
  const probes = ["16:00", "18:00", "20:00"];
  console.log(`\nOffer ${offerId} at center ${centerId} on ${date}:`);
  for (const t of probes) {
    const bookedAt = `${date}T${t}:00${tz}`;
    const res = await fetch(`${BASE}/centers/${centerId}/reservations/availability/search`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "api-version": API_VER,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        Filter: {
          BookedAtRange: { StartAt: bookedAt, EndAt: bookedAt },
          TotalPlayers: 2,
          WebOffer: { Id: offerId, Services: ["BookForLater"] },
        },
      }),
    });
    const text = await res.text();
    const data = JSON.parse(text) as {
      Availabilities?: Array<{
        BookedAt: string;
        WebOffer: { Id: unknown; Options?: Record<string, unknown[]> };
      }>;
    };
    const avails = data.Availabilities ?? [];
    for (const a of avails) {
      const wid = a.WebOffer?.Id;
      const widType = typeof wid;
      const matchNum = wid === offerId;
      const matchStr = String(wid) === String(offerId);
      const opts = Object.entries(a.WebOffer?.Options ?? {})
        .map(([k, v]) => `${k}[${Array.isArray(v) ? v.length : "?"}]`)
        .join(", ");
      console.log(
        `  ${t}  BookedAt=${a.BookedAt}  WebOffer.Id=${JSON.stringify(wid)}(${widType})  ==offerId:${matchNum}  matchAsStr:${matchStr}  opts=${opts}`,
      );
    }
    if (avails.length === 0) console.log(`  ${t} → no slots`);
  }
}

async function main() {
  console.log("══ DB check ══════════════════════════════════════════════════════");

  // 1. Check experience row
  const expRows = await sql`
    SELECT id, slug, kind, is_vip, is_active, days_of_week, sort_order
    FROM bowling_experiences
    WHERE slug IN ('vip-fri-sun', 'regular-fri-sun')
    ORDER BY slug
  `;
  console.log("\nExperience rows:");
  for (const r of expRows) {
    const row = r as Record<string, unknown>;
    console.log(
      `  slug=${row.slug}  id=${row.id}  kind=${row.kind}  vip=${row.is_vip}  active=${row.is_active}  days=${JSON.stringify(row.days_of_week)}`,
    );
  }

  // 2. Check offer rows
  const offerRows = await sql`
    SELECT eo.*, e.slug
    FROM bowling_experience_offers eo
    JOIN bowling_experiences e ON e.id = eo.experience_id
    WHERE e.slug IN ('vip-fri-sun', 'regular-fri-sun')
    ORDER BY e.slug, eo.center_code
  `;
  console.log("\nOffer rows:");
  for (const r of offerRows) {
    const row = r as Record<string, unknown>;
    console.log(
      `  slug=${row.slug}  center=${row.center_code}  qamfOfferId=${row.qamf_web_offer_id}  optType=${row.qamf_option_type}  active=${row.is_active}`,
    );
  }

  // 3. Check duration options
  const durRows = await sql`
    SELECT bedo.*, e.slug
    FROM bowling_experience_duration_options bedo
    JOIN bowling_experiences e ON e.id = bedo.experience_id
    WHERE e.slug IN ('vip-fri-sun', 'regular-fri-sun')
    ORDER BY e.slug, bedo.center_code, bedo.sort_order
  `;
  console.log("\nDuration options:");
  for (const r of durRows) {
    const row = r as Record<string, unknown>;
    console.log(
      `  slug=${row.slug}  center=${row.center_code}  optId=${row.qamf_option_id}  mins=${row.duration_minutes}  label=${row.label}  mult=${row.square_multiplier}`,
    );
  }

  // 4. Check items
  const itemRows = await sql`
    SELECT bei.*, e.slug, bsp.label AS product_label, bsp.price_cents, bsp.is_active AS product_active
    FROM bowling_experience_items bei
    JOIN bowling_experiences e ON e.id = bei.experience_id
    LEFT JOIN bowling_square_products bsp ON bsp.square_catalog_object_id = bei.square_catalog_object_id AND bsp.center_code = 'TXBSQN0FEKQ11'
    WHERE e.slug IN ('vip-fri-sun', 'regular-fri-sun')
    ORDER BY e.slug, bei.sort_order
  `;
  console.log("\nItems (FM only):");
  for (const r of itemRows) {
    const row = r as Record<string, unknown>;
    console.log(
      `  slug=${row.slug}  catalogId=${row.square_catalog_object_id}  qty=${row.quantity}  product="${row.product_label}"  price=${row.price_cents}  productActive=${row.product_active}`,
    );
  }

  console.log("\n══ QAMF check ════════════════════════════════════════════════════");
  const today = new Date().toISOString().slice(0, 10);
  const saturday = (() => {
    const d = new Date();
    d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7) || 7);
    return d.toISOString().slice(0, 10);
  })();
  console.log(`Checking today (${today}) and next Saturday (${saturday}):`);

  const token = await mintToken(9172);

  // FM VIP Fri-Sun offer 159, Regular Fri-Sun offer 158
  await checkAvailability(9172, 159, today, token);
  await checkAvailability(9172, 158, today, token);
  await checkAvailability(9172, 159, saturday, token);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
