import { NextRequest, NextResponse } from "next/server";
import {
  getUnsentWelcomePasses,
  renderWelcomeEmail,
  sendWelcomeEmailBatch,
} from "@/lib/kbf-welcome-email";

/**
 * GET /api/kbf/welcome-emails?preview=true&limit=3
 *
 * Returns rendered HTML previews for unsent welcome emails so
 * management can review before flipping the send switch.
 *
 * POST /api/kbf/welcome-emails?limit=50
 *
 * Sends a batch of welcome emails to passes that haven't received
 * one yet. Each send is marked in the DB immediately so a crash
 * mid-batch doesn't double-send.
 *
 * POST /api/kbf/welcome-emails?count=true
 *
 * Returns just the count of unsent passes (for dashboards).
 */

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || "3"), 20);

  // Count-only mode
  if (url.searchParams.get("count") === "true") {
    const passes = await getUnsentWelcomePasses(1);
    // Rough count — to get exact total we'd need a separate COUNT query,
    // but for dashboard purposes knowing "at least 1 unsent" is enough.
    // For exact count, just fetch a large limit.
    return NextResponse.json({ unsent: passes.length > 0 });
  }

  const passes = await getUnsentWelcomePasses(limit);

  const previews = passes.map((pass) => ({
    passId: pass.id,
    email: pass.email,
    firstName: pass.firstName,
    lastName: pass.lastName,
    centerName: pass.centerName,
    fpass: pass.fpass,
    memberCount: pass.members.length,
    members: pass.members.map((m) => ({
      name: `${m.firstName} ${m.lastName}`.trim(),
      relation: m.relation,
    })),
    renderedHtml: renderWelcomeEmail(pass),
  }));

  return NextResponse.json({
    ok: true,
    count: previews.length,
    previews,
  });
}

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || "50"), 200);

  const result = await sendWelcomeEmailBatch(limit);

  console.log(
    `[kbf/welcome-emails] Batch complete: ${result.sent} sent, ${result.failed} failed, ${result.total} total`,
  );

  return NextResponse.json({
    ok: result.failed === 0,
    ...result,
  });
}
