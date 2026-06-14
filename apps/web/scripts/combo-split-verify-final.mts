/** Post-remediation verification: new orders at right locations, rows repointed, old orders CANCELED. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const TOKEN = process.env.SQUARE_ACCESS_TOKEN!;
const H = { Authorization: `Bearer ${TOKEN}`, "Square-Version": "2024-12-18" };
const { sql } = await import("@/lib/db");
const q = sql();
const LOC: Record<string, string> = { LAB52GY480CJF: "FastTrax-FM", TXBSQN0FEKQ11: "HeadPinz-FM" };

const PAIRS = [
  { old: "ta8ExW2mU4spvqKtBcdDlkkAiQ6YY", ft: "7bnj7hPfqEnnhvFPNbN1liGbG78YY", hp: "9Wmov8RjTxUgYM9qkdg9IYwgrweZY" },
  { old: "t4TWwoDi4eGylTMu9E44he4XNAbZY", ft: "zvRUKoNaYVMFzzSoGagEweQdgRBZY", hp: "BgUtvg8f4ZSYqNEPIW5ZKzZJR57YY" },
  { old: "bhooMRGfEhqtJi9oPZsrb4sQVbGZY", ft: "tIR9aefirCFkeFZ1xeqaJ16wk8aZY", hp: "VETCTp7ygQ1HAbSe4CuVnmCVWbEZY" },
  { old: "vRrKnIKBrUamE1dvZTPWib954SIZY", ft: "VKyyU1Vdrcqz00FynizRsJJmliUZY", hp: "XPK981kkH4WvATffE2FBeujyvsBZY" },
];

async function ord(id: string) {
  const o = (await (await fetch(`https://connect.squareup.com/v2/orders/${id}`, { headers: H })).json()).order;
  return { state: o?.state, loc: LOC[o?.location_id] ?? o?.location_id, total: (o?.total_money?.amount ?? 0) / 100 };
}

let ok = true;
for (const p of PAIRS) {
  const [oldO, ftO, hpO] = await Promise.all([ord(p.old), ord(p.ft), ord(p.hp)]);
  const rows = (await q`
    SELECT product_kind, square_dayof_order_id FROM bowling_reservations
    WHERE square_dayof_order_id IN (${p.ft}, ${p.hp})
  `) as Array<{ product_kind: string; square_dayof_order_id: string }>;
  const raceRow = rows.find((r) => r.product_kind === "race");
  const bowlRow = rows.find((r) => r.product_kind === "open" || r.product_kind === "kbf");
  const racePtsFt = raceRow?.square_dayof_order_id === p.ft;
  const bowlPtsHp = bowlRow?.square_dayof_order_id === p.hp;
  const good = oldO.state === "CANCELED" && ftO.loc === "FastTrax-FM" && hpO.loc === "HeadPinz-FM" && racePtsFt && bowlPtsHp;
  if (!good) ok = false;
  console.log(
    `${p.old.slice(0, 6)}  old=${oldO.state}  FT=${ftO.loc} $${ftO.total.toFixed(2)} ${racePtsFt ? "(race row✓)" : "(race row✗)"}  HP=${hpO.loc} $${hpO.total.toFixed(2)} ${bowlPtsHp ? "(bowl row✓)" : "(bowl row✗)"}  ${good ? "✓ OK" : "‼ CHECK"}`,
  );
}
console.log(ok ? "\nAll 4 verified ✓" : "\n‼ Issues found — review above");
