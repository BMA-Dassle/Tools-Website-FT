import { notFound } from "next/navigation";
import CameraAssignClient from "./CameraAssignClient";
import { adminPoppins } from "~/components/features/admin-skin/font";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Camera-assignment front-desk tool — pick the Pandora session a racer's video
 * belongs to.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/camera-assign — the ONLY URL. There is no
 * SSO route for this tool.
 *
 * WHY NOT SSO (owner decision, 2026-08-28, revising the one made the same day
 * when the gate shipped). This board briefly had a v2 twin at
 * `/admin/camera-assign` and the page body lived in a shared
 * `_tools/camera-assign` module so the two routes could not drift. One shift of
 * real use retired that: camera-assign is worked TRACKSIDE, on shared kiosks —
 * one per track, standing up, in the ninety seconds between heats. A Microsoft
 * sign-in there is a personal password typed on a shared device in front of
 * guests, every time the session lapses. The tool went back to the token and
 * the `_tools` module was folded back in here rather than left as a two-route
 * abstraction with one caller. `~/lib/constants/admin-tools` carries the
 * decision; `admin-tools.test.ts` pins that no v2 page comes back by accident.
 *
 * The token check below is belt-and-braces with the middleware's unified gate —
 * a routing change must not quietly expose this.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  // The client sends this back as x-admin-token / ?token= for its
  // /api/admin/* calls, exactly where it always sent one — but it is a signed
  // 8-hour credential, not the permanent ADMIN_CAMERA_TOKEN. The static token
  // never reaches a browser as a component prop.
  // (Pinned by scripts/check-admin-token-leak.mjs.)
  const apiToken = await mintAdminApiToken();

  // Build/deploy version. Vercel auto-populates VERCEL_GIT_COMMIT_SHA on every
  // deployment; shortened to the conventional 7-char Git short SHA for a
  // compact display string. Falls back to "dev" when running locally.
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
  const version = sha ? sha.slice(0, 7) : "dev";

  return (
    <div className={adminPoppins.variable}>
      <CameraAssignClient token={apiToken} version={version} />
    </div>
  );
}
