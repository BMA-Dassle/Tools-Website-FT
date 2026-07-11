/**
 * Best-effort Teams notification for a VIP combo bowling time change.
 * NEVER throws — a Teams outage must not fail the reschedule that already
 * happened in QAMF/Neon. Returns whether the card actually posted.
 */
import { sendAdaptiveCardToChannel } from "@/lib/teams-bot";
import { vipMoveAlertsChatId } from "./config";
import {
  buildTimeChangeCard,
  timeChangeSummaryText,
  type TimeChangeParams,
} from "./time-change-card";

export async function sendBowlingTimeChangedAlert(params: TimeChangeParams): Promise<boolean> {
  try {
    await sendAdaptiveCardToChannel(vipMoveAlertsChatId(), buildTimeChangeCard(params), {
      summaryText: timeChangeSummaryText(params),
    });
    return true;
  } catch (err) {
    console.error("[vip-move] time-change card failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
