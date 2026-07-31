// READ-ONLY: signer_person_id length distribution — is sigPersonID proven at 17 digits?
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
console.table(await sql`
  SELECT length(signer_person_id) AS signer_len, outcome, count(*) AS n
  FROM waiver_sign_attempts WHERE signer_person_id <> person_id
  GROUP BY 1,2 ORDER BY 1,2`);
