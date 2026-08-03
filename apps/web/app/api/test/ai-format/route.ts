import { NextRequest, NextResponse } from "next/server";
import { formatEventName } from "@/lib/event-name-format";
import { AI_GATEWAY_MODEL, aiGatewayKey } from "~/lib/api/ai-gateway";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name") || "HeadPinz Welcomes Test Corp!";
  const key = aiGatewayKey();

  try {
    const result = await formatEventName(name);
    return NextResponse.json({
      input: name,
      output: result,
      // `changed: false` with a key set is the tell that the gateway call failed
      // and we fell back to the raw name — the model slug is reported so a bad
      // one is obvious from the smoke test rather than only in the logs.
      changed: result !== name,
      model: AI_GATEWAY_MODEL,
      keySet: !!key,
      keyPrefix: key ? key.slice(0, 8) + "..." : "MISSING",
    });
  } catch (err) {
    return NextResponse.json(
      {
        input: name,
        error: err instanceof Error ? err.message : String(err),
        model: AI_GATEWAY_MODEL,
        keySet: !!key,
        keyPrefix: key ? key.slice(0, 8) + "..." : "MISSING",
      },
      { status: 500 },
    );
  }
}
