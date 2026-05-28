import Anthropic from "@anthropic-ai/sdk";

const GATEWAY_KEY = process.env.VERCEL_AI_GATEWAY_KEY || "";

const SYSTEM_PROMPT = `You are a grammar and spelling editor for event planning notes at a family entertainment center.

STRICT RULES:
- Fix ONLY grammar, spelling, punctuation, and capitalization errors
- Do NOT change the meaning, tone, or content of the notes
- Do NOT add new information or remove existing information
- Do NOT rephrase or rewrite sentences — only correct errors
- Do NOT change names, times, numbers, or specific instructions
- Do NOT add greetings, closings, or formatting that wasn't there
- Do NOT change informal/friendly tone to formal
- If the notes are already grammatically correct, return them unchanged
- Preserve all line breaks exactly as they appear

Return ONLY the corrected text. No explanations, no commentary.`;

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
