/**
 * VIP cross-center movement alerts — configuration.
 *
 * Staff Teams chat that receives "walk the guests over" cards when a VIP
 * combo party finishes a leg at one center and their next step is at the
 * other (FastTrax karting <-> HeadPinz bowling). Sent through the shared
 * portal bot (lib/teams-bot.ts) — the bot must be a member of the chat.
 */

import { adminToolUrl } from "~/lib/helpers/admin-url";

export const DEFAULT_CHAT_ID = "19:b6778beb928a4f55a7799e16e0045218@thread.v2";

/** Target chat — env override lets a canary point at a test chat without a deploy. */
export function vipMoveAlertsChatId(): string {
  return process.env.VIP_MOVE_ALERTS_CHAT_ID || DEFAULT_CHAT_ID;
}

/** Kill switch: set VIP_MOVE_ALERTS_ENABLED=false to silence the cron
 *  (server-only env — flippable without a rebuild). Default ON: registering
 *  the cron in vercel.json is the deliberate enable act. */
export function vipMoveAlertsEnabled(): boolean {
  return process.env.VIP_MOVE_ALERTS_ENABLED !== "false";
}

/** Owner-mandated line on every card while the feature is in trial. */
export const BETA_DISCLAIMER = "BETA TESTING, WE DO NOT PROMISE RELIABILITY";

/** Deep link to the reservations admin board pre-filtered to ★VIP — the
 *  cards' "Open VIP board" button.
 *
 *  Points at the SSO staff shell and carries NO credential. It used to embed
 *  ADMIN_CAMERA_TOKEN, which meant every card posted into a Teams chat was a
 *  copy of the permanent admin secret — visible to everyone in the chat,
 *  searchable in Teams history, and un-rotatable without breaking the archive.
 *  The `| null` stays only so the pure card builders keep their omit-the-button
 *  branch; there is nothing left that can make it null. */
export function vipBoardUrl(): string | null {
  return adminToolUrl("reservations", { view: "vip" });
}

/** A step that is done by CLOCK only (no QAMF/Pandora truth signal) waits
 *  this long past its scheduled end before alerting — covers lane-close
 *  webhook lag and Pandora-unresolvable heats without pinging at the exact
 *  scheduled minute for a party that's running long. */
export const CLOCK_DONE_GRACE_MIN = 10;

/** Never alert once the finished step is this old — late catch-up data
 *  (mirrors the race settle gate's 45-min grace). */
export const STALE_AFTER_MIN = 45;

/** When one party finishes bowling, other parties whose bowling ends within
 *  this window are swept into the SAME card ("ends in ~3 min") instead of
 *  pinging the chat again minutes later. */
export const BOWLING_COMBINE_WINDOW_MIN = 5;

/** Fire-once dedup key lifetime (per combo + direction + day). */
export const DEDUP_TTL_S = 24 * 60 * 60;

/** Safety valve: max cards per day, far above any real day's movement. */
export const DAILY_SEND_CAP = 40;
