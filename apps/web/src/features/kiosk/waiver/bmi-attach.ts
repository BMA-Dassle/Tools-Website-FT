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
import { getPublicBookingToken } from "@/lib/bmi-office-actions";

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
      body: `{"personId":${personId},"orderId":${projectId},` + namesJson.slice(1),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    console.warn(
      `[kiosk-waiver] registerProjectPerson failed: ${res.status} ${body.slice(0, 300)}`,
    );
  }
  return { ok: res.ok, status: res.status, body: body.slice(0, 1000) };
}
