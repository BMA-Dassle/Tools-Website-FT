import { NextRequest, NextResponse } from "next/server";
import { formatEventName } from "@/lib/event-name-format";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name") || "HeadPinz Welcomes Test Corp!";
  const key = process.env.ANTHROPIC_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY;

  try {
    const result = await formatEventName(name);
    return NextResponse.json({
      input: name,
      output: result,
      changed: result !== name,
      keySet: !!key,
      keyPrefix: key ? key.slice(0, 8) + "..." : "MISSING",
    });
  } catch (err) {
    return NextResponse.json(
      {
        input: name,
        error: err instanceof Error ? err.message : String(err),
        keySet: !!key,
        keyPrefix: key ? key.slice(0, 8) + "..." : "MISSING",
      },
      { status: 500 },
    );
  }
}
