import "server-only";

/**
 * THE DESK'S DEADLINES, ON A PHONE IN A POCKET.
 *
 * The board already shouts (desk-alarm.ts + useDeskAlarm): a red box, a pulsing
 * button, three plays of a chime. All of it needs somebody within sight or
 * earshot of the desk PC. A manager walking the pits is neither, and the two
 * deadlines that cost a race — a call about to go late, a briefing window about
 * to shut — are exactly the ones worth interrupting a walk for (owner
 * 2026-08-23).
 *
 * ─── WHY THE BOARD TRIGGERS THIS, NOT A CRON ─────────────────────────────
 *
 * The alert pattern is three sends ten seconds apart. Vercel's cron floor is
 * ONE MINUTE, so a cron cannot express it at all — and a self-rescheduling
 * worker to fake sub-minute timing would be a second source of truth for a
 * decision the board already makes every second, with the live race clock in
 * hand. So the board POSTs the cue it has already computed and this fans it
 * out. The trade is stated plainly: no board tab open anywhere ⇒ no push. The
 * desk PC has the board open all night, which is the case this exists for.
 *
 * ─── ONE SEND PER SLOT, ACROSS EVERY BOARD ───────────────────────────────
 *
 * Two stations with the board open would otherwise each fan out the same three
 * alerts and a phone would buzz six times. The claim below is per (kind,
 * session, slot) in Redis with NX, so the first board to report a slot wins and
 * every other report of it is a no-op. The TTL outlives the alert and expires
 * long before the same heat number comes round tomorrow.
 *
 * ─── FAILURE IS ALWAYS SILENT AND ALWAYS SWALLOWED ───────────────────────
 *
 * A dead subscription, an unreachable push service, a missing VAPID key: none
 * of them may fail the caller. The board's own sound and colour are the primary
 * alarm; this is the extra reach, and extra reach must never break the thing it
 * is extending. A subscription the push service REJECTS as gone (404/410) is
 * deleted, because a phone that has revoked us will never come back on that
 * endpoint.
 */
import webpush, { type PushSubscription } from "web-push";
import redis from "@/lib/redis";
import { alarmMessage, type AlarmCue, type AlarmKind } from "./desk-alarm";

/** Every registered device, as a Redis hash: endpoint → subscription JSON. */
const SUBS_KEY = "briefing:push:subs";
/** Claim keys expire well after the alert and well before the next night. */
const CLAIM_TTL_SECONDS = 3600;

export interface PushConfigured {
  configured: boolean;
  publicKey: string | null;
}

/**
 * The VAPID identity. Absent in any environment where the keys have not been
 * set, which is the state a fresh deploy is in — hence `configured` rather than
 * a throw: the gear shows "not set up" instead of the board erroring.
 */
export function pushConfig(): PushConfigured {
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY || "";
  if (!publicKey || !privateKey) return { configured: false, publicKey: null };
  return { configured: true, publicKey };
}

function armed(): boolean {
  const { configured } = pushConfig();
  if (!configured) return false;
  webpush.setVapidDetails(
    // A mailto the push services can complain to. Ours, not a guest's.
    process.env.VAPID_SUBJECT || "mailto:eric@headpinz.com",
    process.env.VAPID_PUBLIC_KEY as string,
    process.env.VAPID_PRIVATE_KEY as string,
  );
  return true;
}

export async function addPushSubscription(sub: PushSubscription): Promise<void> {
  // Keyed BY ENDPOINT, so re-registering the same phone replaces its record
  // rather than adding a second one that would double every buzz.
  await redis.hset(SUBS_KEY, sub.endpoint, JSON.stringify(sub));
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  await redis.hdel(SUBS_KEY, endpoint);
}

export async function countPushSubscriptions(): Promise<number> {
  try {
    return await redis.hlen(SUBS_KEY);
  } catch {
    return 0;
  }
}

/**
 * Fan a cue out to every registered device, at most once per slot across the
 * whole estate. Returns what happened, for the caller's log — never throws.
 */
export async function firePushForCue(
  cue: AlarmCue,
): Promise<{ sent: number; skipped: boolean; pruned: number }> {
  if (!armed()) return { sent: 0, skipped: true, pruned: 0 };

  // THE CROSS-BOARD CLAIM. First reporter of this slot sends; everyone else is
  // a no-op. Also the reason a board that re-mounts mid-slot cannot re-buzz.
  let claimed = false;
  try {
    const key = `briefing:push:sent:${cue.kind}:${cue.sessionId}:${cue.slot}`;
    claimed = (await redis.set(key, "1", "EX", CLAIM_TTL_SECONDS, "NX")) === "OK";
  } catch {
    // A Redis blip must not silence the alert. Sending twice is a smaller
    // failure than not sending at all, so an unavailable claim store sends.
    claimed = true;
  }
  if (!claimed) return { sent: 0, skipped: true, pruned: 0 };

  const { title, body } = alarmMessage(cue);
  return fanOut({
    title,
    body,
    // The service worker uses this to collapse a session's three alerts into
    // one updating notification rather than three on the lock screen.
    tag: `${cue.kind}:${cue.sessionId}`,
    kind: cue.kind,
    ttlSeconds: 25,
  });
}

/**
 * A TEST ALERT, on demand from the gear (owner 2026-08-24: "give some buttons
 * to test push alerts").
 *
 * NO CLAIM, deliberately — the dedupe that stops two boards double-buzzing one
 * deadline would also swallow the second press of a test button, which is
 * exactly when somebody is standing there wondering whether it works. Each test
 * carries its own tag so repeated presses stack rather than replace, and a
 * longer TTL because a real alert is worthless once its deadline passes while a
 * test is worth delivering whenever the phone next wakes.
 *
 * IT SAYS IT IS A TEST, in the title, because these land on lock screens and a
 * plausible-looking "Session 42 is overdue" would send somebody running.
 */
export async function sendTestPush(
  kind: AlarmKind | "pull",
  stampMs: number,
): Promise<{ sent: number; skipped: boolean; pruned: number }> {
  if (!armed()) return { sent: 0, skipped: true, pruned: 0 };
  const body =
    kind === "call"
      ? "This is what a session about to be called late sounds like."
      : kind === "pull"
        ? "This is what PULL TO BRIEFING NOW looks like — the check-in window is up with racers missing."
        : "This is what a closing briefing window looks like.";
  return fanOut({
    title: "Test alert — FastTrax desk",
    body,
    tag: `test:${stampMs}`,
    kind,
    ttlSeconds: 300,
  });
}

/** The one fan-out both paths use, so a test proves the real delivery path. */
async function fanOut(msg: {
  title: string;
  body: string;
  tag: string;
  kind: string;
  ttlSeconds: number;
}): Promise<{ sent: number; skipped: boolean; pruned: number }> {
  let subs: Record<string, string>;
  try {
    subs = await redis.hgetall(SUBS_KEY);
  } catch {
    return { sent: 0, skipped: true, pruned: 0 };
  }

  const payload = JSON.stringify({
    title: msg.title,
    body: msg.body,
    tag: msg.tag,
    kind: msg.kind,
  });

  let sent = 0;
  let pruned = 0;
  await Promise.all(
    Object.entries(subs).map(async ([endpoint, raw]) => {
      let sub: PushSubscription;
      try {
        sub = JSON.parse(raw) as PushSubscription;
      } catch {
        await removePushSubscription(endpoint).catch(() => {});
        pruned++;
        return;
      }
      try {
        // A REAL ALERT EXPIRES IN 25s: one about a deadline 30 seconds out is
        // worthless after it, so it must not be held and delivered late. A test
        // asks for longer — see sendTestPush.
        await webpush.sendNotification(sub, payload, { TTL: msg.ttlSeconds });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410 = the phone has unsubscribed or the endpoint is retired. Any
        // other failure (a timeout, a 5xx from the push service) is transient
        // and the subscription is KEPT — pruning on those would quietly empty
        // the list over a few bad nights.
        if (status === 404 || status === 410) {
          await removePushSubscription(endpoint).catch(() => {});
          pruned++;
        }
      }
    }),
  );

  return { sent, skipped: false, pruned };
}
