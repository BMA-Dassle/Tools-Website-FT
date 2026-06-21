import type { NextRequest } from "next/server";
import { SetCardSchema } from "~/features/account/schemas";
import { requireCsrf, requireSession } from "~/features/account/service/session";
import { setSubscriptionCard } from "~/features/account/service/account";
import { AccountHttpError, jsonOk, toErrorResponse } from "~/features/account/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession();
    requireCsrf(session, req);
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const parsed = SetCardSchema.safeParse(body);
    if (!parsed.success) {
      throw new AccountHttpError(400, "INVALID_INPUT", "cardId is required");
    }
    const subscription = await setSubscriptionCard(session, id, parsed.data);
    return jsonOk({ ok: true, subscription });
  } catch (err) {
    return toErrorResponse(err);
  }
}
