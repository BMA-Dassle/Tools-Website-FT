import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const headers = {
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  "Square-Version": "2024-08-21",
};
const res = await fetch("https://connect.squareup.com/v2/orders/9C4OB14JmXvxZ6mE463lfA3HWx8YY", {
  headers,
});
const j = (await res.json()) as { order: Record<string, never> };
const o = j.order;
console.log(
  JSON.stringify(
    {
      state: o["state"],
      total: o["total_money"],
      netDue: o["net_amount_due_money"],
      tenders: ((o["tenders"] as Array<Record<string, unknown>>) || []).map((t) => ({
        type: t.type,
        amount: t.amount_money,
      })),
    },
    null,
    2,
  ),
);
process.exit(0);
