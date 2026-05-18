import { notFound } from "next/navigation";
import KbfAdminClient from "./KbfAdminClient";

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

  const sp = await searchParams;
  const rawCenter = sp.center;
  const initialCenterParam = Array.isArray(rawCenter) ? rawCenter[0] : rawCenter;

  return <KbfAdminClient token={token} initialCenterParam={initialCenterParam ?? null} />;
}
