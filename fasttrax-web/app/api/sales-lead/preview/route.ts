import { NextRequest, NextResponse } from "next/server";
import {
  buildSalesLeadSms,
  buildSalesLeadEmailSubject,
  buildSalesLeadEmailText,
  buildSalesLeadEmailHtml,
  type SalesLeadCopyContext,
} from "@/lib/sales-lead-copy";

/**
 * GET /api/sales-lead/preview
 *
 * Dev-time preview of the SMS + email copy. Renders the exact strings that
 * would be sent for a mock lead, so copy can be reviewed before enabling the
 * live flow. Supports three display modes via `?format=`:
 *
 *   ?format=html   (default)  → email HTML, rendered directly in browser
 *   ?format=json              → all three (SMS + text + HTML + subject) as JSON
 *   ?format=text              → SMS + plain-text email, both as a text/plain blob
 *
 * Override mock fields via query string — e.g.:
 *   ?planner=stephanie&firstName=Alex&preferredDate=2026-06-14
 *   ?planner=guestservices&firstName=Jamie
 *
 * Planners: stephanie | lori | kelsea | guestservices
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Planner pick — keep in sync with PLANNER_REGISTRY in lib/sales-lead-config.ts (once that lands).
  const plannerKey = (searchParams.get("planner") || "stephanie").toLowerCase();
  const plannerMock: Record<string, Pick<SalesLeadCopyContext, "plannerName" | "plannerPhone" | "plannerEmail" | "isIndividualPlanner">> = {
    stephanie:     { plannerName: "Stephanie",      plannerPhone: "+12392148353", plannerEmail: "stephanie@headpinz.com",   isIndividualPlanner: true },
    lori:          { plannerName: "Lori",           plannerPhone: "+12392042328", plannerEmail: "lori@headpinz.com",        isIndividualPlanner: true },
    kelsea:        { plannerName: "Kelsea",         plannerPhone: "+12392058142", plannerEmail: "kelsea@headpinz.com",      isIndividualPlanner: true },
    guestservices: { plannerName: "Guest Services", plannerPhone: "+12394553755", plannerEmail: "guestservices@headpinz.com", isIndividualPlanner: false },
  };
  const planner = plannerMock[plannerKey] || plannerMock.stephanie;

  const ctx: SalesLeadCopyContext = {
    firstName:       searchParams.get("firstName")       || "Alex",
    projectNumber:   searchParams.get("projectNumber")   || "H0421",
    plannerName:     planner.plannerName,
    plannerPhone:    planner.plannerPhone,
    plannerEmail:    planner.plannerEmail,
    preferredDate:   searchParams.get("preferredDate")   || "2026-06-14",
    centerName:      searchParams.get("centerName")      || "HeadPinz Naples",
    isIndividualPlanner: planner.isIndividualPlanner,
  };

  const sms = buildSalesLeadSms(ctx);
  const subject = buildSalesLeadEmailSubject(ctx);
  const text = buildSalesLeadEmailText(ctx);
  const html = buildSalesLeadEmailHtml(ctx);

  const format = (searchParams.get("format") || "html").toLowerCase();

  if (format === "json") {
    return NextResponse.json({ ctx, sms, subject, text, html });
  }
  if (format === "text") {
    return new NextResponse(
      `=== SMS ===\n${sms}\n\n=== Email Subject ===\n${subject}\n\n=== Email Text ===\n${text}\n`,
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  if (format === "sms") {
    return new NextResponse(sms, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  // Default: render email HTML with a banner showing the SMS that would send alongside it.
  const banner = `
    <div style="position: fixed; top: 0; left: 0; right: 0; background: #010A20; color: #00E2E5; padding: 12px 20px; font-family: monospace; font-size: 13px; border-bottom: 1px solid #00E2E580; z-index: 9999;">
      <strong>SMS preview</strong> (${sms.length} chars): ${sms.replace(/</g, "&lt;")}
      <br /><span style="color:#ffffff70;">
        Planner: ${ctx.plannerName} &middot; Center: ${ctx.centerName} &middot; Project: #${ctx.projectNumber}
        &middot; <a href="?${searchParams.toString()}&format=json" style="color:#00E2E5;">JSON</a>
        &middot; <a href="?${searchParams.toString()}&format=text" style="color:#00E2E5;">Text</a>
      </span>
    </div>
    <div style="height: 80px;"></div>
  `;
  return new NextResponse(banner + html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
