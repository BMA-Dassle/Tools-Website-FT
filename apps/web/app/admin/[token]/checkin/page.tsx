import { notFound } from "next/navigation";
import CheckInClient from "./CheckInClient";
import RaceControlBoard from "./RaceControlBoard";
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
   * `?board=1` swaps the licence scanner for the race control board.
   *
   * Branched HERE rather than inside CheckInClient on purpose. The scanner opens
   * a Web Serial port and runs a scan-flash state machine in a dozen hooks; a
   * mode flag inside it would either have to initialise all of that for a board
   * that needs none of it, or return early before its own hooks (which React
   * forbids). Two components behind one URL keeps the station staff use every
   * night completely untouched by work on the board.
   */
  const params2 = await searchParams;
  const wantsBoard = params2.board === "1";

  return (
    <div className={adminPoppins.variable}>
      {wantsBoard ? (
        <RaceControlBoard token={token} version={version} />
      ) : (
        <CheckInClient token={token} version={version} />
      )}
    </div>
  );
}
