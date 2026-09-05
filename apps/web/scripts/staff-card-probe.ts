// Read-only: does the Office token search find a person by Intercard card
// number, and what tags does that person carry? Usage:
//   CARD=597195 npx tsx --env-file=.env.local scripts/staff-card-probe.mts
import https from "https";
import { randomUUID } from "crypto";
import { getOfficeToken } from "../lib/bmi-office-token";

const CARD = process.env.CARD || "597195";
const CLIENT_KEY = process.env.PROBE_CLIENT_KEY || "headpinzftmyers";
const SMS_VERSION = "6251006 202511051229";

function get(path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = https.get({ hostname: "office-api22.sms-timing.com", path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode || 500, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function main() {
  console.log(
    `env: user=${process.env.BMI_OFFICE_USERNAME ? "set" : "MISSING"} pass=${process.env.BMI_OFFICE_PASSWORD ? "set" : "MISSING"}`,
  );
  console.log("fetching Office token…");
  const token = await getOfficeToken(CLIENT_KEY);
  console.log(`token ok (${token.length} chars)`);
  const headers = {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    clientkey: CLIENT_KEY,
  };

  for (const tok of [CARD, CARD.padStart(16, "0")]) {
    const r = await get(
      `/api/${CLIENT_KEY}/search/person?token=${encodeURIComponent(tok)}&maxResults=50`,
      headers,
    );
    let hits: Array<{ localId: string; description: string }> = [];
    try {
      hits = JSON.parse(r.body.replace(/"localId":\s*(\d+)/g, '"localId":"$1"'));
    } catch {}
    console.log(
      `search token=${tok} → HTTP ${r.status}, ${Array.isArray(hits) ? hits.length : "?"} hit(s)`,
      Array.isArray(hits) ? "" : r.body.slice(0, 200),
    );
    for (const h of (Array.isArray(hits) ? hits : []).slice(0, 5)) {
      const p = await get(`/api/${CLIENT_KEY}/person/${h.localId}`, headers);
      let person: any = null;
      try {
        person = JSON.parse(p.body);
      } catch {}
      const tags = (person?.tags || []).map((t: any) => `${t.kind}:${t.tag}`);
      console.log(
        `  hit ${h.localId} "${h.description}" → ${person?.firstName ?? "?"} ${person?.name ?? "?"} tags=[${tags.join(", ")}]`,
      );
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
