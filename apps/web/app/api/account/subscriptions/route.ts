import { requireSession } from "~/features/account/service/session";
import { listSubscriptions } from "~/features/account/service/account";
import { jsonOk, toErrorResponse } from "~/features/account/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireSession();
    const { subscriptions, cards } = await listSubscriptions(session);
    return jsonOk({ subscriptions, cards });
  } catch (err) {
    return toErrorResponse(err);
  }
}
