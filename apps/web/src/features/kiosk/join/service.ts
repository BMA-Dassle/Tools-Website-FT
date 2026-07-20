import { isAtLeast18 } from "./age";
import * as store from "./store";
import {
  ABSOLUTE_CAP_MS,
  ACTIVE_WINDOW_MS,
  CLOSED_GRACE_SEC,
  JOIN_PAGE_PATH,
  MAX_JOINS_PER_SESSION,
  SESSION_TTL_SEC,
  type ClientStage,
  type CloseReason,
  type GuestMetaResult,
  type JoinGuestPayload,
  type JoinSession,
  type JoinedGuest,
  type KioskPollResult,
  type SubmitGuestResult,
} from "./types";
import type { CreateJoinSessionInput } from "./schemas";

/**
 * Mobile-join session state machine.
 *
 *   (none) ──create──► OPEN ──close(reason)/supersede/2h-cap──► CLOSED
 *   OPEN ──kiosk stops polling 300s (crash)──► GONE (keys expire)
 *   CLOSED ──120s grace──► GONE
 *
 * OPEN accepts joins/heartbeats/polls. CLOSED rejects joins but reports the
 * close reason so phones can say "the group moved on" vs "expired". GONE 404s
 * and phones show a generic "session ended".
 */

export async function createJoinSession(
  input: CreateJoinSessionInput,
  origin: string,
): Promise<{ code: string; joinUrl: string; expiresAt: number }> {
  // One open session per kiosk: a new create supersedes the previous code so
  // phones on a stale QR see a clean "expired" instead of joining a dead list.
  const prior = await store.getKioskPointer(input.kioskId);
  if (prior) {
    const priorSession = await store.readSession(prior);
    if (priorSession && priorSession.status === "open") {
      await closeInternal(priorSession, "superseded");
    }
  }

  const now = Date.now();
  const session: JoinSession = {
    code: store.newJoinCode(),
    kioskId: input.kioskId,
    center: input.center,
    brand: input.brand,
    stepKind: input.stepKind,
    status: "open",
    createdAt: now,
  };
  await store.writeSession(session, SESSION_TTL_SEC);
  await store.setKioskPointer(input.kioskId, session.code);
  return {
    code: session.code,
    joinUrl: `${origin}${JOIN_PAGE_PATH}/${session.code}`,
    expiresAt: now + ABSOLUTE_CAP_MS,
  };
}

/** Kiosk poll — the session keepalive. Slides all TTLs, enforces the absolute
 *  cap, and reports joined guests + phone presence. */
export async function kioskPoll(code: string): Promise<KioskPollResult> {
  const session = await store.readSession(code);
  if (!session) return { status: "gone" };
  if (session.status === "closed") {
    return { status: "closed", closeReason: session.closeReason };
  }
  if (Date.now() - session.createdAt > ABSOLUTE_CAP_MS) {
    await closeInternal(session, "expired");
    return { status: "closed", closeReason: "expired" };
  }

  await store.refreshTtls(code, SESSION_TTL_SEC);
  const [guests, clients] = await Promise.all([store.listGuests(code), store.readClients(code)]);
  const now = Date.now();
  let active = 0;
  let inProgress = 0;
  for (const presence of Object.values(clients)) {
    if (now - presence.lastSeen > ACTIVE_WINDOW_MS) continue;
    active += 1;
    if (presence.stage !== "done") inProgress += 1;
  }
  return { status: "open", guests, clients: { active, inProgress } };
}

/** Idempotent close. Already-closed and gone sessions are both fine. */
export async function closeJoinSession(code: string, reason: CloseReason): Promise<void> {
  const session = await store.readSession(code);
  if (!session || session.status === "closed") return;
  await closeInternal(session, reason);
}

async function closeInternal(session: JoinSession, reason: CloseReason): Promise<void> {
  const closed: JoinSession = {
    ...session,
    status: "closed",
    closeReason: reason,
    closedAt: Date.now(),
  };
  await store.writeSession(closed, CLOSED_GRACE_SEC);
  await store.applyClosedGrace(session.code);
  await store.delKioskPointerIfCurrent(session.kioskId, session.code);
}

/** Phone-side resolve + status poll. When `clientId` is present and the
 *  session is open, the poll doubles as the presence heartbeat (there is no
 *  separate "hello" route). NEVER slides the session TTL — only the kiosk
 *  keeps a session alive. */
export async function guestMeta(
  code: string,
  clientId?: string,
  stage?: ClientStage,
): Promise<GuestMetaResult> {
  const session = await store.readSession(code);
  if (!session) return { status: "gone" };
  if (session.status === "closed") {
    return {
      status: "closed",
      closeReason: session.closeReason,
      center: session.center,
      brand: session.brand,
    };
  }
  if (clientId) {
    await store.heartbeat(code, clientId, stage ?? "landing");
  }
  return {
    status: "open",
    center: session.center,
    brand: session.brand,
    stepKind: session.stepKind,
    splitPaymentAvailable: false,
  };
}

/** Identity key for dedupe/idempotency — one atomic SADD covers both "same
 *  guest from two phones" and a network-retry replay of the same POST. */
export function identityKeyFor(guest: JoinGuestPayload): string {
  if (guest.bmiPersonId) return `bmi:${guest.bmiPersonId}`;
  if (guest.pandoraPersonId) return `pandora:${guest.pandoraPersonId}`;
  const last = (guest.lastName ?? "").trim().toLowerCase();
  return `name:${guest.firstName.trim().toLowerCase()}|${last}|${guest.dobIso}`;
}

export async function submitGuest(
  code: string,
  clientId: string,
  guest: JoinGuestPayload,
): Promise<SubmitGuestResult> {
  const session = await store.readSession(code);
  if (!session) return { ok: false, error: "gone" };
  if (session.status === "closed") {
    return { ok: false, error: "closed", reason: session.closeReason };
  }

  // The one rule that must not be client-only: phones are adults-only.
  if (!isAtLeast18(guest.dobIso)) return { ok: false, error: "must-be-adult" };

  if ((await store.guestCount(code)) >= MAX_JOINS_PER_SESSION) {
    return { ok: false, error: "full" };
  }

  const identityKey = identityKeyFor(guest);
  const isNew = await store.tryClaimIdentity(code, identityKey);
  if (!isNew) {
    // Duplicate join or POST replay — success semantics, kiosk never dupes.
    await store.heartbeat(code, clientId, "done");
    return { ok: true, alreadyJoined: true };
  }

  const joined: JoinedGuest = {
    joinId: store.newJoinId(),
    clientId,
    joinedAt: Date.now(),
    guest,
  };
  try {
    await store.pushGuest(code, joined);
  } catch (err) {
    // Claim without a list entry would make the guest silently unjoinable —
    // release it so the phone's retry can land.
    await store.releaseIdentity(code, identityKey).catch(() => {});
    throw err;
  }

  // TOCTOU remainder: the kiosk may have closed between our status read and
  // the RPUSH. The entry stays in the (dying) list, but the kiosk stopped
  // polling — tell the phone the group moved on rather than claiming success.
  const after = await store.readSession(code);
  if (!after || after.status === "closed") {
    return { ok: false, error: "landed-late" };
  }

  await store.heartbeat(code, clientId, "done");
  return { ok: true, joinId: joined.joinId };
}
