/**
 * Re-legible waiver backfill — push a VISIBLE "Digitally Accepted" mark for
 * every guest whose real signature went to BMI as white-ink-on-transparent and
 * is therefore invisible on their profile (root cause fixed 2026-08-08).
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * Not a re-sign, and not an assertion that we hold their handwriting. These
 * people PHYSICALLY SIGNED and we can prove it per person: waiver_sign_attempts
 * records who signed, for whom, when, from which IP/user-agent, how many bytes
 * of ink, and the waiverID BMI returned. The waiver RECORD in BMI is valid and
 * untouched. Only the IMAGE is unreadable. This adds a legible mark ALONGSIDE
 * it, captioned with the date they actually signed.
 *
 * ── Guardrails (this writes legal records; it refuses to guess) ─────────────
 *   - Only people whose latest attempt SUCCEEDED (signed/salvaged).
 *   - Only waivers still VALID — an expired waiver's image is moot.
 *   - Reuses the ORIGINAL invalidationDate, waiverContentID, locationID and
 *     sigPersonID. Nobody's coverage is shortened or extended by one day, and
 *     nobody's waiver moves centre.
 *   - MINORS (guardian-signed, sigPersonID != personID) are EXCLUDED unless
 *     --include-minors is passed explicitly. The mark then names the GUARDIAN
 *     as signer, which is what actually happened.
 *   - IDEMPOTENT: a waiver_acceptances row with this terms_version means the
 *     person is done. Safe to re-run after an interruption.
 *   - The signature image is stored in Neon (waiver_signatures) as it goes, so
 *     from here on we hold what we sent.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/waiver-relegible-backfill.mts                    # DRY RUN
 *   npx tsx scripts/waiver-relegible-backfill.mts --limit=5 --live   # toe in
 *   npx tsx scripts/waiver-relegible-backfill.mts --live             # adults
 *   npx tsx scripts/waiver-relegible-backfill.mts --live --include-minors
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createElement as h } from "react";
import { ImageResponse } from "next/og";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const PANDORA = "https://bma-pandora-api.azurewebsites.net/v2";
const KEY = process.env.SWAGGER_ADMIN_KEY || "";

const LIVE = process.argv.includes("--live");
const INCLUDE_MINORS = process.argv.includes("--include-minors");
/** Sample ONLY guardian-signed rows — so a small verification batch can cover
 *  the guardian wording, which the adult wording never exercises. */
const MINORS_ONLY = process.argv.includes("--minors-only");
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1] || 0);
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1];

/** Marks this backfill in waiver_acceptances — also the idempotency key. */
const TERMS_VERSION = "relegible-2026-08-08";

const { storeWaiverSignature, settleWaiverSignature } = await import(
  "@/lib/waiver-signature-store"
);

// ── population ──────────────────────────────────────────────────────────────
/** UTC — used only to compare against stored invalidationDate strings. */
const today = new Date().toISOString().slice(0, 10);
/** EASTERN, for anything a human reads. The mark's other date (when they
 *  signed) is ET, and an evening run rolls UTC to tomorrow — printing
 *  "re-rendered 2026-08-09" on a record made the evening of the 8th. */
const todayEt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const all = (await sql`
  SELECT DISTINCT ON (person_id)
         person_id, signer_person_id, waiver_content_id, location_id,
         invalidation_date, outcome, ts
  FROM waiver_sign_attempts
  WHERE outcome IN ('signed','salvaged')
  ORDER BY person_id, ts DESC`) as any[];

const done = new Set(
  (
    (await sql`
      SELECT DISTINCT person_id FROM waiver_acceptances
      WHERE terms_version = ${TERMS_VERSION}`) as any[]
  ).map((r) => String(r.person_id)),
);

let targets = all
  .filter((r) => (r.invalidation_date ?? "") > today)
  .filter((r) => !done.has(String(r.person_id)))
  .filter((r) =>
    MINORS_ONLY
      ? String(r.signer_person_id) !== String(r.person_id)
      : INCLUDE_MINORS || String(r.signer_person_id) === String(r.person_id),
  );
if (ONLY) targets = targets.filter((r) => String(r.person_id) === ONLY);
if (LIMIT > 0) targets = targets.slice(0, LIMIT);

const minorCount = targets.filter(
  (r) => String(r.signer_person_id) !== String(r.person_id),
).length;

console.log(`${LIVE ? "🔴 LIVE — WRITES TO BMI" : "🟢 DRY RUN"}  terms=${TERMS_VERSION}`);
console.log(`  candidates      : ${all.length}`);
console.log(`  already done    : ${done.size}`);
console.log(`  minors included : ${INCLUDE_MINORS ? `YES (${minorCount} guardian-signed)` : "no"}`);
console.log(`  TO PROCESS      : ${targets.length}\n`);
if (targets.length === 0) process.exit(0);

// ── helpers ─────────────────────────────────────────────────────────────────
/** Name for the mark: BMI is authoritative, our log is the fallback. */
async function nameFor(personId: string, locationId: string): Promise<string> {
  try {
    const r = await fetch(
      `${PANDORA}/bmi/person/${locationId}/${personId}?picture=false&allRelated=false`,
      { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(12000) },
    );
    const d = ((await r.json().catch(() => null)) as any)?.data;
    const n = [d?.firstName, d?.lastName].filter(Boolean).join(" ").trim();
    if (n) return n;
  } catch {
    /* fall through */
  }
  const rows = (await sql`
    SELECT first_name FROM waiver_acceptances
    WHERE person_id = ${personId} AND first_name IS NOT NULL
    ORDER BY ts DESC LIMIT 1`) as any[];
  return (rows[0]?.first_name as string) || "";
}

const fmtEt = (ts: any) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(ts));

/** Dark ink on an opaque white page — the whole point of the exercise. */
async function markPng(opts: {
  name: string;
  signedEt: string;
  byGuardian: boolean;
}): Promise<Buffer> {
  const img = new ImageResponse(
    h(
      "div",
      {
        style: {
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#ffffff",
          color: "#0a0a0a",
          fontFamily: "system-ui, sans-serif",
          padding: "36px 48px",
        },
      },
      h("div", { style: { fontSize: 54, fontWeight: 800, letterSpacing: -1 } }, "Digitally Accepted"),
      h("div", { style: { fontSize: 34, fontWeight: 600, marginTop: 6 } }, opts.name),
      h(
        "div",
        { style: { fontSize: 24, color: "#444", marginTop: 14 } },
        `Signed electronically ${opts.signedEt}${opts.byGuardian ? " by parent/guardian" : ""}`,
      ),
      h(
        "div",
        { style: { fontSize: 17, color: "#666", marginTop: 8 } },
        "Signature captured at signing and retained on file; re-rendered legibly " +
          `${todayEt}. Electronic acceptance per E-SIGN / FL UETA §668.50.`,
      ),
    ),
    { width: 1000, height: 420 },
  );
  return Buffer.from(await img.arrayBuffer());
}

// ── run ─────────────────────────────────────────────────────────────────────
let ok = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  const personId = String(t.person_id);
  const signerId = String(t.signer_person_id);
  const byGuardian = signerId !== personId;
  const name = await nameFor(personId, t.location_id);
  if (!name) {
    skipped++;
    console.log(`  ? ${personId} — no name available anywhere, skipped`);
    continue;
  }
  const signedEt = fmtEt(t.ts);

  if (!LIVE) {
    if (i < 10 || i % 250 === 0)
      console.log(
        `  · ${personId} "${name}"${byGuardian ? " (guardian)" : ""} signed ${signedEt} → expiry ${t.invalidation_date} loc ${t.location_id}`,
      );
    ok++;
    continue;
  }

  const png = await markPng({ name, signedEt, byGuardian });
  const sigRow = await storeWaiverSignature({
    personId,
    signerPersonId: signerId,
    waiverContentId: String(t.waiver_content_id),
    locationId: String(t.location_id),
    invalidationDate: String(t.invalidation_date),
    signatureBase64: png.toString("base64"),
    signatureBytes: png.length,
  });

  // Pandora cold-starts and throws transient 5xx — retry, same as the route.
  let lastErr = "";
  let waiverID: string | null = null;
  for (let attempt = 1; attempt <= 3 && !waiverID; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 800 * (attempt - 1)));
    const boundary = `----PandoraWaiver${Date.now()}${i}`;
    const parts: Buffer[] = [];
    const field = (n: string, v: string) =>
      parts.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`),
      );
    field("locationID", String(t.location_id));
    field("personID", personId);
    field("waiverContentID", String(t.waiver_content_id));
    field("sigPersonID", signerId);
    field("invalidationDate", String(t.invalidation_date));
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="signature"; filename="signature.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
    );
    parts.push(png);
    parts.push(Buffer.from("\r\n"));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    try {
      const res = await fetch(`${PANDORA}/bmi/waiver`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: new Uint8Array(Buffer.concat(parts)),
        signal: AbortSignal.timeout(30000),
      });
      const data = (await res.json().catch(() => null)) as any;
      const id = data?.data?.waiverID || data?.waiverID;
      if (res.ok && data?.success !== false && id) waiverID = String(id);
      else lastErr = `HTTP ${res.status} ${data?.message ?? ""}`.trim();
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  await settleWaiverSignature(sigRow, waiverID ? "signed" : "failed", waiverID);

  if (!waiverID) {
    failed++;
    failures.push(`${personId} "${name}" — ${lastErr}`);
    console.log(`  ✗ ${personId} "${name}" — ${lastErr}`);
    continue;
  }

  // Audit row — ALSO the idempotency key for a re-run.
  await sql`
    INSERT INTO waiver_acceptances
      (ts, terms_version, first_name, person_id, waiver_id, method, center, signed_by_person_id)
    VALUES (NOW(), ${TERMS_VERSION}, ${name}, ${personId}, ${waiverID}, 'backfill',
            ${String(t.location_id)}, ${byGuardian ? signerId : null})`;

  ok++;
  if (ok % 25 === 0) console.log(`  …${ok} marked (${i + 1}/${targets.length})`);
}

console.log(`\n══════ ${LIVE ? "DONE" : "DRY RUN"} ══════`);
console.log(`  marked   : ${ok}`);
console.log(`  failed   : ${failed}`);
console.log(`  skipped  : ${skipped}  (no name available)`);
if (failures.length) {
  console.log(`\n  failures (re-runnable — idempotency skips the successes):`);
  for (const f of failures.slice(0, 40)) console.log(`    ${f}`);
}
process.exit(0);
