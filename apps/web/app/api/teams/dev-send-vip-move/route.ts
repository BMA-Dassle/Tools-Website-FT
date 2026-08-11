import { NextRequest, NextResponse } from "next/server";
import { sendAdaptiveCardToChannel } from "@/lib/teams-bot";
import { vipMoveAlertsChatId } from "~/features/vip-move-alerts/config";
import type { MoveDirection, PendingMove } from "~/features/vip-move-alerts/detect";
import { buildMoveCard, moveSummaryText } from "~/features/vip-move-alerts/teams-card";
import { nowEtWallMs } from "~/features/reservations-admin/format";

/**
 * POST /api/teams/dev-send-vip-move
 *
 * Dev-only helper: posts a SAMPLE VIP movement card to the real alert chat so
 * the rendering (lane, times, gap, disclaimer) can be verified end-to-end
 * before a live combo day. Clean up with POST /api/teams/dev-delete using the
 * returned ids. Same gate as dev-delete.
 *
 * Body (optional): { direction?: "karting_to_bowling" | "bowling_to_karting" }
 * Header: x-dev-secret: <PORTAL_FORWARD_SECRET>
 */
export async function POST(req: NextRequest) {
  const expected = process.env.PORTAL_FORWARD_SECRET || "";
  const got = req.headers.get("x-dev-secret") || "";
  if (!expected || got !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { direction?: MoveDirection } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine — default direction */
  }
  const direction: MoveDirection = body.direction ?? "karting_to_bowling";

  const nowMs = nowEtWallMs();
  const inMin = (m: number) => new Date(nowMs + m * 60_000).toISOString().slice(0, 19);
  const toBowling = direction === "karting_to_bowling";
  const sample: PendingMove[] = [
    {
      groupKey: "sample-1",
      direction,
      guestName: "Sample Guest (TEST)",
      playerCount: 4,
      comboName: "VIP Experience",
      from: toBowling
        ? {
            icon: "",
            label: "Starter Race · Blue",
            iso: inMin(-12),
            loc: "FastTrax",
            durationMin: 10,
            raceState: "finished",
          }
        : {
            icon: "",
            label: "VIP Bowling",
            iso: inMin(-95),
            lane: "7",
            loc: "HeadPinz Fort Myers",
            durationMin: 90,
            legStatus: "completed",
          },
      to: toBowling
        ? {
            icon: "",
            label: "VIP Bowling",
            iso: inMin(40),
            lane: "7",
            loc: "HeadPinz Fort Myers",
            durationMin: 90,
          }
        : {
            icon: "",
            label: "Intermediate Race · Blue",
            iso: inMin(25),
            loc: "FastTrax",
            durationMin: 30,
          },
    },
    {
      groupKey: "sample-2",
      direction,
      guestName: "Second Party (TEST)",
      playerCount: 2,
      comboName: "VIP Experience",
      from: toBowling
        ? {
            icon: "",
            label: "Starter Race · Red",
            iso: inMin(-10),
            loc: "FastTrax",
            durationMin: 10,
            raceState: "finished",
          }
        : {
            icon: "",
            label: "VIP Bowling",
            iso: inMin(-87),
            lane: "5",
            loc: "HeadPinz Fort Myers",
            durationMin: 90,
          },
      to: toBowling
        ? {
            icon: "",
            label: "VIP Bowling",
            iso: inMin(40),
            lane: "5",
            loc: "HeadPinz Fort Myers",
            durationMin: 90,
          }
        : {
            icon: "",
            label: "Intermediate Race",
            iso: null,
            loc: "FastTrax",
            pending: true,
            durationMin: 30,
          },
      ...(toBowling ? {} : { endingSoon: { minsLeft: 3 } }),
    },
  ];

  const conversationId = vipMoveAlertsChatId();
  const res = await sendAdaptiveCardToChannel(
    conversationId,
    buildMoveCard(direction, sample, nowMs),
    { summaryText: `[TEST] ${moveSummaryText(direction, sample)}` },
  );
  return NextResponse.json({ conversationId, activityId: res.id });
}
