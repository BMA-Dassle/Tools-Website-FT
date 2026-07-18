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
import { appendProjectPrivateNote, setProjectState } from "@/lib/bmi-office-actions";
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
  session: BookingSession;
  contact: ContactInfo;
  /** Raw BMI bill/order id (17-digit string — never Number() it). */
  bmiBillId: string;
  /** From confirmBmiPayment. */
  bmiReservationNumber: string;
  bmiReservationCode: string | null;
  /** BMI Office project id (bill id + 1) — computed ONCE in unified-reserve and
   *  passed in so this rail and the state flip target the same project. */
  officeProjectId: string;
  /** session.center ?? "fort-myers" — resolved once by the caller. */
  centerCode: string;
  raceItems: RaceItem[];
}

/**
 * Build the racer→heat assignment rows from the live session, replicating the
 * web's `racerAssignments` builder (checkout.ts) so the Pandora schedule
 * payload is identical in shape to what the browser sends.
 */
function buildRacers(session: BookingSession, raceItems: RaceItem[]): KioskRacer[] {
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
          // bmiPersonId is a raw digit string — pass through untouched.
          personId: member?.bmiPersonId ?? null,
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

export async function runKioskPostReserve(args: KioskPostReserveArgs): Promise<void> {
  const {
    session,
    contact,
    bmiBillId,
    bmiReservationNumber,
    bmiReservationCode,
    officeProjectId,
    centerCode,
    raceItems,
  } = args;

  const racers = buildRacers(session, raceItems);

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

    // Kiosk RACE booking: always the FastTrax brand at Fort Myers (racing has no
    // Naples location). Brand drives the email subject + SMS from-number.
    const location = session.center === "naples" ? "naples" : "fort-myers";
    const isNewRacer = session.party.some((m) => m.isNewRacer);

    const res = await fetch(`${NOTIFY_BASE}/api/notifications/booking-confirmation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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
  try {
    const ok = await appendProjectPrivateNote({
      centerCode,
      projectId: officeProjectId,
      note: "Kiosk Booking, please check into session",
      billId: bmiBillId,
    });
    console.log(
      `[kiosk-post] booking memo append for project ${officeProjectId}: ${ok ? "OK" : "not-visible"}`,
    );
  } catch (err) {
    console.error("[kiosk-post] booking memo append failed (non-fatal):", err);
  }

  // ── 4. BMI Office confirmation state → 55397028 ────────────────────
  // setProjectState tries Pandora first, falls back to the Office API (which is
  // the owner-intended landing spot if Pandora rejects the custom state id).
  try {
    await setProjectState({
      centerCode,
      projectId: officeProjectId,
      stateId: "55397028",
      label: "Kiosk confirmation",
    });
    console.log(`[kiosk-post] office state 55397028 set for project ${officeProjectId}`);
  } catch (err) {
    console.error("[kiosk-post] office state 55397028 failed (non-fatal):", err);
  }

  // ── 2. Pandora race-SESSION assignment ─────────────────────────────
  // Assign the RETURNING racers (those carrying a bmiPersonId) to the confirmed
  // reservation's session. New racers have no personId to key on and are
  // assigned when their Pandora person materializes. Runs LAST + after a sync
  // delay because it's the only action that depends on Pandora having ingested
  // the reservation from BMI (see PANDORA_SYNC_DELAY_MS).
  try {
    const returningRacers = racers.filter((r) => r.personId);
    if (returningRacers.length === 0) {
      console.log(
        `[kiosk-post] no returning racers with personId — skipping session assignment for ${bmiReservationNumber}`,
      );
    } else {
      await new Promise((resolve) => setTimeout(resolve, PANDORA_SYNC_DELAY_MS));
      const pandoraKey = process.env.SWAGGER_ADMIN_KEY || "";
      const res = await fetch(
        `${PANDORA_BASE}/bmi/schedule/${FASTTRAX_RACING_LOCATION_ID}/${bmiReservationNumber}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${pandoraKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ racers: returningRacers }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      const data = (await res.json().catch(() => null)) as {
        success?: boolean;
        data?: { inserted?: number };
      } | null;
      console.log(
        `[kiosk-post] session assignment ${bmiReservationNumber}: ${
          res.ok && data?.success
            ? `OK (${data?.data?.inserted ?? 0} racers)`
            : `FAIL ${res.status}`
        }`,
      );
    }
  } catch (err) {
    console.error("[kiosk-post] session assignment failed (non-fatal):", err);
  }
}
