import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { listVipComboReservations, type ReservationProductKind } from "@/lib/bowling-db";
import { sendEmail } from "@/lib/sendgrid";
import { verifyCron } from "@/lib/cron-auth";
import { buildVipAlmostHereEmail, buildVipAlmostHereSms } from "~/features/combos/almost-here";
import { getComboSpecial } from "~/features/combos/combo-specials";
import { appendBookingMemoLine } from "~/features/reservations-admin/bmi-notes";
import {
  buildComboGroups,
  stepProgress,
  type ComboGroup,
} from "~/features/reservations-admin/combo-board";
import { fmtClock, nowEtWallMs, todayET } from "~/features/reservations-admin/format";
import type { ComboMeta, Reservation } from "~/features/reservations-admin/types";
import { a2pSender } from "~/features/sms/sender";

/**
 * T-60 "Your VIP Experience is almost here" cron — every 5 minutes.
 *
 * Finds today's Ultimate VIP combo bookings whose FIRST itinerary step starts
 * within the next 60 minutes and sends the guest one email + one SMS with the
 * FastTrax check-in route (side door, 1st floor, turn left, Group Event
 * counter). Deliberately light: booked schedule only — no BMI/QAMF live
 * enrichment (a pre-arrival message doesn't need heat-move precision, and the
 * vip-move-alerts cron already watches live movement).
 *
 * Anti-spam mirrors vip-move-alerts: fire-once Redis NX claim per combo per
 * day, claimed BEFORE the send, FAILS CLOSED on Redis errors. A failed send
 * never releases the claim (no cross-tick retry storm); SMS quota hits queue
 * through sms-quota like every other rail.
 *
 * Each successful send is also logged on the booking memo (BMI project
 * private log via appendBookingMemoLine) so the desk sees what the guest was
 * told (owner 2026-08-01).
 *
 * Query params:
 *   ?dryRun=1        — report eligibility, no claims/sends/memos
 *   ?test=<dest>     — send ONE sample message (registry copy, start = now+60m)
 *                      to <dest> (email if it contains "@", else phone) and
 *                      exit; bypasses window, claims, and memo logging
 *
 * Kill switch: VIP_ALMOST_HERE_ENABLED=false (default ON — registering the
 * cron in vercel.json is the deliberate enable act, same as vip-move-alerts).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WINDOW_MIN = 60;
const DEDUP_TTL_S = 24 * 60 * 60;
/** Check-in happens at FastTrax — send from the FastTrax number. */
const SMS_FROM_FASTTRAX = a2pSender();
const AUDIT_BCC = "vendorcases@dassle.us";

const claimKey = (ymd: string, groupKey: string) => `alert:vip-almosthere:${ymd}:${groupKey}`;

/** Fire-once claim — FAILS CLOSED (Redis error → suppress, never spam). */
async function claimOnce(key: string): Promise<boolean> {
  try {
    return (await redis.set(key, "1", "EX", DEDUP_TTL_S, "NX")) === "OK";
  } catch (err) {
    console.warn("[vip-almost-here] redis dedup failed (suppressing send):", err);
    return false;
  }
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "").replace(/^1/, "");
}

/** voxSend + logSms + quota-queue wrapper — same shape as lane-ready's. */
async function sendSms(to: string, body: string): Promise<boolean> {
  const normalized = normalizePhone(to);
  if (normalized.length < 10) return false;
  const toFormatted = normalized.length === 10 ? `+1${normalized}` : `+${normalized}`;
  const { voxSend } = await import("@/lib/sms-retry");
  const { logSms } = await import("@/lib/sms-log");
  const result = await voxSend(toFormatted, body, { fromOverride: SMS_FROM_FASTTRAX });

  await logSms({
    ts: new Date().toISOString(),
    phone: toFormatted,
    source: "vip-almost-here",
    status: result.status,
    ok: result.ok,
    body,
    provider: result.provider,
    failedOver: result.failedOver,
    providerMessageId: result.voxId || result.twilioSid,
  }).catch(() => void 0);

  if (result.ok) return true;
  if (result.skipped || result.quotaHit) {
    const { quotaEnqueue } = await import("@/lib/sms-quota");
    await quotaEnqueue({
      phone: toFormatted,
      body,
      from: SMS_FROM_FASTTRAX,
      source: "vip-almost-here",
      queuedAt: new Date().toISOString(),
    });
    return true; // delivered eventually via the quota drain
  }
  return false;
}

/** First scheduled (time-carrying) step of the combo itinerary. */
function firstTimedStep(group: ComboGroup) {
  return group.schedule.find((s) => s.iso) ?? null;
}

export async function GET(req: NextRequest) {
  const denied = verifyCron(req);
  if (denied) return denied;

  if (process.env.VIP_ALMOST_HERE_ENABLED === "false") {
    return NextResponse.json({ ok: true, skipped: "VIP_ALMOST_HERE_ENABLED=false" });
  }

  const params = new URL(req.url).searchParams;
  const dryRun = params.get("dryRun") === "1";
  const test = params.get("test");

  // ── Test mode: one sample message to the given destination, nothing else ──
  if (test) {
    const combo = getComboSpecial("race-bowl");
    const startTimeLabel = fmtClock(new Date(Date.now() + WINDOW_MIN * 60_000).toISOString());
    const email = buildVipAlmostHereEmail({
      comboName: combo?.name ?? "VIP Experience",
      guestFirstName: "Test",
      startTimeLabel,
    });
    if (test.includes("@")) {
      const res = await sendEmail({
        to: test,
        subject: `[TEST] ${email.subject}`,
        html: email.html,
        text: email.text,
      });
      return NextResponse.json({ ok: res.ok, test: "email", to: test, error: res.error });
    }
    const smsOk = await sendSms(test, buildVipAlmostHereSms());
    return NextResponse.json({ ok: smsOk, test: "sms", to: test });
  }

  const ymd = todayET();
  const nowMs = nowEtWallMs();
  const result = {
    ok: true,
    date: ymd,
    combos: 0,
    eligible: 0,
    sent: 0,
    alreadySent: 0,
    failed: 0,
    memoLogged: 0,
    dryRun,
    preview: [] as Array<{ group: string; guest: string; startsInMin: number }>,
    errors: [] as string[],
  };

  try {
    const vipReservations = await listVipComboReservations({ startDate: ymd, endDate: ymd });
    if (!vipReservations.length) return NextResponse.json(result);

    const comboMeta: Record<string, ComboMeta> = {};
    for (const r of vipReservations) {
      const id = r.comboSpecialId;
      if (!id || comboMeta[id]) continue;
      const combo = getComboSpecial(id);
      if (combo) {
        const bowlingLeg = combo.components.find((c) => c.kind === "bowling");
        comboMeta[id] = {
          name: combo.name,
          accentColor: combo.accentColor,
          includes: combo.includes,
          center: combo.center,
          bowlingDurationMinutes: bowlingLeg?.durationMinutes,
        };
      }
    }

    // Same structural bridge run.server.ts uses — Neon rows are camelCase and
    // carry every field buildComboGroups touches.
    const groups = buildComboGroups(vipReservations as unknown as Reservation[], comboMeta, nowMs);
    result.combos = groups.length;

    for (const group of groups) {
      const live = group.legs.some((l) => l.status !== "cancelled" && l.status !== "no_show");
      if (!live) continue;

      const first = firstTimedStep(group);
      if (!first?.iso) continue;
      const prog = stepProgress(first, nowMs);
      if (!prog || prog.state !== "upcoming") continue;
      if (prog.minsUntil <= 0 || prog.minsUntil > WINDOW_MIN) continue;

      result.eligible++;
      const guestFirst = (group.guestName ?? "").trim().split(/\s+/)[0] || "there";
      if (dryRun) {
        result.preview.push({
          group: group.key,
          guest: group.guestName || "?",
          startsInMin: Math.round(prog.minsUntil),
        });
        continue;
      }

      if (!(await claimOnce(claimKey(ymd, group.key)))) {
        result.alreadySent++;
        continue;
      }

      const guestEmail =
        group.anchor.guestEmail || group.legs.find((l) => l.guestEmail)?.guestEmail;
      const guestPhone = group.guestPhone || group.legs.find((l) => l.guestPhone)?.guestPhone;
      const comboName = group.meta?.name ?? "VIP Experience";
      const startTimeLabel = fmtClock(first.iso);

      let emailOk = false;
      let smsOk = false;
      try {
        if (guestEmail) {
          const email = buildVipAlmostHereEmail({
            comboName,
            guestFirstName: guestFirst,
            startTimeLabel,
          });
          const res = await sendEmail({
            to: guestEmail,
            toName: group.guestName || undefined,
            subject: email.subject,
            html: email.html,
            text: email.text,
            bcc: AUDIT_BCC,
          });
          emailOk = res.ok;
        }
        if (guestPhone) {
          smsOk = await sendSms(guestPhone, buildVipAlmostHereSms());
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[vip-almost-here] send failed group=${group.key}:`, msg);
        result.errors.push(`${group.key}: ${msg}`);
      }

      if (emailOk || smsOk) {
        result.sent++;
        // Booking-memo trail — best-effort, on the race leg's project (check-in
        // is at FastTrax; that's where the desk reads the memo).
        const memoLeg =
          group.legs.find((l) => l.productKind === "race" && l.bmiBillId) ??
          group.legs.find((l) => l.bmiBillId);
        if (memoLeg) {
          const channels = [
            smsOk ? `SMS to ${guestPhone}` : null,
            emailOk ? `email to ${guestEmail}` : null,
          ]
            .filter(Boolean)
            .join("; ");
          const logged = await appendBookingMemoLine(
            {
              id: memoLeg.id,
              bmiBillId: memoLeg.bmiBillId,
              bmiReservationNumber: memoLeg.bmiReservationNumber,
              centerCode: memoLeg.centerCode,
              productKind: memoLeg.productKind as ReservationProductKind,
            },
            `VIP almost-here (T-60) sent — ${channels}. Guest told: side door, 1st floor, Group Event counter.`,
          ).catch(() => false);
          if (logged) result.memoLogged++;
        }
      } else {
        result.failed++;
        // Claim stays set on purpose — a broken send should not retry every
        // 5 minutes into a guest's phone; the sms-quota queue covers the
        // recoverable case.
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[vip-almost-here] run failed:", msg);
    result.ok = false;
    result.errors.push(msg);
  }

  return NextResponse.json(result);
}
