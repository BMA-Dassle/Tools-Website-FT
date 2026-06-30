// Grant a POV (ViewPoint) video credit to everyone racing in a time window today.
//
// "POV" / "ViewPoint Credit" is a BMI deposit kind (id 46322806). The e-ticket
// page lets a racer claim POV unlock-codes against this balance
// (apps/web/app/api/pov-codes/route.ts deducts it). So "add a video credit" =
// add +1 to each racer's ViewPoint deposit balance via Pandora's deposit
// endpoint (POST /v2/bmi/deposit), the same write lib/pandora-deposits.ts does.
//
// Racer enumeration mirrors the pre-race-tickets cron exactly:
//   active tracks today (Blue+Red, or Mega Track on Tue)
//   → GET /bmi/sessions/{loc}?startDate&endDate&resourceName  (full ET day)
//   → keep heats whose scheduledStart is in [now - backMin, untilET]
//   → GET /bmi/session/{loc}/{sid}/participants (paid, non-removed, real personId)
//   → dedupe to one credit per unique person.
//
// SAFETY: dry-run by default — prints the roster + each racer's CURRENT
// ViewPoint balance so a prior run is visible (re-running double-grants;
// deposits are additive, never idempotent). Pass --apply to actually grant.
//
// Usage:
//   node apps/web/scripts/pov-credit-racing-now.mjs                 # dry run
//   node apps/web/scripts/pov-credit-racing-now.mjs --until=14:00   # set the cutoff (ET, 24h)
//   node apps/web/scripts/pov-credit-racing-now.mjs --back-min=15   # include heats that started up to N min ago
//   node apps/web/scripts/pov-credit-racing-now.mjs --amount=1      # credits per racer
//   node apps/web/scripts/pov-credit-racing-now.mjs --apply         # EXECUTE the grants

import fs from "node:fs";

// ── env ───────────────────────────────────────────────────────────────────
const ENV_PATH = "c:/GIT/Tools-Website-FT/apps/web/.env.local";
const env = fs.readFileSync(ENV_PATH, "utf8");
const envGet = (k) => {
  const m = env.match(new RegExp(`^${k}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
};

const API_KEY = envGet("SWAGGER_ADMIN_KEY");
if (!API_KEY) {
  console.error("Missing SWAGGER_ADMIN_KEY in .env.local");
  process.exit(1);
}
const VIEWPOINT_DEPOSIT_KIND_ID = envGet("VIEWPOINT_DEPOSIT_KIND_ID") || "46322806";

const PANDORA = "https://bma-pandora-api.azurewebsites.net/v2";
const LOCATION_ID = "LAB52GY480CJF"; // FastTrax Fort Myers
const PLACEHOLDER_PERSON_IDS = new Set(["17750277"]); // DRIVER 1 PLACEHOLDER

function authHeaders() {
  return {
    Authorization: `Bearer ${API_KEY}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

// Pandora (Azure App Service) is flaky under load — 502s/timeouts clear on a
// retry. Retry GETs on network error or 5xx with backoff; return the last
// response so 4xx surfaces normally.
async function fetchRetry(url, opts = {}, attempts = 4, delayMs = 800) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      last = res;
    } catch (e) {
      last = e;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
  }
  if (last instanceof Response) return last;
  throw last instanceof Error ? last : new Error("request failed");
}

// ── args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const arg = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
};
const UNTIL = arg("until", "14:00"); // ET, 24h "HH:MM"
const BACK_MIN = parseInt(arg("back-min", "15"), 10); // include heats started up to N min ago
const AMOUNT = parseInt(arg("amount", "1"), 10);
if (!/^\d{1,2}:\d{2}$/.test(UNTIL)) {
  console.error(`Bad --until="${UNTIL}" (want HH:MM, 24h ET)`);
  process.exit(1);
}
if (!Number.isFinite(AMOUNT) || AMOUNT === 0) {
  console.error(`Bad --amount=${AMOUNT} (must be a non-zero integer)`);
  process.exit(1);
}

// ── time window ─────────────────────────────────────────────────────────────
// ET date components for today, and the ET→UTC offset (June = EDT = -04:00, but
// derive it so the script is correct year-round).
function etParts(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (t) => f.find((p) => p.type === t).value;
  return { ymd: `${g("year")}-${g("month")}-${g("day")}` };
}
// Offset string like "-04:00" for America/New_York at instant d.
function etOffset(d = new Date()) {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName").value; // e.g. "GMT-04:00"
  const m = s.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : "-04:00";
}

const now = new Date();
const { ymd } = etParts(now);
const offset = etOffset(now);
const untilMs = new Date(`${ymd}T${UNTIL.padStart(5, "0")}:00${offset}`).getTime();
const windowStartMs = now.getTime() - BACK_MIN * 60_000;

// Full-ET-day range for the sessions API (Firebird is ET; naive datetime).
const startDate = `${ymd}T00:00:00`;
const endDate = `${ymd}T23:59:59`;

function activeResourcesForToday() {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);
  if (wd === "Tue") return ["Mega Track"];
  return ["Blue Track", "Red Track"];
}
const fmtET = (iso) =>
  new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });

// ── Pandora calls ────────────────────────────────────────────────────────
async function fetchSessions(resourceName) {
  const qs = new URLSearchParams({ startDate, endDate, resourceName }).toString();
  const res = await fetchRetry(`${PANDORA}/bmi/sessions/${LOCATION_ID}?${qs}`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    console.warn(
      `  ! sessions ${resourceName}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`,
    );
    return [];
  }
  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

async function fetchParticipants(sessionId) {
  const qs = new URLSearchParams({ excludeRemoved: "true", excludeUnpaid: "false" }).toString();
  const res = await fetchRetry(
    `${PANDORA}/bmi/session/${LOCATION_ID}/${sessionId}/participants?${qs}`,
    { headers: authHeaders(), cache: "no-store" },
  );
  if (!res.ok) {
    console.warn(`  ! participants ${sessionId}: HTTP ${res.status} (after retries) — INCOMPLETE`);
    return { incomplete: true, list: [] };
  }
  const json = await res.json();
  return { incomplete: false, list: Array.isArray(json?.data) ? json.data : [] };
}

// GET all deposit kinds + balances; return the ViewPoint balance (or 0).
async function viewpointBalance(personId) {
  try {
    const res = await fetchRetry(
      `${PANDORA}/bmi/deposits/${LOCATION_ID}/${encodeURIComponent(personId)}`,
      { headers: authHeaders(), cache: "no-store" },
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (!json?.success || !Array.isArray(json.data)) return null;
    const row = json.data.find((r) => String(r.OUT_DPK_ID) === VIEWPOINT_DEPOSIT_KIND_ID);
    return row ? row.OUT_DPS_AMOUNT : 0;
  } catch {
    return null;
  }
}

// POST one deposit row. Positive = add credits. Returns depositID or throws.
async function addDeposit(personId, amount) {
  const body = JSON.stringify({
    locationID: LOCATION_ID,
    personID: String(personId),
    depositKindID: VIEWPOINT_DEPOSIT_KIND_ID,
    amount,
  });
  const res = await fetch(`${PANDORA}/bmi/deposit`, {
    method: "POST",
    headers: authHeaders(),
    body,
    cache: "no-store",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !json?.success || !json?.data?.depositID) {
    throw new Error(json?.message || text.slice(0, 200) || `HTTP ${res.status}`);
  }
  return json.data.depositID;
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  const resources = activeResourcesForToday();
  console.log("════════════════════════════════════════════════════════════");
  console.log(`POV (ViewPoint) credit — racers in window  [${APPLY ? "APPLY" : "DRY RUN"}]`);
  console.log(`  date (ET):     ${ymd}  (offset ${offset})`);
  console.log(`  window:        ${fmtET(new Date(windowStartMs).toISOString())}  →  ${UNTIL} ET`);
  console.log(`  back-min:      ${BACK_MIN} (heats started up to this long ago are included)`);
  console.log(`  tracks:        ${resources.join(", ")}`);
  console.log(`  deposit kind:  ${VIEWPOINT_DEPOSIT_KIND_ID} (ViewPoint/POV)`);
  console.log(`  amount/racer:  +${AMOUNT}`);
  console.log("════════════════════════════════════════════════════════════\n");

  // 1. sessions in window
  const heats = [];
  for (const resourceName of resources) {
    const track = resourceName.replace(/ Track$/, "");
    const sessions = await fetchSessions(resourceName);
    for (const s of sessions) {
      const ms = new Date(s.scheduledStart).getTime();
      if (!Number.isNaN(ms) && ms >= windowStartMs && ms <= untilMs) {
        heats.push({ ...s, track });
      }
    }
  }
  heats.sort((a, b) => new Date(a.scheduledStart) - new Date(b.scheduledStart));

  if (heats.length === 0) {
    console.log("No heats scheduled in this window. Nothing to do.");
    return;
  }

  console.log(`Heats in window (${heats.length}):`);
  for (const h of heats) {
    console.log(
      `  • ${fmtET(h.scheduledStart)}  ${h.track} #${h.heatNumber}  ${h.type}  (session ${h.sessionId})`,
    );
  }
  console.log("");

  // 2. participants → dedupe to unique persons (track which heats each is in)
  const byPerson = new Map(); // personId -> { name, heats: [labels], firstSession }
  const incompleteHeats = [];
  for (const h of heats) {
    const { incomplete, list: parts } = await fetchParticipants(h.sessionId);
    if (incomplete)
      incompleteHeats.push(
        `${h.track} #${h.heatNumber} ${fmtET(h.scheduledStart)} (session ${h.sessionId})`,
      );
    for (const p of parts) {
      if (p.paid === false) continue; // unpaid — not actually racing
      const pid = p.personId == null ? "" : String(p.personId).trim();
      if (!pid || PLACEHOLDER_PERSON_IDS.has(pid)) continue;
      const label = `${h.track} #${h.heatNumber} ${fmtET(h.scheduledStart)}`;
      if (!byPerson.has(pid)) {
        byPerson.set(pid, {
          name: `${p.firstName || ""} ${p.lastName || ""}`.trim() || "(no name)",
          heats: [label],
        });
      } else {
        byPerson.get(pid).heats.push(label);
      }
    }
  }

  const persons = [...byPerson.entries()];
  if (persons.length === 0) {
    console.log("Heats found, but no paid racers on them yet. Nothing to do.");
    return;
  }

  // 3. current ViewPoint balances (so a prior run / pre-bought credit is visible)
  console.log(`Racers (${persons.length} unique):  [fetching current ViewPoint balances…]\n`);
  const balances = new Map();
  await Promise.all(persons.map(async ([pid]) => balances.set(pid, await viewpointBalance(pid))));

  for (const [pid, info] of persons) {
    const bal = balances.get(pid);
    const balStr = bal == null ? "bal=?" : `bal=${bal}`;
    const flag = bal && bal > 0 ? "  ⚠ ALREADY HAS CREDIT" : "";
    console.log(
      `  ${pid.padEnd(10)} ${info.name.padEnd(26)} ${balStr.padEnd(8)} ${info.heats.length > 1 ? `(${info.heats.length} heats) ` : ""}${info.heats[0]}${flag}`,
    );
  }
  const alreadyHave = persons.filter(([pid]) => (balances.get(pid) || 0) > 0).length;
  console.log("");
  console.log(
    `Summary: ${persons.length} racers; ${alreadyHave} already carry a ViewPoint balance > 0.`,
  );
  console.log(`Would grant +${AMOUNT} ViewPoint credit to each of the ${persons.length} racers.\n`);

  if (incompleteHeats.length > 0) {
    console.log(
      `⚠ ${incompleteHeats.length} heat(s) could NOT be read from Pandora (their racers are MISSING above):`,
    );
    for (const h of incompleteHeats) console.log(`    - ${h}`);
    console.log("");
    if (APPLY) {
      console.log(
        "REFUSING TO APPLY against an incomplete roster. Re-run when Pandora is healthy.",
      );
      process.exit(2);
    }
  }

  if (!APPLY) {
    console.log("DRY RUN — no writes performed. Re-run with --apply to grant the credits.");
    return;
  }

  // 4. APPLY — grant +AMOUNT to each unique racer, log every result.
  console.log("APPLYING grants…\n");
  const results = [];
  for (const [pid, info] of persons) {
    try {
      const depositId = await addDeposit(pid, AMOUNT);
      results.push({ personId: pid, name: info.name, amount: AMOUNT, depositId, ok: true });
      console.log(
        `  ✓ ${pid.padEnd(10)} ${info.name.padEnd(26)} +${AMOUNT}  depositId=${depositId}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ personId: pid, name: info.name, amount: AMOUNT, error: msg, ok: false });
      console.error(`  ✗ ${pid.padEnd(10)} ${info.name.padEnd(26)} FAILED: ${msg}`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const logPath = `c:/GIT/Tools-Website-FT/apps/web/scripts/_pov-credit-grant-log.json`;
  const logEntry = {
    ranAt: new Date().toISOString(),
    date: ymd,
    window: { from: new Date(windowStartMs).toISOString(), untilET: UNTIL, backMin: BACK_MIN },
    depositKindId: VIEWPOINT_DEPOSIT_KIND_ID,
    amountPerRacer: AMOUNT,
    granted: okCount,
    failed: failCount,
    results,
  };
  let allRuns = [];
  try {
    allRuns = JSON.parse(fs.readFileSync(logPath, "utf8"));
    if (!Array.isArray(allRuns)) allRuns = [];
  } catch {
    /* first run */
  }
  allRuns.push(logEntry);
  fs.writeFileSync(logPath, JSON.stringify(allRuns, null, 2));

  console.log("");
  console.log(`Done. Granted ${okCount}, failed ${failCount}. Log → ${logPath}`);
  if (failCount > 0) {
    console.log("Re-running --apply would DOUBLE-grant the successes — to retry only failures,");
    console.log("grant those personIds manually from the log.");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
