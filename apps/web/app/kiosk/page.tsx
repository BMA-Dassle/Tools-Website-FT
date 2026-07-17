import { parseKioskConfigFromSearchParams } from "~/features/kiosk/config";
import { AttractScreen } from "~/features/kiosk/components/AttractScreen";

/**
 * Kiosk attract/welcome. Server shell: parses one-time provisioning params
 * (?center=fasttrax|headpinz|naples & reader=DEVICE_ID & variant=podium|pitcrew)
 * and hands them to the client, which merges them into the persisted device
 * config. Guests only ever see the attract loop.
 */
export default async function KioskAttractPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const urlConfig = parseKioskConfigFromSearchParams(sp);
  return <AttractScreen urlConfig={urlConfig} />;
}
