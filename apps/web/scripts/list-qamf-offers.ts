/**
 * List all QAMF web offers for both HeadPinz centers.
 * Usage: npx tsx scripts/list-qamf-offers.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

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

const TOKEN_URL = "https://api.qubicaamf.com/oauth2/token";
const BASE = "https://api.qubicaamf.com/bowling-reservations";
const API_VER = "2025-12-01.1.0";

const CENTERS = [
  { id: 9172, label: "Fort Myers" },
  { id: 3148, label: "Naples" },
];

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
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

async function listOffers(centerId: number, token: string) {
  const res = await fetch(`${BASE}/centers/${centerId}/weboffers`, {
    headers: { authorization: `Bearer ${token}`, "api-version": API_VER },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`listWebOffers(${centerId}) failed: ${res.status} ${text}`);
  const parsed = JSON.parse(text);
  // QAMF returns { WebOffers: [...] }
  const arr = Array.isArray(parsed) ? parsed : (parsed.WebOffers ?? []);
  return arr as Array<{
    Id: number;
    Title: string;
    IsEnabled: boolean;
    OpenType: string;
    Options: Record<string, Array<{ Id: number; GamesPerPlayer?: number; Minutes?: number }>>;
  }>;
}

async function main() {
  for (const { id, label } of CENTERS) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`${label} (center ${id})`);
    console.log("═".repeat(60));
    const token = await mintToken(id);
    const offers = await listOffers(id, token);
    for (const o of offers) {
      const opts = Object.entries(o.Options ?? {})
        .flatMap(([type, list]) =>
          (list ?? []).map((opt) => {
            const extra = opt.GamesPerPlayer
              ? ` games=${opt.GamesPerPlayer}`
              : opt.Minutes
                ? ` mins=${opt.Minutes}`
                : "";
            return `${type}:${opt.Id}${extra}`;
          }),
        )
        .join(", ");
      const enabled = o.IsEnabled ? "✓" : "✗";
      console.log(
        `  [${enabled}] id=${String(o.Id).padEnd(5)} type=${o.OpenType.padEnd(10)} "${o.Title}"${opts ? "  [" + opts + "]" : ""}`,
      );
    }
    console.log(`  Total: ${offers.length} offers`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
