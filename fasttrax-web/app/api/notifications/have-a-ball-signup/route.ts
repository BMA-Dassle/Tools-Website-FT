import { NextRequest, NextResponse } from "next/server";

/**
 * Send Have-A-Ball league signup confirmation email.
 * - Sends to the bowler
 * - BCCs the HeadPinz team so they see every signup in real time
 */

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
const FROM_NAME = "HeadPinz Fort Myers";

const TEAM_BCC = [
  "barb@headpinz.com",
  "paula@headpinz.com",
  "jacob@headpinz.com",
  "eric@headpinz.com",
];

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c
  ));
}

function renderEmail(p: {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  teamName?: string;
  subscriptionId: string;
  startDate: string;
}): string {
  const teamLine = p.teamName
    ? `<p style="margin:0 0 8px 0"><strong>Team / Bowling with:</strong> ${escape(p.teamName)}</p>`
    : "";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.08)">
        <tr><td style="background:#fd5b56;padding:28px 32px;color:#fff">
          <p style="margin:0 0 4px 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;opacity:0.85">HeadPinz Fort Myers</p>
          <h1 style="margin:0;font-size:28px;letter-spacing:-0.5px">You're in the Have-A-Ball League!</h1>
        </td></tr>

        <tr><td style="padding:28px 32px">
          <p style="margin:0 0 16px 0;font-size:16px;line-height:1.5">Hey ${escape(p.firstName)} — you're officially signed up for the Have-A-Ball League. See you on the lanes!</p>

          <div style="background:#fff7f7;border-left:4px solid #fd5b56;padding:16px 20px;margin:20px 0;border-radius:4px">
            <p style="margin:0 0 6px 0;font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1px">League Starts</p>
            <p style="margin:0;font-size:22px;font-weight:bold;color:#1a1a1a">Tuesday, May 26, 2026 · 6:30 PM</p>
            <p style="margin:8px 0 0 0;font-size:13px;color:#555">12-week season · HeadPinz Fort Myers, 14513 Global Parkway</p>
          </div>

          <h3 style="margin:24px 0 12px 0;font-size:16px;color:#1a1a1a;border-bottom:1px solid #eee;padding-bottom:8px">Your Signup</h3>
          <p style="margin:0 0 8px 0"><strong>Name:</strong> ${escape(p.firstName)} ${escape(p.lastName)}</p>
          <p style="margin:0 0 8px 0"><strong>Phone:</strong> ${escape(p.phone)}</p>
          <p style="margin:0 0 8px 0"><strong>Email:</strong> ${escape(p.email)}</p>
          ${teamLine}

          <h3 style="margin:24px 0 12px 0;font-size:16px;color:#1a1a1a;border-bottom:1px solid #eee;padding-bottom:8px">Billing</h3>
          <p style="margin:0 0 8px 0;line-height:1.5">Your card will be charged <strong>$20 every week for 12 weeks</strong>, starting <strong>May 26, 2026</strong>.</p>
          <p style="margin:0 0 4px 0;font-size:14px;color:#555">· $14.50 lineage (lanes + shoes)</p>
          <p style="margin:0 0 4px 0;font-size:14px;color:#555">· $5.50 toward your end-of-season bowling ball</p>
          <p style="margin:12px 0 0 0;font-size:14px;color:#555">Season total: $240. No charge today.</p>

          <h3 style="margin:24px 0 12px 0;font-size:16px;color:#1a1a1a;border-bottom:1px solid #eee;padding-bottom:8px">What's Next</h3>
          <p style="margin:0 0 8px 0;line-height:1.5">Closer to the start date we'll send a ball-selection email — pick between the Brunswick T-Zone or Columbia White Dot, four colors each.</p>
          <p style="margin:0 0 8px 0;line-height:1.5">Questions? Reply to this email or call <a href="tel:+12392888385" style="color:#fd5b56">(239) 288-8385</a>.</p>

          <p style="margin:32px 0 0 0;font-size:12px;color:#aaa;border-top:1px solid #eee;padding-top:16px">
            Subscription ID: ${escape(p.subscriptionId)}<br>
            HeadPinz Fort Myers · 14513 Global Parkway, Fort Myers FL 33913
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { firstName, lastName, email, phone, teamName, subscriptionId, startDate } = body as {
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      teamName?: string;
      subscriptionId?: string;
      startDate?: string;
    };

    if (!email || !firstName || !subscriptionId) {
      return NextResponse.json({ error: "email, firstName, subscriptionId required" }, { status: 400 });
    }
    if (!SENDGRID_API_KEY) {
      console.error("[have-a-ball-signup] Missing SENDGRID_API_KEY");
      return NextResponse.json({ error: "Email service not configured" }, { status: 500 });
    }

    const html = renderEmail({
      firstName,
      lastName: lastName || "",
      phone: phone || "",
      email,
      teamName,
      subscriptionId,
      startDate: startDate || "2026-05-26",
    });

    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email }],
            bcc: TEAM_BCC.map((e) => ({ email: e })),
          },
        ],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject: `You're in the Have-A-Ball League, ${firstName}!`,
        content: [{ type: "text/html", value: html }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[have-a-ball-signup] SendGrid error:", res.status, errText);
      return NextResponse.json({ error: "Send failed", detail: errText.slice(0, 300) }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[have-a-ball-signup] error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Error" }, { status: 500 });
  }
}
