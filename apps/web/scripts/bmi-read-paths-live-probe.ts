/**
 * bmi-read-paths-live-probe — LIVE, READ-ONLY.
 *
 * The reuse probe only exercised /metadata and /dayPlanner. This covers the
 * REST of the endpoints the stable-session-id change touched, and does it two
 * ways:
 *
 *   A. PER-ENDPOINT stable-vs-fresh, raw. Each endpoint gets the same
 *      interleaved-pair treatment: fresh random id, then the stable id, bodies
 *      compared. Catches an endpoint that tolerates a reused session id on
 *      dayPlanner but not on, say, a POST lookup.
 *   B. INTEGRATION. Calls the actual exported functions from
 *      lib/bmi-office-actions (fetchProject, fetchProjectRawIds,
 *      fetchPersonsByIds, fetchOfficePerson, fetchOfficeDepositHistory) so the
 *      real `readHeaders` path runs, not a copy of it.
 *
 * Why B needs care: fetchOfficePerson and fetchOfficeDepositHistory swallow
 * every error and return null. A null is therefore NOT a pass — it is
 * INCONCLUSIVE, and gets a raw control call to tell "no data" apart from "the
 * stable id was rejected". Counting a swallowed 4xx as success is exactly the
 * trap this probe exists to avoid.
 *
 * WRITES: none. GET /project, GET /person, GET /deposit/history, GET /search,
 * POST /personprofile/personsByIds (a lookup, despite the verb).
 *
 *   npx tsx --env-file=../../.env.local scripts/bmi-read-paths-live-probe.ts
 */

import https from "https";
import { createHash, randomUUID } from "crypto";
import { officeReadSessionId } from "../lib/bmi-office-ids";
import {
  fetchProject,
  fetchProjectRawIds,
  fetchPersonsByIds,
  fetchOfficePerson,
  fetchOfficeDepositHistory,
} from "../lib/bmi-office-actions";

const OFFICE_HOST = "office-api22.sms-timing.com";
const SMS_VERSION = "6251006 202511051229";

/** Env only — see the note in bmi-session-id-reuse-probe.ts. */
const envUser = process.env.BMI_OFFICE_USERNAME;
const envPass = process.env.BMI_OFFICE_PASSWORD_B64
  ? Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD;
if (!envUser || !envPass) {
  console.error("Need BMI_OFFICE_USERNAME and BMI_OFFICE_PASSWORD(_B64) — use --env-file.");
  process.exit(2);
}
const OFFICE_USER: string = envUser;
const OFFICE_PASS: string = envPass;
const CK = "headpinzftmyers";
const CENTER_CODE = "fort-myers";

let failures = 0;
let inconclusive = 0;
const fail = (m: string) => {
  failures++;
  console.log(`   FAIL  ${m}`);
};
const pass = (m: string) => console.log(`   ok    ${m}`);
const meh = (m: string) => {
  inconclusive++;
  console.log(`   ?     ${m}`);
};

function req(method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string; ms: number }>((resolve, reject) => {
    const t0 = Date.now();
    const r = https.request(
      {
        hostname: OFFICE_HOST,
        path,
        method,
        headers: { ...headers, "Content-Type": "application/json" },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d, ms: Date.now() - t0 }));
      },
    );
    r.on("error", reject);
    r.setTimeout(45_000, () => {
      r.destroy();
      reject(new Error("timeout"));
    });
    if (body) r.write(body);
    r.end();
  });
}

const H = (tok: string, sid: string) => ({
  Authorization: `Bearer ${tok}`,
  "x-fast-version": SMS_VERSION,
  "x-session-id": sid,
  clientkey: CK,
});

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
/** See bmi-session-id-reuse-probe: projectReference is re-salted per response. */
const normalize = (s: string) =>
  s.replace(/"projectReference":"[^"]*"/g, '"projectReference":"<salted>"');

/** One endpoint, fresh id vs stable id, back to back. */
async function comparePair(
  label: string,
  tok: string,
  method: string,
  path: string,
  body?: string,
) {
  const stable = officeReadSessionId("read", CK);
  const a = await req(method, path, H(tok, randomUUID()), body);
  const b = await req(method, path, H(tok, stable), body);
  if (a.status !== b.status) {
    fail(`${label}: fresh id → ${a.status} but stable id → ${b.status}`);
    return;
  }
  if (b.status >= 400) {
    meh(`${label}: both ids → ${b.status} (endpoint/data issue, not session-id related)`);
    return;
  }
  const same = hash(normalize(a.body)) === hash(normalize(b.body));
  if (same) pass(`${label}: ${b.status}, identical under both ids (${b.body.length}b, ${b.ms}ms)`);
  else fail(`${label}: ${b.status} but bodies DIFFER between fresh and stable id`);
}

async function main() {
  console.log("BMI Office — changed read paths, live (READ-ONLY)\n");

  const auth = await req(
    "POST",
    "/auth/token",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: CK,
      "x-fast-version": SMS_VERSION,
    },
    `grant_type=password&username=${OFFICE_USER}&password=${encodeURIComponent(OFFICE_PASS)}`,
  );
  if (auth.status !== 200) throw new Error(`auth → ${auth.status}`);
  const tok = JSON.parse(auth.body).access_token;
  const stable = officeReadSessionId("read", CK);

  // Real ids to probe with, taken from today's planner.
  const meta = await req("GET", `/api/${CK}/metadata`, H(tok, stable));
  const parsed = JSON.parse(meta.body);
  const ids = new Set<string>();
  for (const r of (parsed.resources || []) as Array<{ id: string }>) ids.add(String(r.id));
  for (const g of (parsed.resourceGroups || []) as Array<{ resources?: Array<{ id: string }> }>) {
    for (const r of g.resources || []) ids.add(String(r.id));
  }
  const rp = [...ids].map((i) => `resourceIds=${i}`).join("&");
  const today = new Date().toISOString().slice(0, 10);
  const dp = await req(
    "GET",
    `/api/${CK}/dayPlanner?${rp}&from=${today}&till=${today}&showAll=true`,
    H(tok, stable),
  );
  // Raw-text id extraction — never JSON.parse a 17-digit BMI id. Office quotes
  // them ("id":"63000000008894418"), and project objects are flat, so one
  // regex can pair a personId with the id from the SAME object.
  const projects = (JSON.parse(dp.body).reservations?.projects || []) as Array<{
    number?: string;
  }>;
  const projSlice = dp.body.slice(dp.body.indexOf('"projects":['));
  const pairs = [...projSlice.matchAll(/"personId":"(\d{4,})"[^{}]*?"id":"(\d{6,})"/g)].map(
    (m) => ({
      personId: m[1],
      projectId: m[2],
    }),
  );
  const subject = pairs.find((p) => p.personId !== "0");
  const projectId = subject?.projectId;
  const personId = subject?.personId;
  const resNumber = projects.find((p) => p.number)?.number;

  console.log(
    `subjects: project=${projectId ?? "none"} person=${personId ?? "none"} res=${resNumber ?? "none"} ` +
      `(${projects.length} projects today)`,
  );
  if (!projectId || !personId) {
    fail("could not find a live project/person to probe — cannot verify these endpoints");
    process.exit(1);
  }

  // ── A. Per-endpoint stable-vs-fresh ─────────────────────────────
  console.log("\n── A. per-endpoint: fresh id vs stable id ──────────────");
  await comparePair("GET  /project/{id}", tok, "GET", `/api/${CK}/project/${projectId}`);
  await comparePair("GET  /person/{id}", tok, "GET", `/api/${CK}/person/${personId}`);
  const from = new Date(new Date().getFullYear() - 2, 0, 1).toISOString().split(".")[0];
  const until = new Date().toISOString().split(".")[0];
  await comparePair(
    "GET  /deposit/history",
    tok,
    "GET",
    `/api/${CK}/deposit/history?personId=${personId}&from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`,
  );
  await comparePair(
    "POST /personsByIds",
    tok,
    "POST",
    `/api/${CK}/personprofile/personsByIds`,
    `["${personId}"]`,
  );
  if (resNumber) {
    await comparePair(
      "GET  /search (verify path)",
      tok,
      "GET",
      `/api/${CK}/search?token=${encodeURIComponent(resNumber)}&maxResults=3`,
    );
  }

  // ── B. Integration: the real exported readers ───────────────────
  console.log("\n── B. real code path (lib/bmi-office-actions readHeaders) ──");

  const p1 = await fetchProject(CENTER_CODE, projectId);
  const p2 = await fetchProject(CENTER_CODE, projectId);
  if (p1 && p2)
    pass(`fetchProject x2 on one stable id → both non-null (state ${String(p1.stateId)})`);
  else fail(`fetchProject returned null (${!!p1}/${!!p2})`);

  const r1 = await fetchProjectRawIds(CK, projectId);
  if (!r1) fail("fetchProjectRawIds returned null");
  else {
    const bills = (r1.bills as Array<{ id?: unknown }> | undefined) ?? [];
    const bad = bills.filter((b) => typeof b.id === "number");
    if (bad.length) fail(`fetchProjectRawIds rounded ${bad.length} bill id(s) to Number`);
    else pass(`fetchProjectRawIds → ok, ${bills.length} bill(s), ids still raw strings`);
  }

  const persons = await fetchPersonsByIds(CENTER_CODE, [personId]);
  if (persons.length && String(persons[0].id) === personId) {
    pass(`fetchPersonsByIds → 1 row, id round-tripped exactly (${personId})`);
  } else if (persons.length) {
    fail(`fetchPersonsByIds id mismatch: asked ${personId}, got ${persons[0]?.id}`);
  } else {
    meh("fetchPersonsByIds → empty (swallows errors; see arm A for the raw status)");
  }

  const person = await fetchOfficePerson(personId, CK);
  if (person) pass(`fetchOfficePerson → non-null`);
  else meh("fetchOfficePerson → null (error-swallowing; see arm A raw status)");

  const dep = await fetchOfficeDepositHistory(personId, CK);
  if (dep !== null) pass(`fetchOfficeDepositHistory → ${dep.length} row(s)`);
  else meh("fetchOfficeDepositHistory → null (error-swallowing; see arm A raw status)");

  console.log(
    `\n${failures === 0 ? "PASS" : `FAIL (${failures})`} — live read-path probe complete` +
      (inconclusive ? `  [${inconclusive} inconclusive]` : ""),
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
