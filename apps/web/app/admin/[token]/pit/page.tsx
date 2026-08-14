import { notFound } from "next/navigation";
import PitClient from "./PitClient";
import { adminPoppins } from "~/components/features/admin-skin/font";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = {
  params: Promise<{ token: string }>;
};

/**
 * The pit control station — its own URL, like check-in (owner 2026-08-14:
 * "it is its own thing so like checkin it will have its own URL"). Same
 * bearer-token gate as every /admin/{token}/* page; middleware fails closed
 * without ADMIN_CAMERA_TOKEN.
 */
export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  const sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
  const version = sha ? sha.slice(0, 7) : "dev";

  return (
    <div className={adminPoppins.variable}>
      <PitClient token={token} version={version} />
    </div>
  );
}
