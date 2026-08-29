import { notFound } from "next/navigation";
import { adminPoppins } from "~/components/features/admin-skin/font";
import KbfAdminClient from "./KbfAdminClient";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * Admin: Kids Bowl Free — account lookup, bowler selection, Bowl Now / Book Lane.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/kbf
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Page({ params, searchParams }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  // The client sends this back as x-admin-token / ?token= for its
  // /api/admin/* calls, exactly where it always sent one — but it is now a
  // signed 8-hour credential, not the permanent ADMIN_CAMERA_TOKEN. The
  // static token never reaches a browser again.
  // (Pinned by scripts/check-admin-token-leak.mjs.)
  const apiToken = await mintAdminApiToken();

  const sp = await searchParams;
  const rawCenter = sp.center;
  const initialCenterParam = Array.isArray(rawCenter) ? rawCenter[0] : rawCenter;

  return (
    <div className={adminPoppins.variable}>
      <KbfAdminClient token={apiToken} initialCenterParam={initialCenterParam ?? null} />
    </div>
  );
}
