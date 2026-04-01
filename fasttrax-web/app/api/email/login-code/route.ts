import { NextRequest, NextResponse } from "next/server";

const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "noreply@headpinz.com";
const FROM_NAME = process.env.SENDGRID_FROM_NAME || "FastTrax Entertainment";

/**
 * Send a login code email to a returning racer.
 * POST body: { email, loginCode, fullName }
 */
export async function POST(req: NextRequest) {
  try {
    const { email, loginCode, fullName } = await req.json();

    if (!email || !loginCode) {
      return NextResponse.json({ error: "email and loginCode required" }, { status: 400 });
    }

    const firstName = fullName?.split(" ")[0] || "Racer";

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #0a0e1a; color: #ffffff; padding: 32px; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #00E2E5; font-size: 24px; margin: 0; letter-spacing: 2px;">FASTTRAX</h1>
          <p style="color: #ffffff80; font-size: 12px; margin: 4px 0 0;">Fort Myers</p>
        </div>

        <p style="color: #ffffffcc; font-size: 15px;">Hey ${firstName},</p>

        <p style="color: #ffffffcc; font-size: 15px;">Here's your verification code to continue booking:</p>

        <div style="background: #00E2E5; color: #000418; text-align: center; padding: 16px; border-radius: 8px; margin: 24px 0;">
          <p style="font-size: 32px; font-weight: bold; letter-spacing: 4px; margin: 0;">${loginCode}</p>
        </div>

        <p style="color: #ffffff60; font-size: 13px;">Enter this code on the booking page to verify your account. This code is tied to your FastTrax account.</p>

        <hr style="border: none; border-top: 1px solid #ffffff15; margin: 24px 0;" />

        <p style="color: #ffffff40; font-size: 11px; text-align: center;">
          FastTrax Entertainment at HeadPinz Fort Myers<br />
          14501 Global Parkway, Fort Myers, FL 33913<br />
          <a href="https://fasttraxent.com" style="color: #00E2E5;">fasttraxent.com</a>
        </p>
      </div>
    `;

    const res = await fetch(SENDGRID_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email, name: fullName || undefined }],
            subject: "Your FastTrax Verification Code",
          },
        ],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        content: [
          { type: "text/plain", value: `Your FastTrax verification code is: ${loginCode}` },
          { type: "text/html", value: html },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[SendGrid Error]", res.status, err);
      return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
    }

    return NextResponse.json({ sent: true });
  } catch (err) {
    console.error("[login-code email error]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Email error" },
      { status: 500 },
    );
  }
}
