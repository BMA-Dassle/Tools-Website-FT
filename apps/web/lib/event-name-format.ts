const GATEWAY_KEY = process.env.ANTHROPIC_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY || "";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/messages";

const SYSTEM_PROMPT = `You format event names for a family entertainment center's contract system.

STRICT RULES:
- Client or group name comes first, exactly as provided
- If an event type is already in the name, keep it — but do NOT add or guess an event type that isn't there
- Title case only
- No venue prefixes (remove "HeadPinz Welcomes", "FastTrax Presents", "HeadPinz 5/28", etc.)
- Remove dates from the name (e.g. "5/28" or "May 28th")
- Keep it concise — no extra descriptors unless the original specifically has them
- Remove articles like "The" at the start
- No possessives unless it's part of the actual client name
- Do NOT invent or assume an event type — if the original only has a client name, return just the client name

EXAMPLES:
"HeadPinz Welcomes Water Medic!" → "Water Medic"
"HeadPinz 5/28 Welcome Spring Creek Elementary 4th Graders!" → "Spring Creek Elementary 4th Graders"
"Johnson Birthday Party" → "Johnson Birthday Party"
"ACME CORP HOLIDAY PARTY" → "Acme Corp Holiday Party"
"Lee Health Holiday Party" → "Lee Health Holiday Party"
"HeadPinz Presents Acme Corp Team Building" → "Acme Corp Team Building"
"Eric's Very Expensive Party" → "Eric's Very Expensive Party"

Return ONLY the formatted name. No explanations.`;

export async function formatEventName(rawName: string): Promise<string> {
  if (!GATEWAY_KEY || !rawName.trim()) {
    console.log(`[event-name-format] skipping: keySet=${!!GATEWAY_KEY} rawName="${rawName}"`);
    return rawName;
  }
  console.log(`[event-name-format] calling AI Gateway for: "${rawName}"`);

  try {
    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "anthropic/claude-3-5-haiku-20241022",
        max_tokens: 100,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: rawName }],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.error("[event-name-format] AI Gateway error:", res.status, await res.text());
      return rawName;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    return text || rawName;
  } catch (err) {
    console.error("[event-name-format] AI Gateway error:", err);
    return rawName;
  }
}
