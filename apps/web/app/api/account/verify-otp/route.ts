import type { NextRequest } from "next/server";
import { VerifyOtpSchema } from "~/features/account/schemas";
import { verifyOtp } from "~/features/account/service/otp";
import { AccountHttpError, jsonOk, toErrorResponse } from "~/features/account/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = VerifyOtpSchema.safeParse(body);
    if (!parsed.success) {
      throw new AccountHttpError(400, "INVALID_INPUT", "Enter the 6-digit code");
    }
    const result = await verifyOtp(parsed.data.contact, parsed.data.code);
    if (!result.ok) {
      // 200 with ok:false so the UI can show remaining attempts (not a 4xx).
      return jsonOk({ ok: false, error: result.error, attemptsLeft: result.attemptsLeft });
    }
    return jsonOk({ ok: true, hasCustomers: result.hasCustomers });
  } catch (err) {
    return toErrorResponse(err);
  }
}
