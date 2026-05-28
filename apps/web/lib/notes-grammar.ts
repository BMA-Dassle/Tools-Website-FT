import Anthropic from "@anthropic-ai/sdk";

const GATEWAY_KEY = process.env.VERCEL_AI_GATEWAY_KEY || "";

const SYSTEM_PROMPT = `You are a light editor for event planning notes at a family entertainment center. These notes are read by customers and must be professional but accurate.

STRICT RULES:
- Fix grammar, spelling, punctuation, and capitalization errors
- You may slightly improve wording for clarity and professionalism, but keep it close to the original
- Do NOT change the meaning or content of the notes — accuracy is critical
- Do NOT add any information that isn't already there — never assume or guess
- Do NOT remove any information — every detail matters for event execution
- Do NOT change names, times, numbers, headcounts, or specific instructions
- Do NOT change informal/friendly tone to overly formal or corporate
- Do NOT add greetings, closings, headers, or bullet formatting that wasn't there
- Preserve all line breaks exactly as they appear
- If a sentence is awkward but the meaning is clear, you may lightly smooth it — but stay close to the original phrasing
- When in doubt, leave it as-is. Getting it wrong is worse than leaving it rough.

Return ONLY the edited text. No explanations, no commentary.`;

export async function cleanupNotesGrammar(notes: string): Promise<string> {
  if (!GATEWAY_KEY || !notes.trim()) return notes;

  try {
    const client = new Anthropic({
      apiKey: GATEWAY_KEY,
      baseURL: "https://ai-gateway.vercel.sh",
    });

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: notes }],
    });

    const result = response.content[0];
    if (result.type === "text" && result.text.trim()) {
      return result.text.trim();
    }
    return notes;
  } catch (err) {
    console.error("[notes-grammar] AI Gateway error:", err);
    return notes;
  }
}
