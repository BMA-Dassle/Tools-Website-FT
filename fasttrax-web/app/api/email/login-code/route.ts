import { NextRequest, NextResponse } from "next/server";
import { sendEmail } from "@/lib/sendgrid";

interface AccountInfo {
  personId: string;
  fullName: string;
  loginCode: string;
  lastSeen: string;
  races: number;
  memberships: string[];
}

/**
 * Send a login code email to a returning racer.
 * Supports single account (legacy) and multi-account (new).
 * POST body: { email, accounts: AccountInfo[] }
 *   OR legacy: { email, loginCode, fullName }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email } = body;

    if (!email) {
      return NextResponse.json({ error: "email required" }, { status: 400 });
    }

    let html: string;
    let subject: string;
    let plainText: string;

    if (body.accounts && Array.isArray(body.accounts) && body.accounts.length > 0) {
      // ── Multi-account email ──────────────────────────────────────────
      const accounts: AccountInfo[] = body.accounts;
      subject = "Your FastTrax Account Verification";

      const accountRows = accounts.map((a) => `
        <tr>
          <td style="padding: 12px 16px; border-bottom: 1px solid #ffffff10;">
            <div style="margin-bottom: 6px;">
              <strong style="color: #ffffff; font-size: 15px;">${a.fullName}</strong>
            </div>
            <div style="color: #ffffff80; font-size: 12px; line-height: 1.6;">
              ${a.races > 0 ? `Races: ${a.races}` : "No races yet"}
              ${a.lastSeen ? ` &middot; Last visit: ${a.lastSeen}` : ""}
              ${a.memberships.length > 0 ? `<br/>Memberships: ${a.memberships.join(", ")}` : ""}
            </div>
          </td>
          <td style="padding: 12px 16px; border-bottom: 1px solid #ffffff10; text-align: center; vertical-align: middle;">
            <div style="background: #00E2E5; color: #000418; padding: 8px 16px; border-radius: 6px; font-weight: bold; font-size: 14px; letter-spacing: 2px; white-space: nowrap;">
              ${a.loginCode}
            </div>
          </td>
        </tr>
      `).join("");

      html = `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; background: #0a0e1a; color: #ffffff; padding: 32px; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="color: #00E2E5; font-size: 24px; margin: 0; letter-spacing: 2px;">FASTTRAX</h1>
            <p style="color: #ffffff80; font-size: 12px; margin: 4px 0 0;">Fort Myers</p>
          </div>

          <p style="color: #ffffffcc; font-size: 15px;">We found ${accounts.length} account${accounts.length !== 1 ? "s" : ""} associated with this email.</p>
          <p style="color: #ffffffcc; font-size: 15px;">Find your name below and enter the code next to it on the booking page:</p>

          <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background: #ffffff08; border-radius: 8px; overflow: hidden;">
            <thead>
              <tr style="background: #ffffff10;">
                <th style="padding: 10px 16px; text-align: left; color: #ffffff60; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;">Account</th>
                <th style="padding: 10px 16px; text-align: center; color: #ffffff60; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;">Your Code</th>
              </tr>
            </thead>
            <tbody>
              ${accountRows}
            </tbody>
          </table>

          <p style="color: #ffffff60; font-size: 13px;">Enter the code for your account on the booking page to continue.</p>

          <hr style="border: none; border-top: 1px solid #ffffff15; margin: 24px 0;" />

          <p style="color: #ffffff40; font-size: 11px; text-align: center;">
            FastTrax Entertainment at HeadPinz Fort Myers<br />
            14501 Global Parkway, Fort Myers, FL 33913<br />
            <a href="https://fasttraxent.com" style="color: #00E2E5;">fasttraxent.com</a>
          </p>
        </div>
      `;

      plainText = `FastTrax Account Verification\n\nWe found ${accounts.length} account(s) for this email:\n\n` +
        accounts.map(a => `${a.fullName} — Code: ${a.loginCode} (${a.races} races${a.lastSeen ? `, last visit: ${a.lastSeen}` : ""})`).join("\n") +
        "\n\nEnter your code on the booking page to continue.";

    } else {
      // ── Legacy single-account email ──────────────────────────────────
      const { loginCode, fullName } = body;
      if (!loginCode) {
        return NextResponse.json({ error: "loginCode required" }, { status: 400 });
      }

      const firstName = fullName?.split(" ")[0] || "Racer";
      subject = "Your FastTrax Verification Code";
      plainText = `Your FastTrax verification code is: ${loginCode}`;

      html = `
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

          <p style="color: #ffffff60; font-size: 13px;">Enter this code on the booking page to verify your account.</p>

          <hr style="border: none; border-top: 1px solid #ffffff15; margin: 24px 0;" />

          <p style="color: #ffffff40; font-size: 11px; text-align: center;">
            FastTrax Entertainment at HeadPinz Fort Myers<br />
            14501 Global Parkway, Fort Myers, FL 33913<br />
            <a href="https://fasttraxent.com" style="color: #00E2E5;">fasttraxent.com</a>
          </p>
        </div>
      `;
    }

    const result = await sendEmail({
      to: email,
      subject,
      html,
      text: plainText,
    });

    if (!result.ok) {
      console.error("[SendGrid Error]", result.status, result.error);
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
