// Attraction → Pandora session assignment (open item #1, owner 2026-08-04:
// "I have reason to believe we're not assigning them to the session via pandora
// like we do racing … assigning to session is just like racing").
//
// Proven before writing anything:
//   · attraction participants ARE registered as BMI project persons (they show
//     as rows in the Office session grid) but the session COLUMN is unchecked —
//     nobody is linked to the 9:15 PM HP Arena session.
//   · `buildKioskRacers()` only walks race heats, so the post-reserve rail's
//     POST /bmi/schedule never carries an attraction row.
//   · that endpoint is POST-ONLY (GET → "Cannot GET /v2/bmi/schedule/…"), so the
//     shape of an attraction row cannot be learned by reading. Hence this script:
//     it prints the exact body first and only sends with SEND=1.
//
// Racing posts to the FastTrax racing location; attractions live at the HeadPinz
// centers, so the location id differs — a cart with both needs TWO posts.
//
//   npx tsx scripts/attraction-session-assign.mts                 # dry run, prints the body
//   BILL_ID=… SEND=1 npx tsx scripts/attraction-session-assign.mts # actually assigns
//
// Ids: Office person ids are short (8-digit) and safe; the 17-digit precision
// rule applies to the bill/order id, which is only ever handled as a string here.
/* eslint-disable @typescript-eslint/no-explicit-any */
import https from "node:https";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

// W57593 — last night's kiosk laser-tag test booking (FT, 2026-08-03 21:15).
const BILL_ID = (process.env.BILL_ID || "63000000007217973").trim();
const RES_NUMBER = process.env.RES_NUMBER || "W57593";
const CLIENT_KEY = process.env.CLIENT_KEY || "headpinzftmyers";
// Pandora keys locations by the Square location id. Attractions = HeadPinz.
const LOCATION_ID = process.env.LOCATION_ID || "TXBSQN0FEKQ11"; // HP Fort Myers
const PRODUCT_NAME = process.env.PRODUCT_NAME || "Nexus Laser Tag";
const PRODUCT_ID = process.env.PRODUCT_ID || "8976685"; // laser tag, HeadPinz FM
// The one invented field: /bmi/schedule REQUIRES `tier` as a string and an
// attraction has none. "starter" would write false racing data, so send this and
// read the per-row status back — the endpoint skips rows it dislikes.
const TIER = process.env.TIER || "attraction";
const SESSION_MIN = Number(process.env.SESSION_MIN || 15); // attractions-data durationMin
const SEND = process.env.SEND === "1";

const OFFICE_HOST = "office-api22.sms-timing.com";
const OFFICE_USER = process.env.BMI_OFFICE_USERNAME || "";
const OFFICE_PASS = process.env.BMI_OFFICE_PASSWORD_B64
  ? Buffer.from(process.env.BMI_OFFICE_PASSWORD_B64, "base64").toString()
  : process.env.BMI_OFFICE_PASSWORD || "";
const SMS_VERSION = "6251006 202511051229";
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
const PANDORA_KEY = process.env.SWAGGER_ADMIN_KEY || "";

function parseRawIds(text: string): any {
  return JSON.parse(text.replace(/"(\w*[iI]d)"\s*:\s*(\d{15,})/g, '"$1":"$2"'));
}
function field(o: any, name: string): any {
  if (!o || typeof o !== "object") return undefined;
  const k = Object.keys(o).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? o[k] : undefined;
}
/** Add minutes to a NAIVE center-local ISO without a timezone shift. */
function addMinutesNaive(iso: string, min: number): string {
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + min);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function officeReq(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolveP, reject) => {
    const req = https.request(
      {
        hostname: OFFICE_HOST,
        path,
        method,
        headers: { ...headers, "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (c: string) => (data += c));
        res.on("end", () => resolveP({ status: res.statusCode ?? 500, body: data }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy();
      reject(new Error("Office timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function officeToken(): Promise<string> {
  const res = await officeReq(
    "POST",
    "/auth/token",
    {
      "Content-Type": "application/x-www-form-urlencoded",
      clientkey: CLIENT_KEY,
      "x-fast-version": SMS_VERSION,
    },
    `grant_type=password&username=${OFFICE_USER}&password=${encodeURIComponent(OFFICE_PASS)}`,
  );
  if (res.status !== 200) throw new Error(`Office auth ${res.status}`);
  return JSON.parse(res.body).access_token;
}

const projectId = (BigInt(BILL_ID) + BigInt(1)).toString();
console.log(
  `\nAttraction session assignment — ${RES_NUMBER} (bill ${BILL_ID}, project ${projectId})`,
);
console.log("─".repeat(72));

const token = await officeToken();
const proj = await officeReq("GET", `/api/${CLIENT_KEY}/project/${projectId}`, {
  Authorization: `Bearer ${token}`,
  "x-fast-version": SMS_VERSION,
  "x-session-id": `attr-assign-${projectId}`,
  clientkey: CLIENT_KEY,
});
if (proj.status >= 400) {
  console.error(`project read ${proj.status}: ${proj.body.slice(0, 300)}`);
  process.exit(1);
}
const p = parseRawIds(proj.body);
// Which key holds the people? Print whatever the project actually carries.
const personKeys = Object.keys(p).filter((k) => /person/i.test(k));
console.log(`project person-ish keys: ${personKeys.join(", ") || "(none)"}`);
const persons: any[] = personKeys
  .map((k) => field(p, k))
  .filter((v) => Array.isArray(v))
  .flat();
const schedules: any[] = Array.isArray(field(p, "schedules")) ? field(p, "schedules") : [];
console.log(`\npersons on the project: ${persons.length}`);
for (const person of persons) {
  console.log(
    `  · personId=${field(person, "personId") ?? field(person, "id")}` +
      ` ${field(person, "firstName") ?? ""} ${field(person, "lastName") ?? ""}` +
      ` age=${field(person, "age") ?? "-"}`,
  );
}
console.log(`\nschedule rows: ${schedules.length}`);
for (const s of schedules) {
  console.log(
    `  · start=${field(s, "start")} stop=${field(s, "stop") ?? field(s, "end") ?? "-"}` +
      ` resource=${field(s, "resourceId") ?? "-"} state=${field(s, "stateId") ?? "null"}`,
  );
}

const start = field(schedules[0] ?? {}, "start");
if (!start) {
  console.error("\nno schedule row start — nothing to assign to.");
  process.exit(1);
}
const stop =
  field(schedules[0], "stop") ?? field(schedules[0], "end") ?? addMinutesNaive(start, SESSION_MIN);

/** The project stores person IDS only — name and birthdate live on the person
 *  record. Racing gets these from the live session party; a backfill has to read
 *  them. (Office /person/{id} is the endpoint that 500'd for ~6h on 8/3, so a
 *  miss degrades to an id-only row rather than failing the assignment.) */
async function personDetail(id: string): Promise<{ name: string; age: number | null }> {
  try {
    const res = await officeReq("GET", `/api/${CLIENT_KEY}/person/${id}`, {
      Authorization: `Bearer ${token}`,
      "x-fast-version": SMS_VERSION,
      "x-session-id": `attr-assign-person-${id}`,
      clientkey: CLIENT_KEY,
    });
    if (res.status >= 400) return { name: "", age: null };
    const d = parseRawIds(res.body);
    const birth = field(d, "birthdate") ?? field(d, "dateOfBirth");
    const age = birth
      ? Math.floor((Date.parse(start) - Date.parse(String(birth))) / 31_557_600_000)
      : null;
    return {
      name: `${field(d, "firstName") ?? ""} ${field(d, "lastName") ?? ""}`.trim(),
      age,
    };
  } catch {
    return { name: "", age: null };
  }
}

const racers = (
  await Promise.all(
    persons.map(async (person) => {
      const id = field(person, "personId") ?? field(person, "id");
      if (id == null) return null;
      const { name, age } = await personDetail(String(id));
      return {
        racerName: name,
        personId: String(id),
        product: PRODUCT_NAME,
        productId: PRODUCT_ID,
        tier: TIER,
        track: null,
        // Junior vs adult from the real birthdate — the 14-year-old on this
        // booking must not be filed as an adult.
        category: age != null && age < 18 ? "junior" : "adult",
        heatName: PRODUCT_NAME,
        heatStart: start,
        heatStop: stop,
      };
    }),
  )
).filter(Boolean);

console.log(`\nPOST ${PANDORA_BASE}/bmi/schedule/${LOCATION_ID}/${RES_NUMBER}`);
console.log(JSON.stringify({ racers }, null, 2));

if (!SEND) {
  console.log("\nDRY RUN — nothing sent. Re-run with SEND=1 to assign.\n");
  process.exit(0);
}
if (!PANDORA_KEY) {
  console.error("no SWAGGER_ADMIN_KEY — cannot send.");
  process.exit(1);
}

const res = await fetch(`${PANDORA_BASE}/bmi/schedule/${LOCATION_ID}/${RES_NUMBER}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${PANDORA_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ racers }),
  signal: AbortSignal.timeout(20_000),
});
const text = await res.text();
console.log(`\n→ ${res.status}\n${text.slice(0, 1200)}\n`);
