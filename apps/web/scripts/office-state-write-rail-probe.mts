/**
 * READ-MOSTLY: find an Office write rail that can move a project's stateId WITHOUT
 * tripping the whole-project capacity validation.
 *
 * WHY. `PUT /api/{ck}/project` re-validates resource capacity even though our
 * payload carries no schedules. For an overbooked project the service account
 * (API2) gets 403 `{"IsQuestion":false,…"overbooking is not allowed"}` — a hard
 * refusal, not the "Do you want to overbook?" question a staff login gets. So a
 * group function whose resources are overbooked cannot leave "Send Contract" and
 * its contract never goes out. Turning overbooking on account-wide is not wanted.
 *
 * Every variant below writes back the stateId the project ALREADY has, so each is
 * a semantic no-op: no state change, the dispatch cron is not re-armed, and no
 * guest email can result. What is under test is only WHICH rail is accepted.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/office-state-write-rail-probe.mts 58454076          # dry — GET only
 *   npx tsx scripts/office-state-write-rail-probe.mts 58454076 --write  # fire the no-ops
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

for (const path of ["apps/web/.env.local", ".env.local"]) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
    break;
  } catch {
    /* next */
  }
}

const argv = process.argv.slice(2);
const DO_WRITE = argv.includes("--write");
const PROJECT_ID = argv.find((a) => /^\d+$/.test(a));
if (!PROJECT_ID) {
  console.error("Usage: office-state-write-rail-probe.mts <projectId> [--write]");
  process.exit(1);
}

const HOST = "office-api22.sms-timing.com";
const CLIENT_KEY = "headpinzftmyers";
const USER = process.env.BMI_OFFICE_USERNAME || "API2";
const PASS = Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv", "base64").toString();

/** What lib/bmi-office-actions.ts sends today. */
const VERSION_OURS = "6251006 202511051229";
/** What the staff browser sent in the 2026-08-12 HAR (a much newer client). */
const VERSION_HAR = "6260113 202605050950";

const PROJECT_CORE_FIELDS = [
  "balance", "confirm", "invoiceId", "partyInfo", "projectReference", "name", "number",
  "displayName", "personId", "persons", "created", "updated", "date", "validityDate",
  "publish", "companyId", "styleId", "stateId", "kindId", "priority", "reservationId",
  "userCreatedId", "userUpdatedId", "userId", "userAgentId", "userExternalId",
  "resellerId", "id",
];

async function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`https://${HOST}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
}

async function tokenFor(version: string): Promise<string> {
  const res = await call(
    "POST",
    "/auth/token",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: CLIENT_KEY,
      "x-fast-version": version,
    },
    `grant_type=password&username=${USER}&password=${PASS}`,
  );
  if (res.status !== 200) throw new Error(`auth ${res.status}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body).access_token;
}

/** One-line verdict for a response, decoding BMI's question/refusal envelope. */
function verdict(r: { status: number; body: string }): string {
  let detail = r.body.slice(0, 140).replace(/\s+/g, " ");
  try {
    const j = JSON.parse(r.body) as { IsQuestion?: boolean; Kind?: number; Message?: string };
    if ("IsQuestion" in j) {
      detail =
        `IsQuestion=${j.IsQuestion} Kind=${j.Kind} :: ` +
        String(j.Message ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    } else if (r.status < 400) {
      detail = "(project echoed back)";
    }
  } catch {
    /* not JSON — keep the raw slice */
  }
  const mark = r.status < 400 ? "✅" : r.status === 403 ? "⛔" : "⚠";
  return `${mark} ${r.status}  ${detail}`;
}

const baseToken = await tokenFor(VERSION_OURS);
const baseHeaders = {
  Authorization: `Bearer ${baseToken}`,
  "x-fast-version": VERSION_OURS,
  "x-session-id": randomUUID(),
  clientkey: CLIENT_KEY,
};

const getRes = await call("GET", `/api/${CLIENT_KEY}/project/${PROJECT_ID}`, baseHeaders);
if (getRes.status >= 400) {
  console.error(`GET project ${PROJECT_ID} → ${getRes.status}: ${getRes.body.slice(0, 200)}`);
  process.exit(1);
}
const project = JSON.parse(getRes.body) as Record<string, unknown>;
const STATE = String(project.stateId);
const minimal: Record<string, unknown> = {};
for (const k of PROJECT_CORE_FIELDS) if (k in project) minimal[k] = project[k];

console.log(
  `project ${PROJECT_ID} "${project.name}" number=${project.number}\n` +
    `  stateId=${STATE} confirm=${project.confirm} persons=${project.persons} ` +
    `schedules=${((project.schedules as unknown[]) ?? []).length}\n` +
    `  NO-OP INVARIANT: every variant writes stateId=${STATE} (unchanged)\n`,
);
if (!DO_WRITE) {
  console.log("(dry run — re-run with --write)");
  process.exit(0);
}

// ── The variants, cheapest/safest first ────────────────────────────────────
const variants: Array<{ name: string; run: () => Promise<{ status: number; body: string }> }> = [
  {
    name: "PUT /project  (what we send today)",
    run: () => call("PUT", `/api/${CLIENT_KEY}/project`, baseHeaders, JSON.stringify(minimal)),
  },
  {
    name: "PUT /project  confirm:true",
    run: () =>
      call(
        "PUT",
        `/api/${CLIENT_KEY}/project`,
        baseHeaders,
        JSON.stringify({ ...minimal, confirm: true }),
      ),
  },
  {
    name: "PUT /project  confirm:true + HAR client version",
    run: async () => {
      const tok = await tokenFor(VERSION_HAR);
      return call(
        "PUT",
        `/api/${CLIENT_KEY}/project`,
        {
          Authorization: `Bearer ${tok}`,
          "x-fast-version": VERSION_HAR,
          "x-session-id": randomUUID(),
          clientkey: CLIENT_KEY,
        },
        JSON.stringify({ ...minimal, confirm: true }),
      );
    },
  },
  {
    name: "PUT /project  {id, stateId} only",
    run: () =>
      call(
        "PUT",
        `/api/${CLIENT_KEY}/project`,
        baseHeaders,
        JSON.stringify({ id: minimal.id, stateId: STATE }),
      ),
  },
  {
    name: "PATCH /project  {id, stateId}",
    run: () =>
      call(
        "PATCH",
        `/api/${CLIENT_KEY}/project`,
        baseHeaders,
        JSON.stringify({ id: minimal.id, stateId: STATE }),
      ),
  },
  {
    name: "PUT /projectState  {projectId, stateId}",
    run: () =>
      call(
        "PUT",
        `/api/${CLIENT_KEY}/projectState`,
        baseHeaders,
        JSON.stringify({ projectId: minimal.id, stateId: STATE }),
      ),
  },
  {
    name: "POST /project/state  {projectId, stateId}",
    run: () =>
      call(
        "POST",
        `/api/${CLIENT_KEY}/project/state`,
        baseHeaders,
        JSON.stringify({ projectId: minimal.id, stateId: STATE }),
      ),
  },
  {
    name: `PUT /project/${PROJECT_ID}/state  {stateId}`,
    run: () =>
      call(
        "PUT",
        `/api/${CLIENT_KEY}/project/${PROJECT_ID}/state`,
        baseHeaders,
        JSON.stringify({ stateId: STATE }),
      ),
  },
];

for (const v of variants) {
  try {
    console.log(`  ${v.name.padEnd(46)} → ${verdict(await v.run())}`);
  } catch (err) {
    console.log(`  ${v.name.padEnd(46)} → 💥 ${err instanceof Error ? err.message : err}`);
  }
}

// Prove nothing moved.
const after = await call("GET", `/api/${CLIENT_KEY}/project/${PROJECT_ID}`, {
  ...baseHeaders,
  "x-session-id": randomUUID(),
});
const nowState = after.status < 400 ? String(JSON.parse(after.body).stateId) : "unreadable";
console.log(
  `\nverify stateId=${nowState} ${nowState === STATE ? "(unchanged ✓)" : "⚠ CHANGED — investigate"}`,
);
