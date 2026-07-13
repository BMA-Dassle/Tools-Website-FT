/**
 * Food-out time extraction — verbatim port of the employee portal's
 * extractEventMetadata (api/lib/claude.ts): same model, prompt, params and
 * failure semantics. Transport follows this repo's AI Gateway convention
 * (lib/notes-grammar.ts): key from env, never hardcoded.
 */

const GATEWAY_KEY = process.env.ANTHROPIC_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY || "";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/messages";
const MODEL_HAIKU = "anthropic/claude-3-5-haiku-20241022";

export interface EventMetadataExtraction {
  foodOutTime: string | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

const SYSTEM_PROMPT = `You extract structured event data from event notes/memos for a bowling/entertainment center.

Given an event's name, start time, guest count, and notes, extract:
- Food/beverage out time: When food should be served

Rules:
- If notes mention an explicit time for food/buffet (e.g., "food out 4:30pm", "buffet at 5:00"), use that time
- If notes mention a relative time (e.g., "30 minutes into the event", "food served after 1 hour"), calculate from the event start time
- If no food/beverage timing info is mentioned at all, return null for foodOutTime
- Return times in "h:mm AM/PM" format (e.g., "4:30 PM")
- Confidence: "high" if an explicit time is stated, "medium" if calculated from a relative reference, "low" if loosely inferred

Respond with ONLY valid JSON, no markdown formatting or code blocks:
{"foodOutTime": "4:30 PM", "confidence": "high", "reasoning": "brief explanation"}
or
{"foodOutTime": null, "confidence": "high", "reasoning": "No food/beverage timing mentioned in notes"}`;

export async function extractEventMetadata(input: {
  eventName: string;
  startTime: string;
  persons: number;
  notes: string;
}): Promise<EventMetadataExtraction> {
  const { eventName, startTime, persons, notes } = input;

  // If there are no notes, skip AI entirely (portal parity)
  if (!notes || notes.trim().length === 0) {
    return { foodOutTime: null, confidence: "high", reasoning: "No event notes/memos available" };
  }

  const userPrompt = `Event: ${eventName}
Start Time: ${startTime}
Persons: ${persons}

Event Notes:
${notes.substring(0, 2000)}`;

  try {
    if (!GATEWAY_KEY) throw new Error("AI gateway key not configured");

    const res = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL_HAIKU,
        max_tokens: 256,
        temperature: 0.1,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      throw new Error(`AI Gateway error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const data = (await res.json()) as { content?: { text?: string }[] };
    let jsonStr = (data.content?.[0]?.text || "").trim();
    // Remove markdown code blocks if present (portal parity)
    if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
    else if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
    jsonStr = jsonStr.trim();

    const result = JSON.parse(jsonStr) as EventMetadataExtraction;
    return {
      foodOutTime: result.foodOutTime || null,
      confidence: result.confidence || "low",
      reasoning: result.reasoning || "",
    };
  } catch (error) {
    console.error("[daily-events] Failed to extract event metadata:", error);
    return { foodOutTime: null, confidence: "low", reasoning: "AI extraction failed" };
  }
}
