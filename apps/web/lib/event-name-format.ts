import Anthropic from "@anthropic-ai/sdk";

const GATEWAY_KEY = process.env.VERCEL_AI_GATEWAY_KEY || "";

const SYSTEM_PROMPT = `You format event names for a family entertainment center's contract system.

STRICT RULES:
- Client or group name comes first, exactly as provided
- Followed immediately by the event type — no punctuation between them
- Title case only
- No venue prefixes (never "HeadPinz Welcomes" or "FastTrax Presents" or similar)
- Keep it concise — no extra descriptors unless the original specifically has them
- Remove articles like "The" at the start
- No possessives unless it's part of the actual client name
- If you cannot determine the client name and event type, return the original name in title case with any venue prefix removed

APPROVED EVENT TYPES:
Birthday Party, Team Building, Holiday Party, Reunion, Fundraiser, Field Trip, End of Year Party, Graduation Party, Celebration, Awards Banquet, Corporate Event, Private Event, Group Event

EXAMPLES OF CORRECT OUTPUT:
Acme Corp Team Building
Johnson Birthday Party
Lee Health Holiday Party
First Baptist Church Reunion
Spring Creek Elementary Field Trip
Water Medic Team Building

Return ONLY the formatted name. No explanations.`;

export async function formatEventName(rawName: string): Promise<string> {
  if (!GATEWAY_KEY || !rawName.trim()) return rawName;

  try {
    const client = new Anthropic({
      apiKey: GATEWAY_KEY,
      baseURL: "https://ai-gateway.vercel.sh",
    });

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: rawName }],
    });

    const result = response.content[0];
    if (result.type === "text" && result.text.trim()) {
      return result.text.trim();
    }
    return rawName;
  } catch (err) {
    console.error("[event-name-format] AI Gateway error:", err);
    return rawName;
  }
}
