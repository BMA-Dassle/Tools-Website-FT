/** READ-ONLY probe: BMI heat availability for 2026-08-02 via the deployed /api/bmi proxy. */
const HOST = "https://fasttraxent.com";
const DATE = "2026-08-02";

const PRODUCTS = [
  { label: "junior starter Blue (existing pg)", productId: 43733133, pageId: 43734751, qty: 2 },
  { label: "junior intermediate Blue (existing pg)", productId: 43729633, pageId: 43734751, qty: 2 },
  { label: "adult starter Blue (existing pg)", productId: 43734229, pageId: 43734751, qty: 3 },
  { label: "adult starter Red (existing pg)", productId: 43734485, pageId: 43734751, qty: 3 },
  { label: "adult intermediate Blue (existing pg)", productId: 43726940, pageId: 43734751, qty: 3 },
  { label: "adult intermediate Red (existing pg)", productId: 43727216, pageId: 43734751, qty: 3 },
];

for (const p of PRODUCTS) {
  const qs = new URLSearchParams({ endpoint: "availability", date: DATE });
  const res = await fetch(`${HOST}/api/bmi?${qs}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ProductId: p.productId,
      PageId: p.pageId,
      Quantity: p.qty,
      OrderId: null,
      PersonId: null,
      DynamicLines: [],
    }),
  });
  if (!res.ok) {
    console.log(`\n${p.label}: HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
    continue;
  }
  const data = (await res.json()) as {
    proposals: Array<{ blocks: Array<{ block: { name: string; start: string; stop: string; capacity: number; freeSpots: number } }> }>;
  };
  console.log(`\n=== ${p.label} (product ${p.productId}) — ${data.proposals?.length ?? 0} proposals ===`);
  for (const prop of data.proposals ?? []) {
    for (const b of prop.blocks ?? []) {
      const t = b.block.start?.slice(11, 16);
      if (t && t >= "17:00") {
        console.log(`  ${b.block.start} free=${b.block.freeSpots}/${b.block.capacity} ${b.block.name}`);
      }
    }
  }
}
