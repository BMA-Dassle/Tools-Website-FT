import { sendEmail } from "@/lib/sendgrid";
import { voxSend } from "@/lib/sms-retry";
import { AccountHttpError } from "../errors";
import { maskDestination, normalizeContact, type NormalizedContact } from "../contact";
import { consumeOtp, generateCode, reserveSend, storeOtp } from "../data/otp-store";
import { searchCustomersByContact } from "../data/customers";
import { mintSession } from "./session";

export interface RequestOtpResult {
  channel: "email" | "phone";
  maskedDestination: string;
}

/**
 * Send a verification code. Deliberately reveals NOTHING about whether the
 * contact matches a Square customer (no Square lookup happens here) — that
 * would be an enumeration oracle. Only contact-format and rate-limit errors
 * surface.
 */
export async function requestOtp(rawContact: string, ip: string): Promise<RequestOtpResult> {
  const c = normalizeContact(rawContact);
  if (!c) {
    throw new AccountHttpError(400, "INVALID_CONTACT", "Enter a valid email or mobile number");
  }

  const reserve = await reserveSend(c.key, ip);
  if (reserve.blocked) {
    throw new AccountHttpError(429, "RATE_LIMITED", "Too many requests — please wait a moment.", {
      retryAfterSec: reserve.retryAfterSec,
    });
  }

  const code = generateCode();
  await storeOtp(c.key, code);

  const sent = await deliverCode(c, code);
  if (!sent) {
    throw new AccountHttpError(502, "SEND_FAILED", "Couldn't send your code. Please try again.");
  }
  return { channel: c.type, maskedDestination: maskDestination(c) };
}

async function deliverCode(c: NormalizedContact, code: string): Promise<boolean> {
  if (c.type === "email") {
    const res = await sendEmail({
      to: c.value,
      subject: "Your verification code",
      text: `Your verification code is: ${code}\n\nThis code expires in 5 minutes. If you didn't request it, you can ignore this email.`,
      html: emailHtml(code),
    });
    return res.ok;
  }
  const res = await voxSend(c.value, `Your verification code is: ${code}`);
  return res.ok;
}

function emailHtml(code: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto;padding:24px">
  <h2 style="color:#000418;margin:0 0 12px">Verify it's you</h2>
  <p style="color:#333;margin:0 0 16px">Enter this code to sign in to your account:</p>
  <div style="background:#f1f3f7;border-radius:10px;padding:20px;text-align:center;font-size:32px;letter-spacing:8px;font-weight:700;color:#000418">${code}</div>
  <p style="color:#777;font-size:12px;margin-top:16px">This code expires in 5 minutes. If you didn't request it, you can ignore this email.</p>
</div>`;
}

export interface VerifyOtpResult {
  ok: boolean;
  hasCustomers?: boolean;
  error?: string;
  attemptsLeft?: number;
}

/**
 * Verify a code. On success: derive the bound Square customer ids SERVER-SIDE
 * from the verified contact and mint a fresh session (sets the cookie). 0
 * matches is valid — the session is still minted (the contact IS verified).
 */
export async function verifyOtp(rawContact: string, code: string): Promise<VerifyOtpResult> {
  const c = normalizeContact(rawContact);
  if (!c) {
    throw new AccountHttpError(400, "INVALID_CONTACT", "Enter a valid email or mobile number");
  }

  const result = await consumeOtp(c.key, code);
  if (!result.ok) {
    const error =
      result.reason === "locked"
        ? "Too many attempts. Request a new code."
        : result.reason === "expired"
          ? "That code expired. Request a new one."
          : "Incorrect code.";
    return { ok: false, error, attemptsLeft: result.attemptsLeft };
  }

  const ids = await searchCustomersByContact(c.value, c.type);
  await mintSession({ contact: c.value, contactType: c.type, squareCustomerIds: ids });
  return { ok: true, hasCustomers: ids.length > 0 };
}
