/**
 * Resolve the public-booking `orderId` that `registerProjectPerson` needs, given
 * nothing but an Office projectId.
 *
 * ── The defect this exists to fix (live 2026-08-08/09) ──────────────────────
 *
 * The attach used to derive the order id by arithmetic alone —
 * `billIdFromOfficeProjectId`, i.e. projectId − 1 on the last ten digits. That
 * rule is not a property of BMI; it is a coincidence of OUR OWN booking flow,
 * where the public-booking API mints the bill and the project back to back so
 * they land on consecutive ids. It holds for every reservation we create and for
 * nothing else.
 *
 * A GROUP FUNCTION is created in Office by sales, months earlier, and its bill is
 * minted separately at deposit time in a different id series. projectId − 1 then
 * names nothing at all, and the endpoint answers — with an HTTP 200, because it
 * always does:
 *
 *     200 {"success":false,"errorMessage":"Cannot find the reservation for bill 56000666"}
 *
 * Every guest who signed through a group function's waiver link failed to attach,
 * silently, while the guest was told they were saved to the reservation. Measured
 * over the two days the join table has existed: 177/177 attaches succeeded on
 * 17-digit (online-booking) projects and 0/36 succeeded on short-id
 * (group-function) ones — H3194, H1249, H1231, H1253, H3176.
 *
 * ── Why this asks instead of guessing ───────────────────────────────────────
 *
 * The tempting fix is to branch on the shape of the id: 17 digits → arithmetic,
 * short → look the bill up. That is the same class of mistake as the bug — an
 * incidental property standing in for the real question. The real question is
 * "does this id resolve as a public-booking order?", and there is a cheap
 * read-only way to ASK it: `GET /public-booking/{clientKey}/order/{id}/overview`
 * returns 200 for a real order and 400 for anything else. Verified live on six
 * projects across both client keys (2026-08-09).
 *
 * So: try the proven arithmetic FIRST and verify it. On the 177 reservations
 * that work today this returns the byte-identical id they already use, and the
 * only cost is one GET. If it does not resolve, fall back to the project's own
 * Office `bills[]`, oldest first — the contract bill created with the project,
 * which for a group function is the one bill that exists before the event opens
 * day-of POS bills alongside it.
 *
 * Returns null rather than guessing. A wrong order id here attaches a guest to
 * someone else's reservation, which is worse than not attaching at all.
 *
 * BMI ids are 17-digit strings end to end — the project is read with
 * `fetchProjectRawIds`, never `fetchProject` (JSON.parse rounds `bills[].id`).
 */
import {
  billIdFromOfficeProjectId,
  fetchProjectRawIds,
  getPublicBookingToken,
} from "@/lib/bmi-office-actions";

const BMI_PUBLIC_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";

/**
 * How many of a project's bills we are willing to probe before giving up. A
 * group function accrues a day-of POS bill per transaction once the event opens
 * (H3194 held 16 by the time its racing ran), and the contract bill sorts first,
 * so this is never reached in practice. It is a cost ceiling, not a filter — if
 * it truncates, that is logged, never silent.
 */
const MAX_BILLS_PROBED = 5;

export type OrderIdSource = "arithmetic" | "office-bill";

export interface ResolvedOrderId {
  /** The value to send as `orderId`. Always a digit string, never Number()'d. */
  orderId: string;
  /** Which rail produced it — logged so a regression is visible in one grep. */
  source: OrderIdSource;
}

/** Does this id name a real public-booking order? One read-only GET. */
async function orderResolves(clientKey: string, token: string, orderId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${BMI_PUBLIC_API_URL}/public-booking/${clientKey}/order/${orderId}/overview`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "BMI-Subscription-Key": BMI_SUB_KEY,
          "Accept-Language": "en",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return false;
    // A 2xx is necessary but not sufficient — this API answers refusals with 200
    // elsewhere, so require the payload to actually BE an order. The real
    // overview carries `orderId`; the 400 error body does not.
    const body = await res.text().catch(() => "");
    if (!body) return false;
    try {
      const parsed = JSON.parse(body) as { orderId?: unknown; success?: unknown };
      if (parsed.success === false) return false;
      return parsed.orderId !== undefined && parsed.orderId !== null;
    } catch {
      return false;
    }
  } catch {
    // A network blip is not evidence that the id is wrong — but it is also not
    // evidence that it is right, and this function's contract is "proven to
    // resolve". The caller records a failure and the row stays retryable.
    return false;
  }
}

/** The project's bills, oldest first — the contract bill leads. */
function billIdsOldestFirst(project: Record<string, unknown> | null): string[] {
  const bills = (project?.bills ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(bills)) return [];
  return bills
    .filter((b) => b && b.id !== undefined && b.id !== null)
    .map((b) => ({ id: String(b.id), created: String(b.created ?? "") }))
    .sort((a, b) => a.created.localeCompare(b.created))
    .map((b) => b.id);
}

export async function resolveAttachOrderId(args: {
  clientKey: string;
  projectId: string;
}): Promise<ResolvedOrderId | null> {
  const { clientKey, projectId } = args;
  if (!/^\d+$/.test(projectId)) return null;

  const token = await getPublicBookingToken(clientKey);

  // 1. The proven path — unchanged for every reservation that works today.
  const arithmetic = billIdFromOfficeProjectId(projectId);
  if (arithmetic && (await orderResolves(clientKey, token, arithmetic))) {
    return { orderId: arithmetic, source: "arithmetic" };
  }

  // 2. Ask Office what this project's bills actually are.
  const project = await fetchProjectRawIds(clientKey, projectId);
  if (!project) {
    console.warn(`[waiver-attach] project ${projectId} unreadable at ${clientKey} — no orderId`);
    return null;
  }
  const billIds = billIdsOldestFirst(project).filter((id) => id !== arithmetic);
  const probe = billIds.slice(0, MAX_BILLS_PROBED);
  if (billIds.length > probe.length) {
    console.warn(
      `[waiver-attach] project ${projectId} has ${billIds.length} bills; probing the ` +
        `oldest ${probe.length} only — ${billIds.length - probe.length} not tried`,
    );
  }
  for (const billId of probe) {
    if (await orderResolves(clientKey, token, billId)) {
      return { orderId: billId, source: "office-bill" };
    }
  }

  console.warn(
    `[waiver-attach] no public-booking order resolves for project ${projectId} at ` +
      `${clientKey} (tried arithmetic ${arithmetic ?? "n/a"} + ${probe.length} bill(s))`,
  );
  return null;
}
