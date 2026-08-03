/**
 * Vercel AI Gateway — shared transport config for our Anthropic calls.
 *
 * Three callers used to each hard-code the URL, the key lookup, AND the model
 * id: `lib/event-name-format.ts`, `lib/notes-grammar.ts`, and
 * `~/features/daily-events/ai.ts`. That duplication is why the 2026-02-19
 * retirement of Claude Haiku 3.5 broke three separate surfaces at once and
 * none of them loudly — every caller catches its own error and falls back to
 * the unedited input, so the only symptom was AI features quietly no-ops-ing
 * (day-of food-out extraction, event-name formatting, notes cleanup) while the
 * logs filled with `AI Gateway error 404`. One constant now, so the next model
 * retirement is a one-line change instead of a scavenger hunt.
 *
 * ── The slug trap ──────────────────────────────────────────────────
 * The gateway's ids are NOT the Anthropic API's ids. It uses DOT notation for
 * the version — `anthropic/claude-haiku-4.5`, not `anthropic/claude-haiku-4-5`
 * — and takes no date suffix. `claude-haiku-4-5` (the correct id on Anthropic's
 * own API) 404s here exactly like the retired one did.
 *
 * Verify a slug against the gateway's public catalog before shipping it — no
 * auth required, and it carries live pricing:
 *   curl -s https://ai-gateway.vercel.sh/v1/models | jq '.data[].id'
 * or run `scripts/ai-gateway-model-probe.mts`.
 */

export const AI_GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/messages";

/**
 * Cheapest current model on the gateway that we're willing to run
 * ($1.00/$5.00 per 1M, 200K context, 64K max output).
 *
 * Not `anthropic/claude-3-haiku` even though it's cheaper at $0.25/$1.25 — that
 * is Claude 3 Haiku, already deprecated with a 2026-04-19 retirement date, so
 * picking it would just re-arm the same 404 in a couple of months.
 *
 * These are all short, cheap, structured jobs (name tidying, grammar passes,
 * pulling a time out of a memo) — the Haiku tier is the right fit. If a caller
 * ever needs real reasoning, give that caller its own model constant rather
 * than raising this one for everybody.
 */
export const AI_GATEWAY_MODEL = "anthropic/claude-haiku-4.5";

/** Gateway credential. Vercel-only — deliberately absent from local `.env.local`,
 *  so every caller must degrade gracefully when it's empty. */
export function aiGatewayKey(): string {
  return process.env.ANTHROPIC_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY || "";
}

/** Standard headers for a gateway Messages-API call. */
export function aiGatewayHeaders(key: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    "anthropic-version": "2023-06-01",
  };
}
