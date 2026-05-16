import { notFound } from "next/navigation";
import KbfAdminClient from "./KbfAdminClient";

/**
 * Admin: Kids Bowl Free — account lookup, bowler selection, Bowl Now / Book Lane.
 *
 * URL: /admin/{ADMIN_CAMERA_TOKEN}/kbf
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Props = { params: Promise<{ token: string }> };

export default async function Page({ params }: Props) {
  const { token } = await params;
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  if (!expected || token !== expected) notFound();

  return <KbfAdminClient token={token} />;
}
