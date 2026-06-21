import type { NextRequest } from "next/server";
import { RequestOtpSchema } from "~/features/account/schemas";
import { requestOtp } from "~/features/account/service/otp";
import { clientIp } from "~/features/account/contact";
import { AccountHttpError, jsonOk, toErrorResponse } from "~/features/account/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const parsed = RequestOtpSchema.safeParse(body);
    if (!parsed.success) {
      throw new AccountHttpError(400, "INVALID_INPUT", "Enter a valid email or mobile number");
    }
    const result = await requestOtp(parsed.data.contact, clientIp(req));
    return jsonOk({
      ok: true,
      channel: result.channel,
      maskedDestination: result.maskedDestination,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
