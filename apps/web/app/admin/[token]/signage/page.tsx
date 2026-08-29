import { notFound } from "next/navigation";
import { adminPoppins } from "~/components/features/admin-skin/font";
import SignageAdminClient from "./SignageAdminClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Admin: lobby-TV screens.
 *
 * Create a TV, say what it is for, tick what it shows, and copy the URL into
 * the player. Adding or re-purposing a screen never needs a deploy.
 *
 * Lives on a staff laptop/phone rather than on the device itself (the way kiosk
 * admin does) for the obvious reason: a wall-mounted TV has no input device.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/signage
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  // The client sends this back as x-admin-token / ?token= for its
  // /api/admin/* calls, exactly where it always sent one — but it is now a
  // signed 8-hour credential, not the permanent ADMIN_CAMERA_TOKEN. The
  // static token never reaches a browser again.
  // (Pinned by scripts/check-admin-token-leak.mjs.)
  const apiToken = await mintAdminApiToken();

  return (
    <div className={adminPoppins.variable}>
      <SignageAdminClient token={apiToken} />
    </div>
  );
}
