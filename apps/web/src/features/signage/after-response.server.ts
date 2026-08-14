import "server-only";

/**
 * Run work AFTER the response has gone out, never inside it.
 *
 * Two different jobs need this and neither may sit in front of a staff press:
 * writing an Nx bookmark (evidence we generate for ourselves) and warming the
 * pit board's roster cache (a wall repaint). Both were felt by the owner the
 * same evening — "the assignment TVs can update a bit faster, takes a few
 * seconds" — and the answer for both is the same: the press returns, then the
 * work happens.
 *
 * `after()` is the mechanism the kart webhook already uses to keep the bridge's
 * 200 immediate. It requires a request context, so the fallback is a detached
 * promise for any caller outside one — worse, because serverless may kill it,
 * but the alternative is throwing inside a staff action, which is not a trade
 * background work gets to make.
 */
import { after } from "next/server";

export function afterResponse(work: () => Promise<unknown>): void {
  try {
    after(() => {
      void work().catch(() => {});
    });
  } catch {
    void work().catch(() => {});
  }
}
