import { destroySession } from "~/features/account/service/session";
import { jsonOk, toErrorResponse } from "~/features/account/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await destroySession();
    return jsonOk({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
