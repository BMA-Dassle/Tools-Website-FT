/**
 * Query Google Search Console for URL inspection + coverage errors.
 * Also checks Bing Webmaster Tools if BING_WEBMASTER_TOKEN is set.
 * Run: node scripts/check-search-errors.mjs
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
for (const line of raw.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);

function makeJwt(scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: key.client_email, scope, aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600, iat: now,
  })).toString("base64url");
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  return `${header}.${payload}.${sign.sign(key.private_key, "base64url")}`;
}

async function getToken(scope = "https://www.googleapis.com/auth/webmasters.readonly") {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: makeJwt(scope) }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(JSON.stringify(d));
  return d.access_token;
}

async function inspectUrl(token, siteUrl, inspectionUrl) {
  const res = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inspectionUrl, siteUrl }),
  });
  return res.json();
}

async function getSitemapList(token, siteUrl) {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.json();
}

// Rich results / enhancements
async function getEnhancements(token, siteUrl) {
  // Search Console doesn't expose rich results errors via the public API directly,
  // but we can use the searchAnalytics with search type=discover/news for some signals.
  // Best we can do is check sitemap errors + URL inspection.
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: new Date(Date.now() - 28*86400000).toISOString().split("T")[0],
        endDate: new Date().toISOString().split("T")[0],
        dimensions: ["searchAppearance"],
        rowLimit: 25,
      }),
    }
  );
  return res.json();
}

const token = await getToken();
console.log("✅ Google Search Console authenticated\n");

const sites = [
  { url: "sc-domain:fasttraxent.com", label: "FastTrax", home: "https://fasttraxent.com/" },
  { url: "sc-domain:headpinz.com",    label: "HeadPinz", home: "https://headpinz.com/" },
];

for (const site of sites) {
  console.log(`${"═".repeat(60)}`);
  console.log(`${site.label}  (${site.url})`);
  console.log(`${"═".repeat(60)}`);

  // Sitemaps
  try {
    const sitemaps = await getSitemapList(token, site.url);
    if (sitemaps.sitemap?.length) {
      console.log("\n🗺  SITEMAPS");
      for (const sm of sitemaps.sitemap) {
        const errors = sm.errors || 0;
        const warnings = sm.warnings || 0;
        const indexed = sm.contents?.reduce((s, c) => s + (c.indexed || 0), 0) || "?";
        const submitted = sm.contents?.reduce((s, c) => s + (c.submitted || 0), 0) || "?";
        const status = errors > 0 ? "❌" : warnings > 0 ? "⚠️ " : "✅";
        console.log(`  ${status} ${sm.path}  indexed:${indexed}/${submitted}  errors:${errors}  warnings:${warnings}`);
      }
    }
  } catch(e) { console.log("  Sitemaps: " + e.message); }

  // Search appearance breakdown (FAQ, sitelinks, etc.)
  try {
    const enh = await getEnhancements(token, site.url);
    if (enh.rows?.length) {
      console.log("\n🎨  SEARCH APPEARANCE (last 28d)");
      for (const r of enh.rows) {
        console.log(`  ${r.keys[0].padEnd(35)} clicks:${String(r.clicks).padStart(5)}  impressions:${String(r.impressions).padStart(6)}  pos:${r.position.toFixed(1)}`);
      }
    } else {
      console.log("\n🎨  SEARCH APPEARANCE: " + (enh.error?.message || "no data"));
    }
  } catch(e) { console.log("  Appearances: " + e.message); }

  // URL inspection — key pages
  const urls = site.label === "FastTrax"
    ? ["https://fasttraxent.com/", "https://fasttraxent.com/pricing", "https://fasttraxent.com/group-events", "https://fasttraxent.com/racing"]
    : ["https://headpinz.com/", "https://headpinz.com/fort-myers", "https://headpinz.com/naples", "https://headpinz.com/fort-myers/group-events", "https://headpinz.com/naples/group-events"];

  console.log("\n🔍  URL INSPECTION");
  for (const url of urls) {
    try {
      const result = await inspectUrl(token, site.url, url);
      const r = result.inspectionResult;
      if (!r) { console.log(`  ❓ ${url}: ${JSON.stringify(result).substring(0, 100)}`); continue; }
      const verdict = r.indexStatusResult?.verdict || "UNKNOWN";
      const crawled = r.indexStatusResult?.lastCrawlTime ? new Date(r.indexStatusResult.lastCrawlTime).toLocaleDateString() : "never";
      const coverage = r.indexStatusResult?.coverageState || "";
      const mobile = r.mobileUsabilityResult?.verdict || "?";
      const richRes = r.richResultsResult?.detectedItems?.map(i => i.richResultType).join(", ") || "none";
      const richIssues = r.richResultsResult?.detectedItems?.flatMap(i => i.items?.flatMap(ii => ii.issues?.map(iss => `${iss.severity}: ${iss.issueMessage}`) || []) || []) || [];
      const icon = verdict === "PASS" ? "✅" : verdict === "NEUTRAL" ? "🟡" : "❌";
      console.log(`  ${icon} ${url.replace("https://fasttraxent.com","").replace("https://headpinz.com","") || "/"}`);
      console.log(`       verdict:${verdict}  coverage:${coverage}  crawled:${crawled}  mobile:${mobile}`);
      if (richRes !== "none") console.log(`       rich results: ${richRes}`);
      if (richIssues.length) richIssues.forEach(i => console.log(`       ⚠️  ${i}`));
    } catch(e) { console.log(`  ❌ ${url}: ${e.message}`); }
  }
  console.log("");
}

// Bing Webmaster
const bingToken = process.env.BING_WEBMASTER_TOKEN || process.env.BING_WEBMASTER_API_KEY;
if (bingToken) {
  console.log(`${"═".repeat(60)}`);
  console.log("BING WEBMASTER TOOLS");
  console.log(`${"═".repeat(60)}`);
  try {
    const bingSites = await fetch("https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=" + bingToken).then(r => r.json());
    console.log(JSON.stringify(bingSites, null, 2));
  } catch(e) { console.log("Bing error: " + e.message); }
} else {
  console.log("\n⚠️  BING: No BING_WEBMASTER_TOKEN in .env.local");
}
