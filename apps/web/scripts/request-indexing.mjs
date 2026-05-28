/**
 * Request Google to (re)index specific URLs via Search Console URL Inspection API.
 * Run: node scripts/request-indexing.mjs
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
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    v = v.slice(1, -1);
  if (!process.env[k]) process.env[k] = v;
}

const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);

function makeJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/indexing",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    }),
  ).toString("base64url");
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  return `${header}.${payload}.${sign.sign(key.private_key, "base64url")}`;
}

async function getToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: makeJwt(),
    }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(JSON.stringify(d));
  return d.access_token;
}

// URLs to (re)ping. Pass `--url=<u>` flags on the CLI to override, e.g.:
//   node scripts/request-indexing.mjs --url=https://headpinz.com/foo --url=https://headpinz.com/bar
// Otherwise the default list below is used.
const cliUrls = process.argv
  .filter((a) => a.startsWith("--url="))
  .map((a) => a.slice("--url=".length));

const urls =
  cliUrls.length > 0
    ? cliUrls
    : [
        "https://headpinz.com/blog",
        "https://headpinz.com/blog/best-indoor-activities-fort-myers",
        // Pages whose internal-link graph changed when we added the blog —
        // re-ping so Google re-crawls and picks up the new outbound links.
        "https://headpinz.com/things-to-do-fort-myers",
      ];

const token = await getToken();
console.log("✅ Authenticated with Google Indexing API\n");

for (const url of urls) {
  const res = await fetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, type: "URL_UPDATED" }),
  });
  const data = await res.json();
  if (data.urlNotificationMetadata) {
    console.log(`✅ Requested: ${url}`);
  } else {
    console.log(`⚠️  ${url}: ${JSON.stringify(data)}`);
  }
}
