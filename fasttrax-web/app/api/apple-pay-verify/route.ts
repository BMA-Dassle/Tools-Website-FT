import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";

export async function GET(req: NextRequest) {
  const hostname = req.headers.get("host") || "";
  const isHeadPinz = hostname.includes("headpinz");

  const filename = isHeadPinz
    ? "apple-developer-merchantid-domain-association-headpinz"
    : "apple-developer-merchantid-domain-association-fasttrax";

  try {
    const filePath = join(process.cwd(), "public", ".well-known", filename);
    const content = readFileSync(filePath);
    return new NextResponse(content, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}
