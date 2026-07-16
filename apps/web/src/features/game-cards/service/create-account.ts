/**
 * Create a HeadPinz Rewards account for a signed-in guest who has none.
 *
 * "Rewards account" = a Square customer (the account cards/game-cards attach to)
 * + best-effort enrollment in the Square Loyalty program. Keyed to the
 * OTP-verified session contact only — never client input. After creating, the
 * session is re-minted so the new customer id is bound (subsequent card/link
 * ops pass the ownership check). Idempotent-ish: if the phone already resolves
 * to Square customers we return those instead of creating a duplicate.
 */
import { squareFetch, squareErrorDetail } from "~/features/account/data/square-client";
import { searchCustomersByContact } from "~/features/account/data/customers";
import { mintSession } from "~/features/account/service/session";
import type { AccountSession } from "~/features/account";
import { GameCardHttpError } from "../errors";

export async function createRewardsAccount(
  session: AccountSession,
): Promise<{ customerId: string }> {
  // Already has account(s) — nothing to create; return the first.
  if (session.squareCustomerIds.length > 0) {
    return { customerId: session.squareCustomerIds[0] };
  }

  const isPhone = session.contactType === "phone";
  const body: Record<string, unknown> = {
    idempotency_key: `gc-cust-${session.contact}`.slice(0, 45),
    ...(isPhone ? { phone_number: session.contact } : { email_address: session.contact }),
  };
  const { ok, data } = await squareFetch<{ customer?: { id?: string } }>("/customers", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const customerId = data?.customer?.id;
  if (!ok || !customerId) {
    // Lost race? Re-search before failing.
    const existing = await searchCustomersByContact(session.contact, session.contactType);
    if (existing.length > 0) {
      await mintSession({
        contact: session.contact,
        contactType: session.contactType,
        squareCustomerIds: existing,
      });
      return { customerId: existing[0] };
    }
    throw new GameCardHttpError(
      502,
      "CREATE_FAILED",
      `Couldn't create account: ${squareErrorDetail(data)}`,
    );
  }

  // Best-effort Square Loyalty enrollment (phone-mapped). Non-fatal.
  if (isPhone) {
    try {
      const prog = await squareFetch<{ program?: { id?: string } }>("/loyalty/programs/main", {
        method: "GET",
      });
      const programId = prog.data?.program?.id;
      if (prog.ok && programId) {
        await squareFetch("/loyalty/accounts", {
          method: "POST",
          body: JSON.stringify({
            idempotency_key: `gc-loyal-${customerId}`.slice(0, 45),
            loyalty_account: {
              program_id: programId,
              mapping: { phone_number: session.contact },
            },
          }),
        });
      }
    } catch (err) {
      console.error(
        "[game-cards] loyalty enroll failed (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Bind the new customer to the session.
  await mintSession({
    contact: session.contact,
    contactType: session.contactType,
    squareCustomerIds: [customerId],
  });
  return { customerId };
}
