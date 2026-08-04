/**
 * Christmas in July (2026-07-30, Fort Myers) — digital waiver backfill.
 *
 * Same mechanism as the Health Net backfill (2026-06-18): every guest who went
 * through the racer onboarding funnel (name → DOB → waiver) but whose waiver
 * never persisted in BMI gets a "Digitally Accepted" mark pushed via Pandora
 * (`POST /v2/bmi/waiver`), plus an attributable `waiver_acceptances` audit row
 * with `method: "backfill"`.
 *
 * Guardrails baked in — this writes legal records, so it refuses to guess:
 *   - Only RSVPs that carry a BMI personId (i.e. that actually entered the
 *     waiver-gated racer funnel). Naples RSVPs are excluded outright.
 *   - `skipIfValid` — never overwrites an existing valid waiver. Re-runnable.
 *   - MINORS ARE NEVER BACKFILLED. A guardian signs in person, at the desk.
 *   - Unknown birthdate = treated as a minor risk → skipped, reported.
 *   - The signature mark is captioned with the date the guest completed the
 *     RSVP funnel (their actual acceptance), not the date of this run.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/xmas-waiver-backfill.mts                    # DRY RUN (default)
 *   npx tsx scripts/xmas-waiver-backfill.mts --only=a@b.com --live   # one guest
 *   npx tsx scripts/xmas-waiver-backfill.mts --live             # backfill everyone
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const SLUG = "xmas-in-july";
const PANDORA_URL = "https://bma-pandora-api.azurewebsites.net/v2";
const API_KEY = process.env.SWAGGER_ADMIN_KEY || "";

const LIVE = process.argv.includes("--live");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1]?.toLowerCase();

const redis = (await import("@/lib/redis")).default;
const { getGroupEvent } = await import("@/lib/group-events");
const { resolvePandoraLocation } = await import("@/lib/pandora-locations");
const { signWaiverDigital, renderDigitallyAcceptedPng, WAIVER_TERMS_VERSION, WAIVER_VALID_DAYS } =
  await import("@/lib/waiver-digital");
const { logWaiverAcceptance } = await import("@/lib/waiver-acceptance");

interface Rsvp {
  name: string;
  email: string;
  reservations?: { type: string; track?: string; time?: string }[];
  personId?: string;
  location?: string;
  phone?: string;
  updatedAt?: string;
}

const event = getGroupEvent(SLUG);
if (!event) throw new Error(`group event ${SLUG} not found`);
const locationKey = event.pandoraLocation ?? "headpinz";
const locationID = resolvePandoraLocation(locationKey);

console.log(`${LIVE ? "🔴 LIVE" : "🟢 DRY RUN"} — ${SLUG} waiver backfill`);
console.log(`location ${locationKey} → ${locationID} · terms ${WAIVER_TERMS_VERSION} · validity ${WAIVER_VALID_DAYS}d\n`);

// ── Load the roster ────────────────────────────────────────────────────────
const emails: string[] = await redis.smembers(`groupevent:${SLUG}:rsvp-index`);
const rsvps: Rsvp[] = [];
for (const e of emails) {
  const raw = await redis.get(`groupevent:${SLUG}:rsvp:${e.toLowerCase()}`);
  if (raw) rsvps.push(JSON.parse(raw) as Rsvp);
}

/** Read a BMI person, retrying Pandora's transient 5xx cold starts. */
async function readPerson(personId: string, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    if (i > 1) await new Promise((r) => setTimeout(r, 900 * (i - 1)));
    let res: Response;
    try {
      res = await fetch(
        `${PANDORA_URL}/bmi/person/${locationID}/${personId}?picture=false&allRelated=false`,
        { headers: { Authorization: `Bearer ${API_KEY}` }, cache: "no-store" },
      );
    } catch {
      continue;
    }
    if (res.ok) {
      const p = (await res.json())?.data ?? {};
      return {
        ok: true as const,
        waiverExpiry: p.waiverExpiry ? String(p.waiverExpiry) : null,
        birthdate: p.birthdate ? String(p.birthdate) : null,
        // The RSVP stores an abbreviated display name ("Jacob E."). A waiver
        // signature must carry the guest's FULL legal name — take it from BMI.
        fullName: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim(),
      };
    }
    if (res.status < 500) return { ok: false as const, err: `HTTP ${res.status}` };
  }
  return { ok: false as const, err: "HTTP 5xx after retries" };
}

const ageOn = (birthdate: string | null, when = new Date()) => {
  if (!birthdate) return null;
  const b = new Date(birthdate);
  if (Number.isNaN(b.getTime())) return null;
  let a = when.getFullYear() - b.getFullYear();
  const m = when.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && when.getDate() < b.getDate())) a--;
  return a;
};

/** Caption date = when the guest actually completed the RSVP/waiver funnel. */
const captionDate = (iso?: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "long",
    timeStyle: "short",
  }).format(iso ? new Date(iso) : new Date());

// ── Classify ───────────────────────────────────────────────────────────────
interface Plan extends Rsvp {
  personId: string;
  age: number | null;
  caption: string;
  racing: boolean;
  /** Full legal name off the BMI person record — what the signature mark shows. */
  fullName: string;
}
const todo: Plan[] = [];
const skipped = {
  naples: [] as string[],
  noPerson: [] as string[],
  alreadyValid: [] as string[],
  minor: [] as string[],
  unknownAge: [] as string[],
  unreadable: [] as string[],
};

const now = Date.now();
for (const r of rsvps) {
  const who = `${r.name} <${r.email}>`;
  if (ONLY && r.email.toLowerCase() !== ONLY) continue;
  if (r.location === "naples") {
    skipped.naples.push(who);
    continue;
  }
  if (!r.personId) {
    skipped.noPerson.push(who);
    continue;
  }
  const p = await readPerson(r.personId);
  if (!p.ok) {
    skipped.unreadable.push(`${r.personId} ${who} — ${p.err}`);
    continue;
  }
  if (p.waiverExpiry && new Date(p.waiverExpiry).getTime() > now) {
    skipped.alreadyValid.push(`${who} — expires ${p.waiverExpiry.slice(0, 10)}`);
    continue;
  }
  const age = ageOn(p.birthdate);
  if (age === null) {
    skipped.unknownAge.push(`${r.personId} ${who} — no birthdate on the BMI record`);
    continue;
  }
  if (age < 18) {
    skipped.minor.push(`${r.personId} ${who} — age ${age}`);
    continue;
  }
  if (!p.fullName) {
    skipped.unreadable.push(`${r.personId} ${who} — no name on the BMI record`);
    continue;
  }
  todo.push({
    ...r,
    personId: r.personId,
    age,
    caption: captionDate(r.updatedAt),
    racing: (r.reservations || []).some((x) => x.type === "racing"),
    fullName: p.fullName,
  });
}

console.log("── TO BACKFILL ────────────────────────────────────────────");
console.log("personId    | age | racing | signature caption date        | name on signature / email");
for (const t of todo) {
  console.log(
    `${t.personId.padEnd(11)} | ${String(t.age).padEnd(3)} | ${(t.racing ? "yes" : "no").padEnd(6)} | ${t.caption.padEnd(29)} | ${t.fullName} <${t.email}>`,
  );
}
console.log(`\ncount: ${todo.length}  (racers ${todo.filter((t) => t.racing).length}, no heat booked ${todo.filter((t) => !t.racing).length})`);

console.log("\n── SKIPPED ────────────────────────────────────────────────");
for (const [k, v] of Object.entries(skipped)) {
  console.log(`${k}: ${v.length}`);
  if (v.length && (k === "minor" || k === "unknownAge" || k === "unreadable")) {
    console.log(v.map((l) => `    ⚠ ${l}`).join("\n"));
  }
}

if (!LIVE) {
  // Prove the PNG renderer works under tsx and let the owner eyeball the mark.
  const sample = todo[0];
  if (sample) {
    const png = await renderDigitallyAcceptedPng({ name: sample.fullName, dateEt: sample.caption });
    const out = resolve(process.cwd(), "scripts/.data/waiver-mark-sample.png");
    mkdirSync(resolve(process.cwd(), "scripts/.data"), { recursive: true });
    writeFileSync(out, png);
    console.log(`\nsample signature mark → ${out} (${png.length} bytes)`);
  }
  console.log("\nDRY RUN — nothing written. Re-run with --live to push.");
  process.exit(0);
}

// ── Live push ──────────────────────────────────────────────────────────────
console.log("\n── SIGNING ────────────────────────────────────────────────");
const done: string[] = [];
const failed: string[] = [];
for (const t of todo) {
  try {
    const r = await signWaiverDigital({
      personId: t.personId,
      name: t.fullName,
      locationKey,
      dateEt: t.caption,
      skipIfValid: true, // idempotent — a re-run never double-signs
    });
    if (r.skipped) {
      console.log(`~ ${t.personId} ${t.fullName} — already valid, skipped`);
      continue;
    }
    await logWaiverAcceptance({
      ts: new Date().toISOString(),
      ipAddress: "backfill",
      userAgent: "",
      termsVersion: r.termsVersion,
      email: t.email,
      phone: t.phone,
      firstName: (t.fullName || "").trim().split(/\s+/)[0] || undefined,
      personId: t.personId,
      waiverId: r.waiverID,
      method: "backfill",
      eventSlug: SLUG,
    });
    done.push(`${t.personId} ${t.fullName} waiverID=${r.waiverID} expires=${r.invalidationDate}`);
    console.log(`✓ ${t.personId} ${t.fullName} → waiverID ${r.waiverID} (expires ${r.invalidationDate})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failed.push(`${t.personId} ${t.fullName} <${t.email}> — ${msg}`);
    console.error(`✗ ${t.personId} ${t.fullName} — ${msg}`);
  }
  await new Promise((r) => setTimeout(r, 400)); // be kind to Pandora
}

// ── Readback verification — never trust the write, check BMI ───────────────
console.log("\n── VERIFY (readback from BMI) ─────────────────────────────");
let verified = 0;
const unverified: string[] = [];
for (const t of todo) {
  const p = await readPerson(t.personId);
  const ok = p.ok && !!p.waiverExpiry && new Date(p.waiverExpiry).getTime() > Date.now();
  if (ok) verified++;
  else unverified.push(`${t.personId} ${t.fullName} <${t.email}> — ${p.ok ? "no future waiverExpiry" : p.err}`);
}
console.log(`verified valid in BMI: ${verified}/${todo.length}`);
if (unverified.length) console.log(unverified.map((l) => `   ✗ ${l}`).join("\n"));

console.log(`\nsigned ${done.length} · failed ${failed.length}`);
if (failed.length) console.log(failed.map((l) => `   ✗ ${l}`).join("\n"));
process.exit(0);
