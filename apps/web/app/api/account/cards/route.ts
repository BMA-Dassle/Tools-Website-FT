import type { NextRequest } from "next/server";
import { AddCardSchema } from "~/features/account/schemas";
import { requireCsrf, requireSession } from "~/features/account/service/session";
import { addCard } from "~/features/account/service/account";
import { AccountHttpError, jsonOk, toErrorResponse } from "~/features/account/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    requireCsrf(session, req);
    const body = await req.json().catch(() => null);
    const parsed = AddCardSchema.safeParse(body);
    if (!parsed.success) {
      throw new AccountHttpError(400, "INVALID_INPUT", "Card details are missing");
    }
    const card = await addCard(session, parsed.data);
    return jsonOk({ ok: true, card });
  } catch (err) {
    return toErrorResponse(err);
  }
}
