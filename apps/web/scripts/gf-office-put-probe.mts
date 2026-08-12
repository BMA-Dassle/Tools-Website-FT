/**
 * Is the BMI Office `PUT /project` 403 still happening for a given project?
 *
 * Replicates `viaOfficeApi()` from lib/bmi-office-actions.ts EXACTLY (same
 * toMinimalProject payload, same headers) but writes back the stateId the
 * project ALREADY has. Semantically a no-op: no state change, the dispatch cron
 * is not re-armed, and no guest email can result. The only thing under test is
 * whether the Office write path returns 403 or 200 for this record.
 *
 * READ THE 403 BODY. Office returns 403 for two completely different things and
 * this probe used to call both "Office writes blocked":
 *   • a genuine block (bad token / no permission) — body is not JSON
 *   • a CAPACITY refusal — {"IsQuestion":…,"Kind":4,"Message":"Total persons (12)
 *     is higher than the capacity (0) in …","OperationId":"…"}, cleared by
 *     re-sending the same body with `confirm:true`. A per-RECORD condition, not
 *     an outage. Note our service account gets `IsQuestion:false` and the wording
 *     "overbooking is not allowed" — which is NOT final: confirm:true still 200s.
 *
 * Usage (from apps/web):
 *   npx tsx scripts/gf-office-put-probe.mts 57671353             # dry run — GET only
 *   npx tsx scripts/gf-office-put-probe.mts 57671353 --put       # fire the no-op PUT
 *   npx tsx scripts/gf-office-put-probe.mts 57671353 --put --confirm
 *                                          # …and confirm through a capacity refusal
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
const DO_PUT = argv.includes("--put");
const DO_CONFIRM = argv.includes("--confirm");
const PROJECT_IDS = argv.filter((a) => /^\d+$/.test(a));
if (!PROJECT_IDS.length) {
  console.error("Usage: gf-office-put-probe.mts <projectId...> [--put] [--confirm]");
  process.exit(1);
}

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "API2";
const OFFICE_PASS = Buffer.from(
  process.env.BMI_OFFICE_PASSWORD_B64 || "JGMxbjFlbGxv",
  "base64",
).toString();
const SMS_VERSION = "6251006 202511051229";
const CLIENT_KEY = "headpinzftmyers";

// Verbatim from lib/bmi-office-actions.ts PROJECT_CORE_FIELDS.
const PROJECT_CORE_FIELDS = [
  "balance", "confirm", "invoiceId", "partyInfo", "projectReference", "name", "number",
  "displayName", "personId", "persons", "created", "updated", "date", "validityDate",
  "publish", "companyId", "styleId", "stateId", "kindId", "priority", "reservationId",
  "userCreatedId", "userUpdatedId", "userId", "userAgentId", "userExternalId",
  "resellerId", "id",
];

async function office(method: string, path: string, headers: Record<string, string>, body?: string) {
  const res = await fetch(`https://${OFFICE_HOST}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
}

const auth = await office(
  "POST",
  "/auth/token",
  {
    "Content-Type": "application/x-www-form-urlencoded",
    clientkey: CLIENT_KEY,
    "x-fast-version": SMS_VERSION,
  },
  `grant_type=password&username=${OFFICE_USER}&password=${OFFICE_PASS}`,
);
if (auth.status !== 200) {
  console.error(`Office auth FAILED ${auth.status}: ${auth.body.slice(0, 300)}`);
  process.exit(1);
}
const token = JSON.parse(auth.body).access_token;
console.log(`Office auth OK (user=${OFFICE_USER})\n`);

for (const projectId of PROJECT_IDS) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "x-fast-version": SMS_VERSION,
    "x-session-id": randomUUID(),
    clientkey: CLIENT_KEY,
  };

  console.log(`── project ${projectId}`);
  const getRes = await office("GET", `/api/${CLIENT_KEY}/project/${projectId}`, headers);
  console.log(`   GET  → ${getRes.status}`);
  if (getRes.status >= 400) {
    console.log(`   ${getRes.body.slice(0, 300)}\n`);
    continue;
  }

  const project = JSON.parse(getRes.body) as Record<string, unknown>;
  const minimal: Record<string, unknown> = {};
  for (const k of PROJECT_CORE_FIELDS) if (k in project) minimal[k] = project[k];

  // BMI id-precision guard: this is a GET → mutate → PUT round-trip through
  // JSON, which silently rounds ids past 2^53. Abort rather than write a
  // corrupted personId/reservationId back into BMI.
  for (const k of ["id", "personId", "reservationId", "invoiceId", "companyId"]) {
    const v = minimal[k];
    if (typeof v === "number" && !Number.isSafeInteger(v)) {
      console.log(`   ⛔ ABORT: ${k}=${v} exceeds MAX_SAFE_INTEGER — would corrupt on PUT\n`);
      process.exit(1);
    }
  }

  const currentState = String(minimal.stateId);
  console.log(
    `   name="${project.name}" number=${project.number} stateId=${currentState} kindId=${project.kindId} personId=${minimal.personId}`,
  );
  console.log(`   payload keys: ${Object.keys(minimal).join(", ")}`);

  if (!DO_PUT) {
    console.log(`   (dry run — no PUT fired; re-run with --put)\n`);
    continue;
  }

  // NO-OP INVARIANT: we write back exactly the state we just read.
  minimal.stateId = currentState;
  let putRes = await office("PUT", `/api/${CLIENT_KEY}/project`, headers, JSON.stringify(minimal));

  // Separate a soft (confirmable) refusal from a genuine block. Mirrors
  // officePromptFrom in lib/bmi-office-actions.ts.
  const asPrompt = (r: { status: number; body: string }) => {
    if (r.status !== 403 || !r.body) return null;
    try {
      const p = JSON.parse(r.body) as { IsQuestion?: boolean; Kind?: number; Message?: string };
      if (!p || typeof p !== "object" || typeof p.Message !== "string") return null;
      return "IsQuestion" in p || "OperationId" in p ? p : null;
    } catch {
      return null;
    }
  };

  const prompt = asPrompt(putRes);
  if (prompt) {
    console.log(
      `   PUT  → 403 ❓ SOFT REFUSAL (kind ${prompt.Kind}, IsQuestion=${prompt.IsQuestion}) — not a block:\n` +
        `        ${(prompt.Message ?? "").replace(/\s+/g, " ").trim()}`,
    );
    if (DO_CONFIRM) {
      putRes = await office(
        "PUT",
        `/api/${CLIENT_KEY}/project`,
        headers,
        JSON.stringify({ ...minimal, confirm: true }),
      );
      const again = asPrompt(putRes);
      console.log(
        `   PUT(confirm:true) → ${putRes.status}  ${
          again
            ? "❌ still refused"
            : putRes.status < 400
              ? "✅ confirmed — Office write path is HEALTHY for this record"
              : "⚠ unexpected"
        }`,
      );
      if (putRes.status >= 400) console.log(`   ${putRes.body.slice(0, 400)}`);
    } else {
      console.log(`   (re-run with --confirm to send confirm:true and complete the write)`);
    }
  } else {
    console.log(
      `   PUT  → ${putRes.status}  ${putRes.status === 403 ? "❌ 403 with no question body — Office writes genuinely blocked for this record" : putRes.status < 400 ? "✅ Office write path is HEALTHY for this record" : "⚠ unexpected"}`,
    );
    if (putRes.status >= 400) console.log(`   ${putRes.body.slice(0, 400)}`);
  }

  // Confirm nothing moved.
  const after = await office("GET", `/api/${CLIENT_KEY}/project/${projectId}`, {
    ...headers,
    "x-session-id": randomUUID(),
  });
  if (after.status < 400) {
    const s = String(JSON.parse(after.body).stateId);
    console.log(`   verify stateId=${s} ${s === currentState ? "(unchanged ✓)" : "⚠ CHANGED"}\n`);
  } else {
    console.log(`   verify GET → ${after.status}\n`);
  }
}

process.exit(0);
