import { NextRequest, NextResponse } from "next/server";

/** Temporary debug endpoint — logs client messages to Vercel runtime logs */
export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        console.log("[CLIENT]", msg);
      }
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
}
