import { notFound } from "next/navigation";
import BriefingRoomClient from "./BriefingRoomClient";
import { adminPoppins } from "~/components/features/admin-skin/font";
import { parseBriefingRoom } from "~/features/signage/briefing/types";
import { mintAdminApiToken } from "@/lib/admin-api-token";

/**
 * THE IN-ROOM BRIEFING SCREEN — one room, two presses.
 *
 * A SIBLING OF THE DESK BOARD, NOT A REPLACEMENT FOR IT. `/admin/{token}/checkin
 * ?board=1` is the whole night on one monitor: five stages, two rooms, wait
 * times, the log, the override sheet. This is the tablet ON THE WALL of a single
 * briefing room, and the person holding it is standing in front of the group.
 * They need exactly two things — roll the film, and move this group to the pit
 * seats — at a size that can be hit without looking.
 *
 * So it is deliberately NOT a narrower render of the board. It shows one room,
 * one session, and the holding area they are about to walk to; everything else
 * the board carries is absent on purpose, because a control nobody in this room
 * would press is a control that makes the two that matter harder to find.
 *
 * IT ADDS NO SERVER SURFACE. Every action goes to /api/admin/briefing, the same
 * route the desk board drives, and the state comes from useBriefingControl — the
 * board's own hook, reused rather than forked, so a fix to the send/start rules
 * lands on both screens at once.
 *
 * AUTH is the middleware's unified admin gate on /admin/*, exactly as for every
 * other tool under this token. It matters more here than usual: the page shows a
 * live camera of the pit holding area, and the token is what stands between that
 * and the open internet.
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
  // Belt and braces with the middleware gate — the same pattern the check-in
  // page uses, so a routing change can never quietly expose this.
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
   * WHICH ROOM THIS TABLET IS. Absent is a legitimate state, not an error: a
   * screen being set up for the first time gets a two-button picker rather than
   * a 404, and the choice is remembered locally afterwards so the bare URL is
   * bookmarkable.
   */
  const query = await searchParams;
  const raw = query.room;
  const room = parseBriefingRoom(Array.isArray(raw) ? raw[0] : raw);

  return (
    <div className={adminPoppins.variable}>
      <BriefingRoomClient token={apiToken} version={version} room={room} />
    </div>
  );
}
