/**
 * Server-side BMI race-account reads for the customer dashboard.
 *
 * The lookup LOGIC (search → dedupe → detail → credits) is shared with booking's
 * returning-racer flow in lib/bmi-racer-lookup.ts — this file only provides the
 * SERVER transport (direct officeGet, no internal HTTP hop) and a per-session
 * Redis cache. These SMS-Timing ids (localId, p.id) are small local ids, not the
 * 17-digit Pandora ids, but we still parse with parseWithRawIds (it only quotes
 * unquoted big integers, harmless here) to honor the BMI precision rule.
 */
import { createHash } from "crypto";
import { parseWithRawIds } from "@ft/db";
import { officeGet, BMI_CLIENT_KEY } from "@/lib/bmi-office-client";
import {
  findRacerAccounts,
  type RacerAccount,
  type RacerLookupTransport,
} from "@/lib/bmi-racer-lookup";
import redis from "@/lib/redis";

const ACCOUNTS_CACHE_TTL_SEC = 900; // ~ account session idle window

export type { RacerAccount } from "@/lib/bmi-racer-lookup";

async function officeJson<T = unknown>(path: string): Promise<T> {
  const res = await officeGet(path);
  if (res.status >= 400) throw new Error(`Office ${path.split("?")[0]} failed: ${res.status}`);
  return parseWithRawIds<T>(res.body);
}

/** Server transport: hits the Office API directly (no /api/bmi-office hop). */
const serverTransport: RacerLookupTransport = {
  search: (token, max) =>
    officeJson(
      `/api/${BMI_CLIENT_KEY}/search/person?token=${encodeURIComponent(token)}&maxResults=${max}`,
    ),
  getPerson: (localId) => officeJson(`/api/${BMI_CLIENT_KEY}/person/${localId}`),
  getDeposits: (personId) => {
    const now = new Date();
    const from = new Date(now.getFullYear() - 2, now.getMonth(), now.getDate())
      .toISOString()
      .split(".")[0];
    const until = now.toISOString().split(".")[0];
    return officeJson(
      `/api/${BMI_CLIENT_KEY}/deposit/history?personId=${personId}&from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`,
    );
  },
};

/**
 * All racer accounts on a verified phone (one phone → potentially several family
 * members), resolved + cached for the session window. Empty array = no racer
 * found. Throws only on a hard Office failure (dashboard maps that to
 * "unavailable").
 */
export async function getRacerAccounts(contact: string, e164: string): Promise<RacerAccount[]> {
  const digits = e164.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return [];

  const key = `acct:racers:${createHash("sha256").update(contact).digest("hex").slice(0, 32)}`;
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as RacerAccount[];
  } catch {
    /* cache miss / redis hiccup → resolve live */
  }

  const accounts = await findRacerAccounts(digits, serverTransport);
  if (accounts.length > 0) {
    try {
      await redis.set(key, JSON.stringify(accounts), "EX", ACCOUNTS_CACHE_TTL_SEC);
    } catch {
      /* best-effort cache */
    }
  }
  return accounts;
}
