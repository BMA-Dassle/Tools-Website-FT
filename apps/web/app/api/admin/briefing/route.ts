import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { del } from "@vercel/blob";
import {
  briefingBoardStatus,
  clearRoom,
  sendBriefing,
  startBriefing,
} from "~/features/signage/briefing/service";
import {
  markRacePitted,
  overrideLaneSlot,
  sendToHolding,
} from "~/features/signage/pit/lane.server";
import {
  etCalledAtIso,
  readCalledRace,
  setCalledRace,
} from "~/features/signage/briefing/called-override.server";
import { readBriefingRoom } from "~/features/signage/briefing/state.server";
import { backfillAssignmentStaff } from "~/features/signage/briefing/assignments-db";
import { verifyPunchId } from "~/features/staff/service";
import { assignSessionHost } from "~/features/staff/session-host";
import type { StaffIdentity } from "~/features/staff/punch-index";
import { setAutoHoldingEnabled } from "~/features/signage/briefing/auto-holding.server";
import {
  CHECKIN_WINDOW_MAX_MINS,
  CHECKIN_WINDOW_MIN_MINS,
  setCheckinWindowOverride,
} from "~/features/signage/briefing/checkin-window.server";
import {
  setGreetingByMotionEnabled,
  setGreetingTiming,
} from "~/features/signage/briefing/greeting-setting.server";
import { setSendOverrideAllowed } from "~/features/signage/briefing/send-override-setting.server";
import {
  addPushSubscription,
  countPushSubscriptions,
  firePushForCue,
  pushConfig,
  sendTestPush,
  removePushSubscription,
} from "~/features/signage/briefing/push.server";
import { ALARM_KINDS, isAlarmKind, type AlarmCue } from "~/features/signage/briefing/desk-alarm";
import type { GreetingTiming } from "~/features/signage/briefing/return-greeting";
import { setRaceBookmarksEnabled } from "~/features/signage/briefing/race-bookmarks-setting.server";
import {
  setCameraPreviewMode,
  type CameraPreviewMode,
} from "~/features/signage/briefing/camera-preview-setting.server";
import { readPitLane } from "~/features/signage/pit/lane.server";
import { recordBriefingEvent } from "~/features/signage/briefing/events-db";
import { businessDayYmdET } from "@/lib/race-business-day";
import { isBriefingAssetKey, parseBriefingRoom } from "~/features/signage/briefing/types";
import { deleteSignageAsset, saveSignageAsset } from "~/features/signage/data/signage-assets-db";
import { briefingEnabled } from "~/features/signage/flags";
import { isAdminApiRequest } from "@/lib/admin-request-auth";

/**
 * Briefing rooms — the control board's API.
 *
 * A thin shell: parse, authorise, delegate to
 * ~/features/signage/briefing/service. Its own route rather than another action
 * on /api/admin/checkin (1,300 lines, and about licence scanning) or
 * /api/admin/signage (about provisioning screens) — one purpose per surface.
 *
 * Auth: middleware gates every /api/admin/* path on ADMIN_CAMERA_TOKEN. The
 * inline check repeats it because this route writes state that appears on a wall
 * in front of guests, the same reasoning as /api/admin/signage.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Defense in depth behind the middleware gate — see lib/admin-request-auth.
 * Accepts the static ADMIN_CAMERA_TOKEN (crons, scripts), a signed
 * short-lived token (what staff browsers now hold), or the SSO shell's
 * proxy key. Async because signature checks are Web Crypto.
 */
async function authed(req: NextRequest): Promise<boolean> {
  return isAdminApiRequest(req);
}

export async function GET(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const status = await briefingBoardStatus();
  // The push identity travels with the board: the gear needs the public key to
  // register a device, and `configured: false` is what lets it say "not set up"
  // instead of failing a subscribe. The PRIVATE key never leaves the server.
  const push = pushConfig();
  return NextResponse.json(
    {
      ...status,
      enabled: briefingEnabled(),
      push: { ...push, devices: await countPushSubscriptions() },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * A SESSION OCCUPIES EXACTLY ONE STAGE (owner 2026-08-14: "it can't be in
 * called and another slot at the same time though").
 *
 * The flow is a sequence — check-in, briefing room, holding, on track — and a
 * group is only ever standing in one of those places. Nothing enforced that
 * before, because nothing COULD put a session in two stages at once; Override
 * can, and the first screenshot of it showed Session 19 sitting in check-in and
 * a briefing room simultaneously.
 *
 * So placing a session advances it: every other stage naming it is vacated
 * first. Deliberately different from the one-session-per-slot rule, which
 * REFUSES rather than displaces — that rule protects a slot from two claimants,
 * and refusing makes a human look. This one is about a single session's own
 * history, where there is nothing to arbitrate: it cannot be in two places, so
 * the earlier place is simply wrong and goes.
 */
async function vacateSessionElsewhere(args: {
  sessionId: string;
  slot: "called" | "room" | "holding" | "karts" | "racing" | "pitIn";
  track: "blue" | "red" | "mega";
  room: "red" | "blue" | null;
}): Promise<void> {
  const tracks: Array<"blue" | "red" | "mega"> = ["blue", "red", "mega"];

  for (const t of tracks) {
    const called = await readCalledRace(t).catch(() => null);
    if (
      called &&
      String(called.sessionId) === args.sessionId &&
      !(args.slot === "called" && t === args.track)
    ) {
      await setCalledRace(t, null);
    }
  }

  for (const r of ["red", "blue"] as const) {
    if (args.slot === "room" && r === args.room) continue;
    const state = await readBriefingRoom("FT", r).catch(() => null);
    // clearRoom rather than a raw delete: it closes the occupancy in the
    // insurance log and puts the heat back on the check-in wall, which is what
    // leaving a room actually means.
    if (state?.sessionId === args.sessionId) await clearRoom(r).catch(() => {});
  }

  for (const t of tracks) {
    const lane = await readPitLane(t).catch(() => null);
    for (const slot of ["holding", "karts", "racing", "pitIn"] as const) {
      if (args.slot === slot && t === args.track) continue;
      const occ = lane?.[slot];
      if (occ?.sessionId === args.sessionId) {
        await overrideLaneSlot({ track: t, slot, occupant: null, force: true }).catch(() => {});
      }
    }
  }
}

export async function POST(req: NextRequest) {
  if (!(await authed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: {
    action?: string;
    room?: string;
    track?: string;
    sessionId?: string | number;
    heatNumber?: number;
    raceType?: string;
    tier?: string;
    slot?: string;
    force?: boolean;
    assetKey?: string;
    url?: string;
    size?: number;
    durationMs?: number;
    enabled?: boolean;
    mode?: string;
    // The greeting's three numbers. Typed loosely because they arrive over the
    // wire — every one is validated against its choice list before it lands.
    fallbackMs?: number | string;
    maxPlays?: number | string;
    lingerAfterMs?: number | string;
    /** The presser's employee punch ID, resolved to a person below. Absent from
     *  the desk board, which has no staff prompt. */
    punchId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const action = body.action ?? "";

  /* ── asset manifest ─────────────────────────────────────────────────── */

  if (action === "save-asset") {
    // The confirm-POST that lands after a direct-to-blob upload. This is what
    // makes an uploaded file the CURRENT one — see briefing-upload/route.ts for
    // why Vercel's own completion callback cannot do it here.
    if (!isBriefingAssetKey(body.assetKey)) {
      return NextResponse.json({ error: "unknown assetKey" }, { status: 400 });
    }
    const url = typeof body.url === "string" ? body.url : "";
    if (!url.startsWith("https://")) {
      return NextResponse.json({ error: "url required" }, { status: 400 });
    }
    const { replacedUrl } = await saveSignageAsset({
      key: body.assetKey,
      url,
      size: Number.isFinite(body.size) ? (body.size as number) : null,
      durationMs: Number.isFinite(body.durationMs) ? Math.round(body.durationMs as number) : null,
    });
    // The superseded film is now unreachable — nothing references it and the
    // players will prune their copies. Deleting it keeps a season of re-uploads
    // from quietly becoming a storage bill.
    if (replacedUrl) await del(replacedUrl).catch(() => {});
    return NextResponse.json({ ok: true, replaced: !!replacedUrl });
  }

  if (action === "delete-asset") {
    if (!isBriefingAssetKey(body.assetKey)) {
      return NextResponse.json({ error: "unknown assetKey" }, { status: 400 });
    }
    const removed = await deleteSignageAsset(body.assetKey);
    if (removed) await del(removed).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  /* ── room control ───────────────────────────────────────────────────── */

  // The kill switch makes a send a no-op rather than hiding the buttons: staff
  // get a clear "briefing rooms are switched off" instead of a control that
  // silently does nothing.
  if (!briefingEnabled()) {
    return NextResponse.json({ error: "briefing rooms are switched off" }, { status: 503 });
  }

  /**
   * THE CAMERA SWEEP'S KILL SWITCH, thrown from the board's own settings sheet
   * (owner 2026-08-14: "with the kill switch in settings of the check in board").
   *
   * Handled before the room parse because it takes no room, and deliberately is
   * not room-scoped: what is being switched off is a way of DECIDING, and a
   * sweep armed on one room and not the other would be harder to reason about at
   * 9pm than either state.
   */
  if (action === "auto-holding") {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
    }
    await setAutoHoldingEnabled(body.enabled);
    return NextResponse.json({ ok: true, enabled: body.enabled });
  }

  /**
   * HOW LONG A CALLED RACER HAS TO REACH THE DESK — the one number on that
   * sheet (owner 2026-08-23). Null clears the override and hands the window
   * back to the signage screen configs. Out-of-range is REJECTED rather than
   * clamped: it can only come from our own gear, so a bad value is a bug worth
   * seeing rather than a number to quietly reinterpret.
   */
  if (action === "checkin-window") {
    const mins = (body as { minutes?: unknown }).minutes ?? null;
    if (mins !== null && typeof mins !== "number") {
      return NextResponse.json({ error: "minutes must be a number or null" }, { status: 400 });
    }
    if (
      typeof mins === "number" &&
      (!Number.isFinite(mins) || mins < CHECKIN_WINDOW_MIN_MINS || mins > CHECKIN_WINDOW_MAX_MINS)
    ) {
      return NextResponse.json(
        {
          error: `minutes must be between ${CHECKIN_WINDOW_MIN_MINS} and ${CHECKIN_WINDOW_MAX_MINS}`,
        },
        { status: 400 },
      );
    }
    await setCheckinWindowOverride(mins);
    return NextResponse.json({ ok: true, minutes: mins });
  }

  /* ── deadline push alerts ───────────────────────────────────────────── */

  /**
   * REGISTER THIS DEVICE for the two deadline alerts (owner 2026-08-23). Keyed
   * by endpoint in push.server.ts, so re-registering the same phone replaces
   * its record rather than doubling every buzz.
   */
  if (action === "push-subscribe") {
    const sub = (body as { subscription?: unknown }).subscription;
    if (
      !sub ||
      typeof sub !== "object" ||
      typeof (sub as { endpoint?: unknown }).endpoint !== "string"
    ) {
      return NextResponse.json(
        { error: "subscription with an endpoint required" },
        { status: 400 },
      );
    }
    await addPushSubscription(sub as Parameters<typeof addPushSubscription>[0]);
    return NextResponse.json({ ok: true, devices: await countPushSubscriptions() });
  }

  if (action === "push-unsubscribe") {
    const endpoint = (body as { endpoint?: unknown }).endpoint;
    if (typeof endpoint !== "string" || !endpoint) {
      return NextResponse.json({ error: "endpoint required" }, { status: 400 });
    }
    await removePushSubscription(endpoint);
    return NextResponse.json({ ok: true, devices: await countPushSubscriptions() });
  }

  /**
   * A TEST ALERT ON DEMAND (owner 2026-08-24: "give some buttons to test push
   * alerts"). Same fan-out and same delivery path as a real cue, so a
   * successful test proves the real thing — only the claim is skipped and the
   * words say TEST. Returns the delivery count so the gear can report it.
   */
  if (action === "push-test") {
    const kind = (body as { kind?: unknown }).kind;
    if (!isAlarmKind(kind)) {
      return NextResponse.json(
        { error: `kind must be one of ${ALARM_KINDS.join(", ")}` },
        { status: 400 },
      );
    }
    const result = await sendTestPush(kind, Date.now());
    return NextResponse.json({ ok: true, ...result });
  }

  /**
   * FIRE ONE SLOT OF AN ALERT. The board computes the cue — it holds the live
   * race clock and the send window — and this fans it out, at most once per
   * (kind, session, slot) across every open board. See push.server.ts for why
   * the trigger is the board and not a cron: Vercel's cron floor is a minute
   * and the pattern is three sends ten seconds apart.
   *
   * Shape-checked strictly. A cue is machine-generated by our own board, so a
   * malformed one is a bug to surface rather than a payload to interpret.
   *
   * THE KIND LIST IS IMPORTED, NEVER RETYPED HERE. This guard was a hand-written
   * `=== "call" || === "send"` and the `pull` kind was added to desk-alarm.ts
   * and to the test button above without it — so the one alert staff most needed
   * on a phone was the one this endpoint would have refused.
   */
  if (action === "push-fire") {
    const cue = (body as { cue?: unknown }).cue as AlarmCue | undefined;
    const validKind = isAlarmKind(cue?.kind);
    const validSlot = cue?.slot === 1 || cue?.slot === 2 || cue?.slot === 3;
    if (!cue || !validKind || !validSlot || typeof cue.sessionId !== "string") {
      return NextResponse.json({ error: "cue{kind,slot,sessionId} required" }, { status: 400 });
    }
    const result = await firePushForCue({
      kind: cue.kind,
      slot: cue.slot,
      sessionId: cue.sessionId,
      heatNumber: typeof cue.heatNumber === "number" ? cue.heatNumber : null,
    });
    return NextResponse.json({ ok: true, ...result });
  }

  /**
   * MAY STAFF OVERRIDE A NO-TIME SEND (owner 2026-08-24). ON = the button lives
   * and asks a full confirm first; OFF = the 8/23 hard lock. Same sheet and
   * same shape as auto-holding; server-side because the room tablets run the
   * identical rule and must not disagree with the desk.
   */
  if (action === "send-override") {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
    }
    await setSendOverrideAllowed(body.enabled);
    return NextResponse.json({ ok: true, allowed: body.enabled });
  }

  /** The welcome-back greeting's mode — camera-timed (ON) or the fixed
   *  post+45s timer (OFF). Same sheet, same shape as auto-holding above. */
  if (action === "greeting-by-motion") {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
    }
    await setGreetingByMotionEnabled(body.enabled);
    return NextResponse.json({ ok: true, enabled: body.enabled });
  }

  /**
   * The greeting's three numbers (owner 2026-08-23). A PARTIAL patch: the sheet
   * sends only the field that was pressed, and setGreetingTiming merges over
   * what stands. Every value is validated against the choice list inside
   * (normaliseGreetingTiming), so nothing here needs to trust the body — but a
   * body with no recognised field at all is a bug worth a 400 rather than a
   * silent no-op that looks like a working press.
   */
  if (action === "greeting-timing") {
    const patch: Partial<GreetingTiming> = {};
    if (body.fallbackMs !== undefined) patch.fallbackMs = Number(body.fallbackMs);
    if (body.maxPlays !== undefined) patch.maxPlays = Number(body.maxPlays);
    if (body.lingerAfterMs !== undefined) patch.lingerAfterMs = Number(body.lingerAfterMs);
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: "send at least one of fallbackMs, maxPlays, lingerAfterMs" },
        { status: 400 },
      );
    }
    const timing = await setGreetingTiming(patch);
    return NextResponse.json({ ok: true, timing });
  }

  /** Race-event camera bookmarks — the other switch on the same sheet. */
  if (action === "race-bookmarks") {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be true or false" }, { status: 400 });
    }
    await setRaceBookmarksEnabled(body.enabled);
    return NextResponse.json({ ok: true, enabled: body.enabled });
  }

  /**
   * How hard the desk's room previews work the NVR — the third setting on that
   * sheet, and the only one that is a CHOICE rather than a switch, so it takes a
   * word instead of a boolean. Rejected rather than defaulted on a bad value:
   * this arrives from our own settings sheet, so anything else is a bug worth
   * seeing, not a value to quietly interpret.
   */
  if (action === "camera-preview") {
    if (body.mode !== "live" && body.mode !== "stills") {
      return NextResponse.json({ error: "mode must be live or stills" }, { status: 400 });
    }
    const mode: CameraPreviewMode = body.mode;
    await setCameraPreviewMode(mode);
    return NextResponse.json({ ok: true, mode });
  }

  /**
   * STAFF OVERRIDE — place a session in a lane slot, or empty it.
   *
   * Handled before the room parse, like "pitted", because it is track-keyed.
   * The occupancy guard lives in overrideLaneSlot, not here: a rule the UI
   * enforces is a rule a second tab can break.
   */
  if (action === "override") {
    const track =
      body.track === "blue" || body.track === "red" || body.track === "mega" ? body.track : null;
    if (!track) {
      return NextResponse.json({ error: "track must be blue, red or mega" }, { status: 400 });
    }
    const slot =
      body.slot === "holding" ||
      body.slot === "karts" ||
      body.slot === "racing" ||
      body.slot === "pitIn" ||
      body.slot === "called" ||
      body.slot === "room"
        ? body.slot
        : null;
    if (!slot) {
      return NextResponse.json(
        { error: "slot must be called, room, holding, karts, racing or pitIn" },
        { status: 400 },
      );
    }
    // STRINGIFIED AT THE BOUNDARY, never Number()'d — same rule as "send".
    const sessionId =
      typeof body.sessionId === "string"
        ? body.sessionId
        : typeof body.sessionId === "number"
          ? String(body.sessionId)
          : "";
    const heatNumber = Number.isInteger(body.heatNumber) ? (body.heatNumber as number) : null;
    const raceType = typeof body.raceType === "string" ? body.raceType : null;

    // Advancing a session vacates wherever else it was — see the helper above.
    // Only on a PLACEMENT: clearing a slot is already a removal.
    if (sessionId) {
      await vacateSessionElsewhere({ sessionId, slot, track, room: parseBriefingRoom(body.room) });
    }

    /**
     * CHECK-IN — the called record itself. Pandora owns this key normally; the
     * desk writes it only when Pandora cannot (see called-override.server.ts).
     * The event row is the audit trail, and it is action "override" rather than
     * "sent" because nobody went anywhere: a call was asserted, not performed.
     */
    if (slot === "called") {
      await setCalledRace(
        track,
        sessionId
          ? {
              trackName: track.charAt(0).toUpperCase() + track.slice(1),
              raceType,
              heatNumber,
              scheduledStart: null,
              calledAt: etCalledAtIso(),
              sessionId: Number(sessionId),
            }
          : null,
      );
      if (sessionId) {
        await recordBriefingEvent({
          venue: "FT",
          businessDay: businessDayYmdET(),
          room: parseBriefingRoom(body.room) ?? "red",
          track,
          sessionId,
          heatNumber,
          raceType,
          tier: null,
          action: "override",
          reason: "override",
        }).catch(() => {});
      }
      return NextResponse.json({ ok: true });
    }

    /**
     * BRIEFING — placing into a room reuses the ordinary send, so the room gets
     * its film, its assignment row and its briefed marker exactly as it would
     * have; clearing reuses Undo. An override that took a private path would be
     * an override whose result did not behave like the real thing.
     */
    if (slot === "room") {
      const target = parseBriefingRoom(body.room);
      if (!target) {
        return NextResponse.json({ error: "room must be red or blue" }, { status: 400 });
      }
      if (!sessionId) return NextResponse.json(await clearRoom(target));
      const result = await sendBriefing({
        room: target,
        track,
        sessionId,
        heatNumber,
        raceType,
      });
      // Override reaches here having already vacated this session from the other
      // room (vacateSessionElsewhere, above), so the one-group-one-room guard
      // cannot fire on this path — placing by hand still displaces, by design.
      return NextResponse.json(result, { status: result.ok ? 200 : 409 });
    }

    const result = await overrideLaneSlot({
      track,
      slot,
      // No sessionId means "empty this slot" — the way a mis-placed group is
      // taken back out before the right one goes in.
      occupant: sessionId
        ? { sessionId, heatNumber, raceType, room: parseBriefingRoom(body.room) }
        : null,
      force: body.force === true,
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }

  /**
   * "RACE RETURNED" — the pit lane's release (owner 2026-08-13). Track-keyed,
   * not room-keyed, so it is handled before the room parse below: the press
   * says the finished race's karts are fully back in the lane, and it is the
   * ONLY thing that ends the pit board's hold.
   */
  if (action === "pitted") {
    const track =
      body.track === "blue" || body.track === "red" || body.track === "mega" ? body.track : null;
    if (!track) {
      return NextResponse.json({ error: "track must be blue, red or mega" }, { status: 400 });
    }
    const result = await markRacePitted(track);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }

  /**
   * WHO IS PRESSING — resolved HERE, from the punch ID they typed, and never
   * taken from the client as a name.
   *
   * The tablet sends digits; this server turns digits into a person. That
   * ordering is the whole point: a board tab left open across a deploy, or a
   * hand-rolled POST, can assert `punchId: "9999"` and get nothing, but it can
   * never assert `firstName: "Alex"` onto somebody else's group.
   *
   * NULL IS A NORMAL ANSWER. An unknown ID, or 7shifts unreachable, yields no
   * staff and the action still runs — the prompt has already decided whether to
   * let the press through (see StaffPrompt's fail-open path), and a briefing
   * room must never be blocked by an HR API. What we lose is a name on a board,
   * which is the right thing to lose.
   */
  const acting: StaffIdentity | null =
    typeof body.punchId === "string" && body.punchId.trim()
      ? await verifyPunchId(body.punchId).then((r) => (r.ok ? r.staff : null))
      : null;

  const room = parseBriefingRoom(body.room);
  if (!room) return NextResponse.json({ error: "room must be red or blue" }, { status: 400 });

  if (action === "clear") {
    return NextResponse.json(await clearRoom(room));
  }

  /**
   * "SEND TO HOLDING" — the step after the briefing (owner 2026-08-13). The
   * group leaves the room for the pit seats: the room's occupancy closes in
   * the insurance log, the room frees for the returning race, and the pit
   * board's rail flips to its seat state. Same body shape as "send".
   */
  if (action === "send-holding") {
    const track =
      body.track === "blue" || body.track === "red" || body.track === "mega" ? body.track : null;
    if (!track) {
      return NextResponse.json({ error: "track must be blue, red or mega" }, { status: 400 });
    }
    // STRINGIFIED AT THE BOUNDARY, never Number()'d — same rule as "send".
    const sessionId =
      typeof body.sessionId === "string"
        ? body.sessionId
        : typeof body.sessionId === "number"
          ? String(body.sessionId)
          : "";
    if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    const result = await sendToHolding({
      room,
      track,
      sessionId,
      heatNumber: Number.isInteger(body.heatNumber) ? (body.heatNumber as number) : null,
      raceType: typeof body.raceType === "string" ? body.raceType : null,
    });

    /**
     * CLAIMED ONLY ON A SEND THAT ACTUALLY HAPPENED.
     *
     * This runs after the result, not before it, because the guard below
     * refuses far more often than it looks: holding already occupied, or a
     * concurrent send on a Mega night. Claiming first would let a REFUSED press
     * take the group — the presser walks away having done nothing, and the name
     * on the wall for the rest of the night is theirs instead of whoever
     * actually seated the grid. Attribution follows the action, never the
     * attempt.
     *
     * Still NX inside, so it defers to whoever pulled them into the room.
     */
    if (acting && result.ok) {
      const host = await assignSessionHost(sessionId, acting);
      // Same back-fill as startBriefing: the row predates the claim.
      await backfillAssignmentStaff(sessionId, host.userId, host.firstName).catch(() => {});
    }
    // A refusal is not a server fault — it is the guard doing its job — but it
    // must not read as success, or the page will say "sent to holding" for a
    // press that deliberately did nothing.
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }
    return NextResponse.json(result);
  }

  // Phase two of a send, and also "play it again" — the same operation either
  // way, so one action rather than two that could drift (see startBriefing).
  if (action === "start" || action === "restart") {
    const result = await startBriefing(room, acting);
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }

  if (action === "send") {
    const track =
      body.track === "blue" || body.track === "red" || body.track === "mega" ? body.track : null;
    if (!track) {
      return NextResponse.json({ error: "track must be blue, red or mega" }, { status: 400 });
    }
    // STRINGIFIED AT THE BOUNDARY, never Number()'d. Pandora session ids are
    // numeric today but BMI's id space exceeds Number.MAX_SAFE_INTEGER, and this
    // value is stored and round-tripped through JSON (house rule, CLAUDE.md).
    const sessionId =
      typeof body.sessionId === "string"
        ? body.sessionId
        : typeof body.sessionId === "number"
          ? String(body.sessionId)
          : "";
    if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });

    const result = await sendBriefing({
      room,
      track,
      sessionId,
      heatNumber: Number.isInteger(body.heatNumber) ? (body.heatNumber as number) : null,
      raceType: typeof body.raceType === "string" ? body.raceType : null,
      staff: acting,
      // NO TIER FROM THE CLIENT (owner 2026-08-16). The check-in board used to
      // send a staff-picked film here; blocking that in the UI alone would not
      // hold — a board tab left open across a deploy keeps posting the old body
      // shape — so `body.tier` is now ignored outright and sendBriefing derives
      // the film from the session's race type.
    });
    // 409 for the one-group-one-room refusal, matching start/restart above —
    // both boards render the message as an action note rather than a failure.
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}
