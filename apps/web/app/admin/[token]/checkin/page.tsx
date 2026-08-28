import { notFound } from "next/navigation";
import CheckInClient from "./CheckInClient";
import { adminPoppins } from "~/components/features/admin-skin/font";
import { mintAdminApiToken } from "@/lib/admin-api-token";

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

  /**
   * `?loc=ft|hpfm|naples` scopes the session-counts strip to one building —
   * each desk bookmarks its own URL. View-only: scanning accepts every
   * payload regardless (licence codes and FT QRs carry no location).
   * No `?loc=` (or an unknown value) keeps the all-venues view.
   */
  const locFilter = typeof query.loc === "string" ? query.loc : undefined;

  return (
    <div className={adminPoppins.variable}>
      <CheckInClient
        token={apiToken}
        version={version}
        boardMode={boardMode}
        locFilter={locFilter}
      />
    </div>
  );
}
