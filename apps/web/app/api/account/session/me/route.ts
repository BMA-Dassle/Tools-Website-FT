import { getSession } from "~/features/account/service/session";
import { maskValue } from "~/features/account/contact";
import { jsonOk, toErrorResponse } from "~/features/account/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return jsonOk({ authenticated: false });
    return jsonOk({
      authenticated: true,
      contactMasked: maskValue(session.contact, session.contactType),
      contactType: session.contactType,
      customerCount: session.squareCustomerIds.length,
      csrf: session.csrf,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
