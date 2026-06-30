/**
 * Canonical "phone/email/code → racer account(s)" lookup against the BMI Office
 * API. ONE implementation, shared by:
 *   - booking's returning-racer flow (client; transport = fetch /api/bmi-office)
 *   - the customer account dashboard (server; transport = officeGet)
 *
 * Only the TRANSPORT differs between the two, so it's injected. All the
 * incident-hardened logic lives here once:
 *   - max=500 search (a frequent racer's real profile sits behind per-bill
 *     contact-person STUBS — Eric Osborn's was at index 227),
 *   - dedupe-by-name keeping the highest-SCORED record (stubs collide on name
 *     with the primary record and would otherwise win, being earlier),
 *   - require a check-in tag (loginCode) so stubs are dropped,
 *   - credit/pass deposit balances.
 *
 * Returns the RICH account shape; each caller maps it to its own view.
 */
import { isRelevantMembership } from "@/app/book/race/data";

export interface RacerSearchRow {
  localId?: string | number;
  description?: string;
}
export interface RacerPersonRaw {
  id?: string | number;
  firstName?: string;
  name?: string;
  lastLineUp?: string;
  birthDate?: string | null;
  tags?: { tag?: string; lastSeen?: string }[];
  memberships?: { name?: string; stops?: string }[];
  addresses?: { email?: string }[];
}
export interface RacerDeposit {
  depositKind?: string;
  balance?: number;
}

export interface RacerCredit {
  kind: string;
  balance: number;
}
export interface RacerAccount {
  /** SMS-Timing local person id (String(p.id)) — small, not a 17-digit Pandora id. */
  personId: string;
  fullName: string;
  email: string;
  /** Most recent check-in tag — the racer's login code. Always present (gated). */
  loginCode: string;
  /** Raw lastLineUp ISO (most recent race), or null. Callers format for display. */
  lastSeen: string | null;
  /** Count of check-in tags ≈ lifetime races. */
  races: number;
  memberships: string[];
  birthDate: string | null;
  credits: RacerCredit[];
}

/**
 * Injected transport. Each method returns the PARSED office payload (the caller's
 * transport owns precision-safe parsing). Deposit date-range defaulting is the
 * transport's concern (the booking /api/bmi-office route defaults it server-side;
 * the dashboard transport computes it before calling officeGet).
 */
export interface RacerLookupTransport {
  search(token: string, max: number): Promise<unknown>;
  getPerson(localId: string): Promise<unknown>;
  getDeposits(personId: string): Promise<unknown>;
}

/** Higher score = more likely the racer's PRIMARY record (vs a per-bill stub). */
export function scoreSearchResult(desc: string): number {
  let s = 0;
  if (/\(\d/.test(desc)) s += 100; // birthdate paren — strong primary signal
  if (desc.includes("Memberships:")) s += 50;
  if (desc.includes("zip:")) s += 25;
  if (desc.includes("Last seen:")) s += 10;
  return s;
}

export function racerNameFromDescription(desc: string): string {
  const m = desc.match(/^([^(]+?)(?:\s*\(|$|\s+phone:|\s+Last seen:)/);
  return m ? m[1].trim() : desc.split(" phone:")[0].trim();
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

async function buildAccount(
  localId: string,
  transport: RacerLookupTransport,
): Promise<RacerAccount | null> {
  const p = (await transport.getPerson(localId)) as RacerPersonRaw;
  const tags = (p.tags ?? [])
    .slice()
    .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""));
  const loginCode = tags[0]?.tag ?? "";
  if (!loginCode) return null; // contact-person stub, not a real racer

  const personId = str(p.id);
  if (!/^\d+$/.test(personId)) return null;

  const memberships = [
    ...new Set(
      (p.memberships ?? [])
        .filter(
          (m) => (!m.stops || new Date(m.stops) > new Date()) && isRelevantMembership(str(m.name)),
        )
        .map((m) => str(m.name))
        .filter(Boolean),
    ),
  ];

  let credits: RacerCredit[] = [];
  try {
    const deposits = (await transport.getDeposits(personId)) as RacerDeposit[];
    if (Array.isArray(deposits)) {
      credits = deposits
        .filter((d) => (d.balance ?? 0) > 0 && /credit|pass/i.test(str(d.depositKind)))
        .map((d) => ({ kind: str(d.depositKind) || "Credit", balance: d.balance ?? 0 }));
    }
  } catch {
    /* credits are best-effort */
  }

  return {
    personId,
    fullName: `${str(p.firstName)} ${str(p.name)}`.trim(),
    email: p.addresses?.[0]?.email ?? "",
    loginCode,
    lastSeen: p.lastLineUp ?? null,
    races: tags.length,
    memberships,
    birthDate: p.birthDate ?? null,
    credits,
  };
}

/**
 * Resolve all racer accounts matching a search token (phone digits, email, or
 * login code). Dedupes to the top distinct names, fetches each detail + credits,
 * keeps only real racers (with a login code), and sorts memberships-first then
 * most-recently-seen. Throws only if the initial search transport throws.
 */
export async function findRacerAccounts(
  token: string,
  transport: RacerLookupTransport,
  opts: { max?: number; maxDetails?: number; limit?: number } = {},
): Promise<RacerAccount[]> {
  const { max = 500, maxDetails = 10, limit = 5 } = opts;
  const results = (await transport.search(token, max)) as RacerSearchRow[];
  if (!Array.isArray(results) || results.length === 0) return [];

  const byName = new Map<string, { localId: string; score: number }>();
  for (const r of results) {
    if (r?.localId == null || typeof r.description !== "string") continue;
    const name = racerNameFromDescription(r.description);
    const score = scoreSearchResult(r.description);
    const existing = byName.get(name);
    if (!existing || score > existing.score) {
      byName.set(name, { localId: str(r.localId), score });
    }
  }

  const unique = [...byName.values()].slice(0, maxDetails);
  const settled = await Promise.allSettled(unique.map((u) => buildAccount(u.localId, transport)));
  const accounts = settled
    .map((s) => (s.status === "fulfilled" ? s.value : null))
    .filter((a): a is RacerAccount => a !== null);

  accounts.sort((a, b) => {
    if (a.memberships.length !== b.memberships.length)
      return b.memberships.length - a.memberships.length;
    return (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "");
  });
  return accounts.slice(0, limit);
}
