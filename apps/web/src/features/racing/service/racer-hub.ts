/**
 * The racer hub — everything `/r/{code}` needs, resolved from a login code.
 *
 * NO REACT, NO `next/headers`, NO ROUTE COUPLING. A kiosk "view my account"
 * screen is coming and will consume exactly this; the web page is one of two
 * surfaces, not the owner of the logic.
 *
 * The code is the identity. Possession of a 13-char BMI tag is the same bar
 * `/v/{code}` and `/r/{code}/wallet` already apply — but callers MUST shape-check
 * with `RACER_PUBLIC_CODE_RE` first, not the scan regex: six-char tags are real
 * and look like counters, so a URL that accepts them is an enumerable racer
 * directory. See the note on that constant.
 */
import redis from "@/lib/redis";
import { lookupMemberMatches } from "~/features/kiosk/license/lookup.server";
import { findTicketIdFor } from "@/lib/race-tickets";
import { getRacerPass } from "~/features/racing/data/racer-wallet-db";
import { formatHeat, heatEpoch } from "~/features/racing/wallet/licence-meta";
import type { LicenseMatch } from "~/features/kiosk/license/types";

/** How long a resolved next race is reused. Short: a heat move should surface
 *  within a refresh or two, and this whole answer is cheap to rebuild. */
const NEXT_RACE_TTL_SECONDS = 60;

export interface RacerNextRace {
  sessionId: string;
  /** ISO, genuine UTC (Pandora's convention — never strip the Z). */
  scheduledStart: string | null;
  track: string | null;
  heatNumber: number | null;
  /** Preformatted, matching what the wallet pass shows so the two never differ. */
  label: string;
}

export interface RacerHub {
  personId: string;
  fullName: string;
  code: string;
  tier: string;
  races: number;
  /** The SMS-Timing authenticate URL — the shape BMI's own register scans. */
  memberQr: string;
  nextRace: RacerNextRace | null;
  /** Present only once a cron has minted the e-ticket (~2h out). */
  ticketId: string | null;
  holdsPass: boolean;
}

/** Highest qualification the racer holds — one tier is shown, not a list. */
function tierFrom(memberships: readonly string[] | undefined): string {
  for (const tier of ["Pro", "Intermediate", "Starter"]) {
    if (memberships?.some((n) => n.toLowerCase().includes(tier.toLowerCase()))) return tier;
  }
  return "";
}

interface BookingRacer {
  personId?: string | null;
  sessionId?: string | number | null;
  heatStart?: string | null;
  track?: string | null;
  heatName?: string | null;
  racerName?: string | null;
}

/**
 * The racer's next heat.
 *
 * NOT from `race/next/{loc}/person/{id}`. That endpoint answers the next
 * unstarted session EVER, and on 2026-08-05 it returned a 2023 Axe Lane booking
 * for one racer and a 2025 arena match for another. It looks authoritative and
 * is worse than nothing.
 *
 * Cheapest correct source first:
 *   1. the wallet pass row — the pre-race cron rewrites it every two minutes, so
 *      for a pass holder it is both current and already formatted, which means
 *      the hub and the pass in their hand cannot disagree;
 *   2. our own booking index — `bookingrecord:person:{id}` is an existing SET of
 *      their billIds, so this is one Redis read per booking and no vendor call.
 */
export async function nextRaceForPerson(personId: string): Promise<RacerNextRace | null> {
  const pid = String(personId ?? "").trim();
  if (!/^\d+$/.test(pid)) return null;

  const cacheKey = `racerhub:next:${pid}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return cached === "none" ? null : (JSON.parse(cached) as RacerNextRace);
  } catch {
    /* cache is an optimisation, never a dependency */
  }

  let out: RacerNextRace | null = null;

  // 1. Pass holder — cron-maintained, already correct.
  try {
    const pass = await getRacerPass(pid);
    const label = pass?.nextRace?.trim();
    if (label && !/^none\b/i.test(label)) {
      out = {
        sessionId: String(pass?.nextRaceSessionId ?? ""),
        scheduledStart: null,
        track: null,
        heatNumber: null,
        label,
      };
    }
  } catch {
    /* fall through */
  }

  // 2. Our booking records. Only heats still ahead of us — a booking from this
  //    morning is not "next".
  if (!out) {
    try {
      const billIds = await redis.smembers(`bookingrecord:person:${pid}`);
      const now = Date.now();
      let best: { start: number; racer: BookingRacer } | null = null;

      for (const billId of billIds.slice(0, 25)) {
        const raw = await redis.get(`bookingrecord:${billId}`);
        if (!raw) continue;
        let rec: { racers?: BookingRacer[] } | null = null;
        try {
          rec = JSON.parse(raw);
        } catch {
          continue;
        }
        for (const r of rec?.racers ?? []) {
          if (String(r?.personId ?? "").trim() !== pid) continue;
          // NOT `new Date()`: heatStart is centre-local with no zone marker, so
          // on Vercel (UTC) it resolves four hours off and can drop a heat that
          // has not happened yet.
          const start = heatEpoch(r?.heatStart);
          if (isNaN(start) || start < now - 20 * 60_000) continue;
          if (!best || start < best.start) best = { start, racer: r };
        }
      }

      if (best) {
        const r = best.racer;
        const heat = Number(String(r.heatName ?? "").replace(/\D+/g, ""));
        out = {
          sessionId: String(r.sessionId ?? ""),
          scheduledStart: r.heatStart ?? null,
          track: r.track ?? null,
          heatNumber: Number.isFinite(heat) && heat > 0 ? heat : null,
          label: formatHeatLabel(r.heatStart ?? null, r.track ?? null),
        };
      }
    } catch {
      /* no booking index → no next race, which is a legitimate answer */
    }
  }

  try {
    await redis.set(cacheKey, out ? JSON.stringify(out) : "none", "EX", NEXT_RACE_TTL_SECONDS);
  } catch {
    /* non-fatal */
  }
  return out;
}

/** "Aug 5 · 10:48 PM · Red", via the shared formatter.
 *
 *  Uses `formatHeat` rather than its own Intl call: a booking record's
 *  `heatStart` is centre-local with NO zone marker, and converting it through
 *  `new Date()` renders it four hours early on Vercel (UTC) while looking right
 *  on a developer laptop (ET). One formatter, one rule. */
function formatHeatLabel(iso: string | null, track: string | null): string {
  return formatHeat(iso ? { scheduledStart: iso, track: track ?? "" } : null).nextRace;
}

/**
 * Resolve everything the hub renders. Returns null when the code matches no
 * one, or several people — a code resolving to several records means we cannot
 * tell whose page this is, and guessing shows one racer another's schedule.
 */
export async function resolveRacerHub(code: string): Promise<RacerHub | null> {
  const clean = String(code ?? "").trim();
  if (!clean) return null;

  const matches = await lookupMemberMatches(clean).catch(() => null);
  if (!matches || matches.length !== 1) return null;
  const m: LicenseMatch = matches[0];

  const personId = String(m.personId ?? "").trim();
  if (!/^\d+$/.test(personId)) return null;

  const nextRace = await nextRaceForPerson(personId);
  const ticketId = nextRace?.sessionId
    ? await findTicketIdFor(nextRace.sessionId, personId)
    : null;
  const pass = await getRacerPass(personId).catch(() => null);

  const site = process.env.SMSTIM_SITE || "908";
  return {
    personId,
    fullName: m.fullName,
    code: clean,
    tier: tierFrom(m.memberships),
    races: Number(m.races ?? 0) || 0,
    memberQr: `https://smstim.in/${site}/authenticate/?login_code=${clean}`,
    nextRace,
    ticketId,
    holdsPass: !!pass,
  };
}
