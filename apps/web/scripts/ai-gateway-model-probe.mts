/** READ-ONLY: which model slugs does the Vercel AI Gateway actually accept?
 *  The dated Haiku 3.5 slug we ship 404s (model retired 2026-02-19). Probe the
 *  candidates with a 1-token call instead of guessing the replacement slug. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const KEY = process.env.ANTHROPIC_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY || "";
const URL_ = "https://ai-gateway.vercel.sh/v1/messages";
console.log(`key set: ${!!KEY} (${KEY ? KEY.slice(0, 12) + "…" : "none"})\n`);

const CANDIDATES = [
  "anthropic/claude-3-5-haiku-20241022", // what we ship today — expect 404
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-haiku-4-5-20251001",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
];

for (const model of CANDIDATES) {
  const t0 = Date.now();
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 5,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text();
    const ms = Date.now() - t0;
    if (res.ok) {
      let text = "";
      try {
        text = JSON.parse(body).content?.[0]?.text?.trim() ?? "";
      } catch {}
      console.log(`  ✓ ${model.padEnd(38)} ${res.status} (${ms}ms) → "${text}"`);
    } else {
      let msg = body.slice(0, 140);
      try {
        msg = JSON.parse(body).error?.message ?? msg;
      } catch {}
      console.log(`  ✗ ${model.padEnd(38)} ${res.status} (${ms}ms) — ${msg}`);
    }
  } catch (err) {
    console.log(
      `  ✗ ${model.padEnd(38)} threw — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
process.exit(0);
