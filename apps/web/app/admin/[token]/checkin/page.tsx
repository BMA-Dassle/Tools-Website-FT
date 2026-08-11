import { notFound } from "next/navigation";
import CheckInClient from "./CheckInClient";
import { adminPoppins } from "~/components/features/admin-skin/font";

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

  const sha = process.env.VERCEL_GIT_COMMIT_SHA || "";
  const version = sha ? sha.slice(0, 7) : "dev";

  /**
   * `?board=1` ADDS the briefing-room controls to this station.
   *
   * It is a flag on the check-in page, not a different page: the same staff
   * member checks racers in and sends the heat to a briefing room, and the
   * scanner, the session counts and the scan flash all stay exactly as they are.
   */
  const query = await searchParams;
  const boardMode = query.board === "1";

  return (
    <div className={adminPoppins.variable}>
      <CheckInClient token={token} version={version} boardMode={boardMode} />
    </div>
  );
}
