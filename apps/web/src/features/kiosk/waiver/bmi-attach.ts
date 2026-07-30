/**
 * Server-side BMI attach for the kiosk group-waiver flow — registers a signed
 * person onto an existing reservation as a projectPerson so the staff
 * daily-events waiver % and BMI rosters update.
 *
 * Mirrors the proven client idiom (src/features/booking/service/bmi-register.ts
 * registerProjectPersons): personId/orderId are 17-digit ids that exceed
 * Number.MAX_SAFE_INTEGER, so they are raw-injected into the JSON body — never
 * passed through Number() or a parse round-trip.
 *
 * RISK GATE: registerProjectPerson is proven on fresh booking bills; against
 * an existing confirmed project it is verified by
 * scripts/kiosk-waiver-attach-probe.mts before KIOSK_WAIVER_BMI_ATTACH flips
 * on. Until then the join route records status 'skipped' and the Neon roster
 * union keeps the guest experience whole.
 */
import { getPublicBookingToken, billIdFromOfficeProjectId } from "@/lib/bmi-office-actions";

const BMI_PUBLIC_API_URL = process.env.BMI_API_URL || "https://api.bmileisure.com";
const BMI_SUB_KEY = process.env.BMI_SUBSCRIPTION_KEY || "";

const DIGIT_ID = /^\d+$/;

export async function registerProjectPersonServer(args: {
  clientKey: string;
  projectId: string;
  personId: string;
  firstName: string;
  lastName: string;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const { clientKey, projectId, personId, firstName, lastName } = args;
  if (!DIGIT_ID.test(projectId) || !DIGIT_ID.test(personId)) {
    return { ok: false, status: 400, body: "invalid id" };
  }
  /**
   * `orderId` is a BILL id, NOT a projectId — settled by a live probe on
   * 2026-07-30 (see billIdFromOfficeProjectId). Passing the projectId made the
   * endpoint look up `billId + 1`:
   *   http 200 {"success":false,"errorMessage":"Cannot find the reservation for bill …"}
   * which, combined with the HTTP-200 bug fixed below, would have recorded every
   * attach as a success while attaching nobody.
   */
  const billId = billIdFromOfficeProjectId(projectId);
  if (!billId) {
    console.warn(`[kiosk-waiver] cannot derive billId from projectId ${projectId} — refusing`);
    return { ok: false, status: 400, body: "cannot derive billId" };
  }
  const token = await getPublicBookingToken(clientKey);
  const namesJson = JSON.stringify({ firstName, lastName });
  const res = await fetch(
    `${BMI_PUBLIC_API_URL}/public-booking/${clientKey}/person/registerProjectPerson`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "BMI-Subscription-Key": BMI_SUB_KEY,
        "Content-Type": "application/json",
        "Accept-Language": "en",
      },
      // Raw-id injection (bmi-register.ts idiom): ids spliced as raw text.
      body: `{"personId":${personId},"orderId":${billId},` + namesJson.slice(1),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = await res.text().catch(() => "");
  /**
   * HTTP 200 IS NOT SUCCESS on this endpoint. It answers a refusal with
   * `200 {"success":false,"errorMessage":"…"}` — proven live on 2026-07-30. Trusting
   * `res.ok` meant the join route recorded 'attached' for a guest who was never added
   * to the reservation: the staff waiver % stayed wrong and nothing was retried,
   * which is the worst shape of failure — silent and self-congratulating.
   *
   * So success requires BOTH a 2xx and a body that does not say otherwise. An
   * unparseable body is treated as success only when the status is 2xx, matching the
   * repo rule that a 200 with no payload is a pass (`removeItem 200 ≠ success` is the
   * mirror-image lesson).
   */
  let declaredFailure = false;
  let errorMessage = "";
  if (body) {
    try {
      const parsed = JSON.parse(body) as { success?: unknown; errorMessage?: unknown };
      if (parsed.success === false) {
        declaredFailure = true;
        errorMessage = String(parsed.errorMessage ?? "");
      }
    } catch {
      /* not JSON — fall back to the status alone */
    }
  }
  const ok = res.ok && !declaredFailure;
  if (!ok) {
    console.warn(
      `[kiosk-waiver] registerProjectPerson failed: http=${res.status}` +
        `${declaredFailure ? ` success=false (${errorMessage})` : ""} ` +
        `project=${projectId} bill=${billId} ${body.slice(0, 300)}`,
    );
  }
  return { ok, status: res.status, body: body.slice(0, 1000) };
}
