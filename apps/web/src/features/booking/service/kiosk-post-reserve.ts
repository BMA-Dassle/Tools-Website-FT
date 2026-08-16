/**
 * Kiosk post-reserve rail — server-side money/notification follow-through.
 *
 * The WEB confirmation page (`app/book/confirmation/v2/page.tsx`) fires the
 * guest confirmation notification AND the Pandora session assignment from the
 * BROWSER after the reservation confirms. A self-service KIOSK terminal has no
 * such client step — the guest walks away as soon as the reader charge clears —
 * so those actions must happen SERVER-SIDE, right after `confirmBmiPayment`
 * succeeds inside `unified-reserve`.
 *
 * This module is the ONLY place that follow-through lives, and it is called
 * EXCLUSIVELY from `unifiedReserveInner` behind a strict
 * `session.context?.kiosk === true` gate. The web path never imports or runs
 * any of this, so web behavior stays byte-identical.
 *
 * CONTRACT: this function NEVER throws. The booking is already confirmed and
 * the deposit already captured by the time we get here — a failed notification
 * or session assignment must never surface as a reserve error. Each of the four
 * actions is independently try/caught so one failing does not block the others.
 *
 * Absolute-URL note (see lib/pandora-party-lead.ts header for the lesson):
 *   - Pandora session assignment calls Pandora DIRECTLY (no internal HTTP hop),
 *     mirroring the inline Pandora state flip in unified-reserve. This avoids an
 *     origin dependency entirely AND lets us target the FastTrax RACING location
 *     explicitly (the `/api/pandora/schedule` route hardcodes the wrong center
 *     as its fallback location id).
 *   - The guest confirmation notification reuses the rich
 *     `/api/notifications/booking-confirmation` route (email templates, QR,
 *     sales-log, VIP branching, Redis dedup) via an absolute URL built from
 *     `NEXT_PUBLIC_SITE_URL` with a hard-coded prod fallback — the exact
 *     convention the cron jobs use (checkin-alerts, pre-race-tickets,
 *     deposit-retry-sweep). Reimplementing that pipeline here would be a large,
 *     drift-prone duplication.
 */
import { getRaceProductById } from "./race-products";
import { buildReservationMemo } from "./reservation-memo";
import { raceWarningMemo } from "./race-warnings";
import {
  appendProjectPrivateNote,
  setProjectState,
  KIOSK_CONFIRMATION_STATE_IDS,
} from "@/lib/bmi-office-actions";
import { isVipComboBooking } from "~/features/combos/combo-specials";
import { stampVipStateIfCombo } from "~/features/combos/vip-state.server";
import { kioskPovCodesEnabled } from "~/features/kiosk/flags";
import type { BookingSession, RaceItem } from "../state/types";
import type { ContactInfo } from "../types";

// Internal-route base — same constant the cron jobs use for server→internal
// calls. The `|| "https://fasttraxent.com"` fallback is what makes it prod-safe
// when NEXT_PUBLIC_SITE_URL is unset (the party-lead outage lesson).
const NOTIFY_BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://fasttraxent.com";

// Pandora direct (mirrors unified-reserve's inline state call + party-lead).
const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
// RACING lives at the FastTrax center, NOT the HeadPinz FM square id the
// `/api/pandora/schedule` route defaults to. Assign racers to the racing center.
const FASTTRAX_RACING_LOCATION_ID = "LAB52GY480CJF";

// The BMI→Pandora reservation sync lags the confirm by a few seconds; the web
// waits 8s before its schedule POST for the same reason. We mirror that here so
// the session assignment doesn't 404 on a not-yet-synced reservation. Because
// this rail is awaited by reserve, it is the LAST action (notification/memo/
// state all land first, none of them depend on Pandora reservation sync).
const PANDORA_SYNC_DELAY_MS = 8_000;

/** One racer→heat assignment for POST /bmi/schedule. The endpoint VALIDATES and
 *  REQUIRES tier, category, and heatStop (all strings) — omitting them 400s with
 *  "expected string, received undefined" (proven live 2026-07-19; the web's
 *  minimal shape in checkout.ts is silently broken the same way). */
interface KioskRacer {
  racerName: string;
  personId: string | null;
  product: string;
  productId: string | null;
  tier: string;
  track: "Red" | "Blue" | "Mega" | null;
  category: string;
  heatName: string;
  heatStart: string | null;
  heatStop: string | null;
}

/** FastTrax race heat length — matches the /bmi/schedule doc example (16:00→16:07)
 *  and the live-verified insert; used to derive heatStop from the block start. */
const HEAT_DURATION_MIN = 7;

/** Add minutes to a NAIVE center-local ISO ("YYYY-MM-DDThh:mm:ss") without a
 *  timezone shift (parse as UTC, add, reformat naive) so it round-trips on a
 *  UTC serverless host. */
function addMinutesNaive(iso: string, min: number): string {
  const d = new Date(iso.endsWith("Z") ? iso : `${iso}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + min);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export interface KioskPostReserveArgs {
  /** Pre-built racer rows (see buildKioskRacers / buildKioskRacersFromHeats) so
   *  BOTH reserve rails (unified reserve-all AND the race v2/reserve credit path)
   *  share this ONE flow. */
  racers: KioskRacer[];
  contact: ContactInfo;
  /** Raw BMI bill/order id (17-digit string — never Number() it). */
  bmiBillId: string;
  /** From confirmBmiPayment. */
  bmiReservationNumber: string;
  bmiReservationCode: string | null;
  /** BMI Office project id (bill id + 1) — computed ONCE by the caller and passed
   *  in so this rail and the state flip target the same project. */
  officeProjectId: string;
  /** session.center ?? "fort-myers" — resolved once by the caller. */
  centerCode: string;
  /** Notification location key ("fort-myers" | "naples"). */
  location: string;
  /** Any brand-new racer in the party → drives the notification's isNewRacer. */
  isNewRacer: boolean;
  /** POV cameras purchased on this bill (computeRaceItemPovQty across race
   *  items). 0/omitted → no POV on the booking, no claim. The credit path
   *  (v2/reserve) omits it — credit redemptions carry no POV. */
  povQty?: number;
  /** POV codes already claimed inline by unified-reserve. When povQty > 0 and
   *  this is empty (inline claim failed), the rail retries the claim itself —
   *  it's idempotent per billId, so no double-issue. */
  povCodes?: string[];
  /** `session.comboSpecialId` — set when the kiosk sold an Ultimate VIP
   *  Experience. Redirects §4's confirmation-state write from the kiosk id to
   *  "Confirmation - VIP" (owner 2026-08-02: VIP wins over kiosk). */
  comboSpecialId?: string | null;
  /** Tier-expectation warnings the guest ticked through and booked past
   *  (`raceWarningAckIds` across the race items — race-warnings.ts). Adds the
   *  staff note to §3's composed memo so a kiosk booking carries the same trail
   *  a web one does. Empty/omitted when nothing was acknowledged; the memo must
   *  never claim an acknowledgment that did not happen. */
  acknowledgedWarningIds?: string[];
}

/**
 * Build racer→heat rows from the live session (unified reserve-all path),
 * matching the web's racerAssignments shape. Exported so callers build the racers
 * and hand them to runKioskPostReserve (the ONE shared post-reserve flow).
 */
export function buildKioskRacers(session: BookingSession, raceItems: RaceItem[]): KioskRacer[] {
  return raceItems.flatMap((r) =>
    r.heats
      .filter((h) => h.assignedTo && h.heatId)
      .map((h) => {
        const member = session.party.find((m) => m.id === h.assignedTo);
        const product = h.productId ? getRaceProductById(h.productId) : null;
        const heatStart = h.heatId as string; // heatId IS the block start ISO (filtered non-null)
        return {
          racerName: member?.lastName
            ? `${member.firstName} ${member.lastName}`
            : (member?.firstName ?? "Unknown"),
          // Prefer the SHORT Pandora id — the schedule endpoint rejects the
          // 17-digit Office id (W52109's 500s, 2026-07-18). Raw strings only.
          personId: member?.pandoraPersonId ?? member?.bmiPersonId ?? null,
          product: product?.name ?? "Race",
          productId: h.productId,
          // REQUIRED by /bmi/schedule (omitting → 400). tier/category from the
          // product; category prefers the member's bucket.
          tier: product?.tier ?? "starter",
          track: h.track,
          category: member?.category ?? product?.category ?? "adult",
          heatName: product?.name ?? "Race",
          heatStart,
          heatStop: addMinutesNaive(heatStart, HEAT_DURATION_MIN),
        };
      }),
  );
}

/**
 * Build racer→heat rows from the race v2/reserve route's `bookingMetadata.heats`
 * (raceHeatsMetadata shape: bmiPersonId, racer, heatId, track, tier, category,
 * productId). The credit path (v2/reserve) has no session object, so it hands us
 * these instead. Same output shape as buildKioskRacers.
 */
export function buildKioskRacersFromHeats(heats: Array<Record<string, unknown>>): KioskRacer[] {
  return heats
    .filter((h) => typeof h.bmiPersonId === "string" && typeof h.heatId === "string")
    .map((h) => {
      const productId = (h.productId as string) ?? null;
      const product = productId ? getRaceProductById(productId) : null;
      const heatStart = h.heatId as string;
      const track = (h.track as KioskRacer["track"]) ?? null;
      return {
        racerName: (h.racer as string) || "Racer",
        personId: (h.bmiPersonId as string) ?? null,
        product: product?.name ?? "Race",
        productId,
        tier: (h.tier as string) || product?.tier || "starter",
        track,
        category: (h.category as string) || product?.category || "adult",
        heatName: product?.name ?? "Race",
        heatStart,
        heatStop: addMinutesNaive(heatStart, HEAT_DURATION_MIN),
      };
    });
}

/**
 * Retry a flaky vendor action — the BMI Office / Pandora APIs intermittently
 * 500/503 for a beat (live 2026-07-18: W52076's memo append died on "Office
 * auth failed: 500" and its session assignment on a 503, one minute after
 * W52073's identical calls succeeded). Single-attempt calls made those
 * one-in-a-while hiccups permanent gaps; a couple of spaced retries make the
 * rail land. Throws only when EVERY attempt failed (callers keep their
 * never-throw try/catch).
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(
        `[kiosk-post] ${label} attempt ${i}/${attempts} failed:`,
        err instanceof Error ? err.message : err,
      );
      if (i < attempts) await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}

export async function runKioskPostReserve(args: KioskPostReserveArgs): Promise<void> {
  const {
    racers,
    contact,
    bmiBillId,
    bmiReservationNumber,
    bmiReservationCode,
    officeProjectId,
    centerCode,
    location,
    isNewRacer,
    povQty = 0,
  } = args;

  // ── 0. POV codes (belt-and-braces re-claim) ────────────────────────
  // unified-reserve claims inline so the confirmation screen gets the codes;
  // if that claim failed (network blip), retry here — the claim is idempotent
  // per billId, so this can only recover the SAME codes, never issue extras.
  // Runs BEFORE the notification/memo so codes ride both.
  let povCodes: string[] = args.povCodes ?? [];
  if (povQty > 0 && povCodes.length === 0 && kioskPovCodesEnabled()) {
    try {
      const claim = await withRetry("pov claim", async () => {
        const r = await fetch(
          `${NOTIFY_BASE}/api/pov-codes?action=claim&qty=${povQty}&billId=${bmiBillId}&email=${encodeURIComponent(contact.email ?? "")}`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (!r.ok) throw new Error(`pov claim ${r.status}`);
        return (await r.json()) as { codes?: string[] };
      });
      povCodes = Array.isArray(claim.codes) ? claim.codes : [];
    } catch (err) {
      console.error("[kiosk-post] POV claim failed (non-fatal):", err);
    }
  }
  if (povQty > 0 && povCodes.length < povQty) {
    console.error(
      `[kiosk-post] POV SHORT bill=${bmiBillId} wanted=${povQty} issued=${povCodes.length}`,
    );
  }

  // ── 1. Guest confirmation SMS + email ──────────────────────────────
  // Reuse the full notification pipeline. Idempotent (Redis notif: dedup keyed
  // on billId), so a later confirmation-page call — if the kiosk ever renders
  // one — is a safe no-op.
  try {
    // Group heats into scheduled lines (one per heat block) so the route's
    // participantCount math sees the real racer count per line, not 1-per-row.
    const scheduledGroups = new Map<string, { name: string; start: string; persons: number }>();
    for (const r of racers) {
      if (!r.heatStart) continue;
      const key = `${r.heatName}|${r.heatStart}`;
      const g = scheduledGroups.get(key) ?? {
        name: r.heatName || r.product,
        start: r.heatStart,
        persons: 0,
      };
      g.persons += 1;
      scheduledGroups.set(key, g);
    }
    const scheduledItems = [...scheduledGroups.values()].map((g) => ({
      name: g.name,
      start: g.start,
      persons: g.persons,
      quantity: g.persons,
    }));
    const productNames = [...new Set(racers.map((r) => r.product))];

    const res = await fetch(`${NOTIFY_BASE}/api/notifications/booking-confirmation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // kioskMode → the route sends the lightweight kiosk confirmation (no QR,
        // no desk check-in; "e-ticket coming"), not the full web template.
        kioskMode: true,
        email: contact.email,
        phone: contact.phone,
        firstName: contact.firstName,
        // Default the confirmation TEXT on for kiosk: it's transactional (the
        // guest handed us their mobile at the kiosk to get this booking), and the
        // kiosk contact never sets smsOptIn, so leaving it undefined silently
        // skipped the SMS (W51654 got the email, no text).
        smsOptIn: contact.smsOptIn ?? true,
        reservationNumber: bmiReservationNumber,
        reservationCode: bmiReservationCode ?? `r${bmiBillId}`,
        billId: bmiBillId,
        brand: "fasttrax",
        location,
        productNames,
        scheduledItems,
        isNewRacer,
        // POV codes ride the kiosk email (codes block) + SMS pointer clause,
        // and fix sales_log povPurchased/povQty for kiosk POV sales.
        ...(povCodes.length > 0 ? { povCodes } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    console.log(
      `[kiosk-post] guest confirmation notify for ${bmiReservationNumber}: ${res.ok ? "OK" : res.status}`,
    );
  } catch (err) {
    console.error("[kiosk-post] guest confirmation notify failed (non-fatal):", err);
  }

  // ── 3. Append booking memo line ────────────────────────────────────
  // Rolling read-merge-write private note with the verified booking/memo
  // escalation for CONVERTED racing reservations (bmi-office-actions).
  // ONE composed append (never a second appendProjectPrivateNote call — each
  // is up to 3 read-merge-write-verify round trips and the rail runs under
  // reserve-all's duration budget): the kiosk line + the POV line in the
  // exact web format (buildReservationMemo, single-sourced) + an OWED line
  // when the pool came up short so staff can backfill from the reservation
  // (a kiosk guest has no confirmation page to revisit).
  try {
    const povLine = buildReservationMemo({ povCodes });
    const povOwedLine =
      povQty > 0 && povCodes.length < povQty
        ? `POV CODES OWED — pool short: issued ${povCodes.length} of ${povQty}. Import codes and backfill bill ${bmiBillId}.`
        : "";
    // Same staff note the web flows write, from the same registry — a parent
    // who booked Junior Starter at the kiosk after being warned must leave the
    // same trail as one who booked it online.
    const warningLines = (args.acknowledgedWarningIds ?? [])
      .map((wid) => raceWarningMemo(wid))
      .filter((m): m is string => !!m);
    const note = ["Kiosk Booking, please check into session", povLine, ...warningLines, povOwedLine]
      .filter(Boolean)
      .join("\n");
    const ok = await withRetry("booking memo append", () =>
      appendProjectPrivateNote({
        centerCode,
        projectId: officeProjectId,
        note,
        billId: bmiBillId,
      }),
    );
    console.log(
      `[kiosk-post] booking memo append for project ${officeProjectId}: ${ok ? "OK" : "not-visible"}`,
    );
  } catch (err) {
    console.error("[kiosk-post] booking memo append failed (non-fatal):", err);
  }

  // ── 2. Pandora race-SESSION assignment ─────────────────────────────
  // Assign the racers carrying a personId to the confirmed reservation's
  // session. Runs LAST + after a sync delay because it's the only action that
  // depends on Pandora having ingested the reservation from BMI (see
  // PANDORA_SYNC_DELAY_MS).
  //
  // W52504 lesson (2026-07-19): the vendor endpoint SKIPS (warn, not fail) any
  // racer whose project-person row hasn't cloud→local synced to the center's
  // BMI server yet, and used to report only a bare `inserted` count — a
  // 2-racer booking came back "success, inserted 1" and the second racer was
  // silently never checked into the session. So: track exactly who got linked
  // (per-racer `results`, Pandora_API ≥2.4.57), re-POST ONLY the still-missing
  // racers (the endpoint is idempotent per racer on those versions), and if
  // anyone is STILL unlinked, escalate into the reservation's memo — the
  // surface staff already work from.
  try {
    const assignable = racers.filter((r) => r.personId && r.heatStart);
    // No person id at all (brand-new racer whose Pandora person never
    // materialized) — can never auto-link; goes straight on the memo.
    const unlinked: KioskRacer[] = racers.filter((r) => !r.personId || !r.heatStart);
    // Pre-`results` API responses carry only a count — shortfall size is known
    // but not WHO, so no targeted re-POST and the memo names a count instead.
    let countOnlyShortfall = 0;

    if (assignable.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, PANDORA_SYNC_DELAY_MS));
      const pandoraKey = process.env.SWAGGER_ADMIN_KEY || "";
      const rKey = (r: { personId?: string | null; heatStart?: string | null }) =>
        `${r.personId}|${r.heatStart}`;
      // A non-OK response THROWS inside withRetry so a transient Pandora 503
      // (live 2026-07-18, W52076) gets retried instead of logged-and-lost.
      const postSchedule = async (batch: KioskRacer[]) => {
        const res = await fetch(
          `${PANDORA_BASE}/bmi/schedule/${FASTTRAX_RACING_LOCATION_ID}/${bmiReservationNumber}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${pandoraKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ racers: batch }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        const data = (await res.json().catch(() => null)) as {
          success?: boolean;
          data?: {
            inserted?: number;
            results?: Array<{ personId?: string; heatStart?: string; status?: string }>;
          };
        } | null;
        if (!res.ok || !data?.success) {
          throw new Error(
            `schedule POST ${res.status}${data?.success === false ? " (success=false)" : ""}`,
          );
        }
        return data.data ?? {};
      };
      const linked = new Set<string>();
      /** Fold a response into `linked`; true when per-racer detail came back. */
      const applyResults = (
        batch: KioskRacer[],
        d: { inserted?: number; results?: Array<{ status?: string } & Record<string, unknown>> },
      ) => {
        if (Array.isArray(d.results)) {
          for (const row of d.results) {
            if (row.status === "inserted" || row.status === "already_linked") {
              linked.add(rKey(row as { personId?: string; heatStart?: string }));
            }
          }
          return true;
        }
        if ((d.inserted ?? 0) >= batch.length) for (const r of batch) linked.add(rKey(r));
        return false;
      };

      let hasDetail = false;
      let firstInserted: number | null = null;
      let missing = assignable;
      try {
        const first = await withRetry("session assignment", () => postSchedule(assignable));
        firstInserted = first.inserted ?? 0;
        hasDetail = applyResults(assignable, first);
        missing = assignable.filter((r) => !linked.has(rKey(r)));
      } catch (err) {
        console.error("[kiosk-post] session assignment failed:", err);
      }

      // Targeted re-POSTs for stragglers — their project-person row usually just
      // needs more sync time. Only when the API named them: re-POSTing blind on
      // a count-only response could double-link the racers that DID make it.
      if (missing.length > 0 && hasDetail) {
        for (const backoffMs of [10_000, 20_000]) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          try {
            applyResults(missing, await postSchedule(missing));
          } catch (err) {
            console.error(
              "[kiosk-post] session assignment re-POST failed:",
              err instanceof Error ? err.message : err,
            );
          }
          missing = assignable.filter((r) => !linked.has(rKey(r)));
          if (missing.length === 0) break;
        }
      }

      if (hasDetail) unlinked.push(...missing);
      else if (firstInserted != null) {
        countOnlyShortfall = Math.max(0, assignable.length - firstInserted);
      } else countOnlyShortfall = assignable.length;
      console.log(
        `[kiosk-post] session assignment ${bmiReservationNumber}: ${assignable.length - missing.length}/${assignable.length} racers linked`,
      );
    } else {
      console.log(
        `[kiosk-post] no assignable racers with personId — skipping session assignment for ${bmiReservationNumber}`,
      );
    }

    if (unlinked.length > 0 || countOnlyShortfall > 0) {
      const who =
        unlinked.length > 0
          ? [...new Set(unlinked.map((r) => r.racerName))].join(", ")
          : `${countOnlyShortfall} racer(s)`;
      console.error(
        `[kiosk-post] session assignment INCOMPLETE for ${bmiReservationNumber} — not checked into session: ${who}`,
      );
      try {
        await withRetry("assignment-incomplete memo", () =>
          appendProjectPrivateNote({
            centerCode,
            projectId: officeProjectId,
            note: `AUTO CHECK-IN INCOMPLETE — please check into session: ${who}`,
            billId: bmiBillId,
          }),
        );
      } catch (err) {
        console.error("[kiosk-post] assignment-incomplete memo failed (non-fatal):", err);
      }
    }
  } catch (err) {
    console.error("[kiosk-post] session assignment failed (non-fatal):", err);
  }

  // ── 4. BMI Office confirmation state (LAST) ─────────────────────────
  // Runs DEAD LAST — after the notification, memo, and the Pandora session
  // assignment — because the confirmation state is the write that must WIN.
  // The reserve flow set the project to `-3 Confirmation` via PANDORA before
  // this rail started; that Pandora write returns 200 but propagates to Firebird
  // ASYNCHRONOUSLY and, when it landed after this Office PUT, reverted ~80% of
  // kiosk bookings back to plain Confirmation (live 2026-07-22). Two defenses:
  // (1) run last so the `-3` has ~15s+ to propagate first, and (2) ensureAttempts
  // re-reads + re-asserts across a further window so any residual late-lander is
  // corrected. State ids are PER LOCATION (FM 55397028 / Naples 8489113).
  //
  // An Ultimate VIP Experience sold at the kiosk lands in "Confirmation - VIP"
  // INSTEAD (owner 2026-08-02: VIP wins over kiosk wherever they collide). This
  // is the same single write with a different id, so the propagation defenses
  // above cover it identically — never add a second write here.
  if (isVipComboBooking(args.comboSpecialId)) {
    const result = await stampVipStateIfCombo({
      comboSpecialId: args.comboSpecialId,
      centerCode,
      officeProjectId,
      tag: "kiosk-post",
      label: "Confirmation - VIP (kiosk booking)",
    });
    // A VIP row that fell to "left-alone"/"failed" would otherwise sit in plain
    // -3 with no kiosk marker either. Fall through to the kiosk id so the
    // reservation still carries a skip-the-desk state rather than nothing.
    if (result.outcome === "stamped" || result.outcome === "already") return;
    console.warn(
      `[kiosk-post] VIP state not applied (${result.outcome}) for project ${officeProjectId} — falling back to the kiosk state`,
    );
  }

  const kioskStateId =
    KIOSK_CONFIRMATION_STATE_IDS[centerCode] ?? KIOSK_CONFIRMATION_STATE_IDS["fort-myers"];
  try {
    await withRetry(`office state ${kioskStateId}`, () =>
      setProjectState({
        centerCode,
        projectId: officeProjectId,
        stateId: kioskStateId,
        label: "Kiosk confirmation",
        ensureAttempts: 3,
        ensureGapMs: 4000,
      }),
    );
    console.log(`[kiosk-post] office state ${kioskStateId} set for project ${officeProjectId}`);
  } catch (err) {
    console.error(`[kiosk-post] office state ${kioskStateId} failed (non-fatal):`, err);
  }
}
