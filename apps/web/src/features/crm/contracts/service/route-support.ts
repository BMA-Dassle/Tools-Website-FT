/**
 * The one bridge between the contracts service's own refusals and the HTTP
 * layer, so eight action routes do not each carry the same try/catch — and so
 * a service error can never leak `err.message` to a rep's toast. A
 * `ContractActionError` carries a FIXED code ("no_card_on_file"), which is what
 * the client renders; anything else falls through to `withCrmRoute`'s 500,
 * which logs the detail with `actor_email` and answers "unexpected".
 */

import { CrmHttpError } from "../../core/http";
import { ShortIdSchema } from "../schemas";
import { ContractActionError } from "./actions";

/** The `[shortId]` segment, validated — never trusted straight from the URL. */
export function shortIdFrom(params: Record<string, string | string[]>): string {
  const raw = Array.isArray(params.shortId) ? params.shortId[0] : params.shortId;
  const parsed = ShortIdSchema.safeParse(raw ?? "");
  if (!parsed.success) throw new CrmHttpError(400, "invalid_short_id");
  return parsed.data;
}

export async function withContractAction<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ContractActionError) throw new CrmHttpError(err.status, err.code);
    throw err;
  }
}
