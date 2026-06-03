import { NextRequest, NextResponse } from "next/server";

const ADMIN_TOKEN = process.env.ADMIN_CAMERA_TOKEN || "";

export function verifyPortal(req: NextRequest): NextResponse | null {
  const token = req.nextUrl.searchParams.get("token") || req.headers.get("x-admin-token") || "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  }
  return null;
}
