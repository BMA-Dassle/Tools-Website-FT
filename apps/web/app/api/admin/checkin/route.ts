import { NextRequest, NextResponse } from "next/server";
import redis from "@/lib/redis";
import { parseCheckinQr } from "@/lib/qr-checkin";
import {
  getDepositOverview,
  addDeposit,
  DEPOSIT_KIND,
  type DepositOverviewRow,
} from "@/lib/pandora-deposits";
import { enqueueDepositFailure } from "@/lib/bmi-deposit-retry";

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net";
const FASTTRAX_LOCATION_ID = "LAB52GY480CJF";
const HEADSOCK_DEPOSIT_KIND_ID = DEPOSIT_KIND.HEADSOCK;

function pandoraHeaders(): HeadersInit {
  const key = process.env.SWAGGER_ADMIN_KEY || "";
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

interface Participant {
  personId: string | number;
  firstName: string;
  lastName: string;
  email?: string | null;
  viewpointCredit?: number | null;
}

function auth(req: NextRequest): boolean {
  const token = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-admin-token") ?? "";
  const expected = process.env.ADMIN_CAMERA_TOKEN || "";
  return !!expected && token === expected;
}

async function lookupGuest(
  sessionId: string,
  personId: string,
): Promise<{
  participant: Participant | null;
  track: string | null;
  raceType: string | null;
  heatNumber: number | null;
}> {
  const cacheKey = `pandora:participants:${FASTTRAX_LOCATION_ID}:${sessionId}:R1`;
  const cached = await redis.get(cacheKey);
  if (!cached) return { participant: null, track: null, raceType: null, heatNumber: null };

  let participants: Participant[];
  try {
    participants = JSON.parse(cached) as Participant[];
  } catch {
    return { participant: null, track: null, raceType: null, heatNumber: null };
  }

  const match = participants.find((p) => String(p.personId) === personId);

  // Track/raceType/heatNumber aren't on the participant object — we get them
  // from the races-current response in the caller. Return null here; the
  // caller will fill them from races-current or the session metadata.
  return {
    participant: match ?? null,
    track: null,
    raceType: null,
    heatNumber: null,
  };
}

interface CurrentRaces {
  blue?: {
    sessionId?: number | string;
    trackName?: string;
    raceType?: string;
    heatNumber?: number;
    scheduledStart?: string;
  } | null;
  red?: {
    sessionId?: number | string;
    trackName?: string;
    raceType?: string;
    heatNumber?: number;
    scheduledStart?: string;
  } | null;
  mega?: {
    sessionId?: number | string;
    trackName?: string;
    raceType?: string;
    heatNumber?: number;
    scheduledStart?: string;
  } | null;
}

async function fetchCurrentRaces(req: NextRequest): Promise<CurrentRaces> {
  try {
    // Use the internal cached route (Redis, ~5-20ms) instead of hitting
    // Pandora live (1-5s). The cron warms Redis every minute.
    const origin = req.nextUrl.origin;
    const res = await fetch(`${origin}/api/pandora/races-current?cacheOnly=1`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return {};
    return (await res.json()) as CurrentRaces;
  } catch {
    return {};
  }
}

function findSessionInCurrent(
  current: CurrentRaces,
  sessionId: string,
): {
  track: string;
  raceType: string;
  heatNumber: number;
  scheduledStart: string;
  checkingIn: true;
} | null {
  for (const [track, data] of Object.entries(current)) {
    if (!data) continue;
    if (String(data.sessionId ?? "") === sessionId) {
      return {
        track,
        raceType: data.raceType ?? "",
        heatNumber: data.heatNumber ?? 0,
        scheduledStart: data.scheduledStart ?? "",
        checkingIn: true,
      };
    }
  }
  return null;
}

export function findHeadsockCredit(
  deposits: DepositOverviewRow[],
): { depositKindId: string; balance: number } | null {
  if (!HEADSOCK_DEPOSIT_KIND_ID) return null;
  const row = deposits.find((d) => String(d.OUT_DPK_ID) === HEADSOCK_DEPOSIT_KIND_ID);
  if (!row || row.OUT_DPS_AMOUNT <= 0) return null;
  return { depositKindId: String(row.OUT_DPK_ID), balance: row.OUT_DPS_AMOUNT };
}

interface CheckInResult {
  success: boolean;
  error?: string;
  guest?: {
    firstName: string;
    lastName: string;
    pic: string | null;
  };
}

async function checkInViaPandora(personId: string, sessionId: string): Promise<CheckInResult> {
  try {
    const body = JSON.stringify({
      locationID: FASTTRAX_LOCATION_ID,
      personID: personId,
      sessionID: Number(sessionId),
      checkedIn: true,
    });
    const res = await fetch(`${PANDORA_BASE}/v2/bmi/checkin`, {
      method: "POST",
      headers: pandoraHeaders(),
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `Pandora ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = await res.json();
    return {
      success: true,
      guest: {
        firstName: data?.firstName ?? "",
        lastName: data?.lastName ?? "",
        pic: data?.pic ? `data:image/jpeg;base64,${data.pic}` : null,
      },
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

// --------------- POST: Check in a guest ---------------

export async function POST(req: NextRequest) {
  if (!auth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { personId?: string; sessionId?: string; raw?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  let personId = body.personId;
  let sessionId = body.sessionId;

  if (body.raw) {
    const parsed = parseCheckinQr(body.raw);
    if (!parsed) {
      return NextResponse.json(
        { error: "invalid QR", detail: "Could not parse barcode data" },
        { status: 400 },
      );
    }
    personId = parsed.personId;
    sessionId = parsed.sessionId;
  }

  if (!personId || !sessionId || !/^\d+$/.test(personId) || !/^\d+$/.test(sessionId)) {
    return NextResponse.json(
      { error: "invalid input", detail: "personId and sessionId must be digit strings" },
      { status: 400 },
    );
  }

  // Fast path: Redis guest lookup + cached races-current (both <20ms)
  const [guestResult, current] = await Promise.all([
    lookupGuest(sessionId, personId),
    fetchCurrentRaces(req),
  ]);

  const sessionMatch = findSessionInCurrent(current, sessionId);
  const currentlyCheckingIn = !!sessionMatch;

  const guest = guestResult.participant;
  const track = sessionMatch?.track ?? null;
  const raceType = sessionMatch?.raceType ?? null;
  const heatNumber = sessionMatch?.heatNumber ?? null;
  const scheduledStart = sessionMatch?.scheduledStart ?? null;

  // Headsock + Pandora check-in only when session IS currently checking in.
  // Yellow "are you sure?" scans should not deduct headsock or call check-in.
  let headsock: { detected: boolean; deducted: boolean; balance: number } = {
    detected: false,
    deducted: false,
    balance: 0,
  };
  if (currentlyCheckingIn) {
    if (HEADSOCK_DEPOSIT_KIND_ID) {
      try {
        const deposits = await getDepositOverview(personId, FASTTRAX_LOCATION_ID);
        const hs = findHeadsockCredit(deposits);
        if (hs) {
          headsock.detected = true;
          headsock.balance = hs.balance;
          addDeposit({
            personId,
            depositKindId: hs.depositKindId,
            amount: -1,
            locationId: FASTTRAX_LOCATION_ID,
          }).catch((e) => {
            enqueueDepositFailure({
              source: "headsock-checkin",
              sourceRef: `${personId}-${sessionId}`,
              locationId: FASTTRAX_LOCATION_ID,
              personId,
              depositKindId: hs.depositKindId,
              amount: -1,
              initialError: e instanceof Error ? e.message : "Unknown",
            }).catch(() => {});
          });
        }
      } catch {
        // Deposit read failed — don't block check-in
      }
    }

    // Await Pandora check-in — returns guest photo as base64
    const checkinResult = await checkInViaPandora(personId, sessionId);
    const checkinGuest = checkinResult.guest;

    const guestResponse = {
      firstName: checkinGuest?.firstName || guest?.firstName || "",
      lastName: checkinGuest?.lastName || guest?.lastName || "",
      pictureUrl: checkinGuest?.pic ?? null,
    };

    return NextResponse.json({
      success: checkinResult.success,
      guest: guestResponse,
      session: { track, raceType, heatNumber, scheduledStart },
      currentlyCheckingIn,
      headsock,
    });
  }

  // Session not checking in — no Pandora call, just return guest info from cache
  const guestResponse = guest
    ? {
        firstName: guest.firstName,
        lastName: guest.lastName,
        pictureUrl: null,
      }
    : null;

  return NextResponse.json({
    success: true,
    guest: guestResponse,
    session: {
      track,
      raceType,
      heatNumber,
      scheduledStart,
    },
    currentlyCheckingIn,
    headsock,
  });
}

// --------------- GET: Self-test suite ---------------

export async function GET(req: NextRequest) {
  if (!auth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const selftest = req.nextUrl.searchParams.get("selftest");
  if (selftest !== "1") {
    return NextResponse.json({ info: "POST to check in, GET ?selftest=1 to run tests" });
  }

  const tests: { name: string; pass: boolean; ms: number; detail?: string }[] = [];

  // 1. Redis connectivity
  {
    const start = Date.now();
    try {
      await redis.ping();
      tests.push({ name: "redis-connectivity", pass: true, ms: Date.now() - start });
    } catch (e) {
      tests.push({
        name: "redis-connectivity",
        pass: false,
        ms: Date.now() - start,
        detail: e instanceof Error ? e.message : "Unknown",
      });
    }
  }

  // 2. Races-current
  {
    const start = Date.now();
    try {
      const current = await fetchCurrentRaces(req);
      const tracks = Object.entries(current)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: sid ${v?.sessionId ?? "?"}`)
        .join(", ");
      tests.push({
        name: "races-current",
        pass: true,
        ms: Date.now() - start,
        detail: tracks || "No active sessions",
      });
    } catch (e) {
      tests.push({
        name: "races-current",
        pass: false,
        ms: Date.now() - start,
        detail: e instanceof Error ? e.message : "Unknown",
      });
    }
  }

  // 3. QR parse
  {
    const start = Date.now();
    const cases = [
      { input: "FT:12345:67890", expect: true },
      { input: "FT:63000000000021716:99887766", expect: true },
      { input: "NOTFT:123:456", expect: false },
      { input: "FT:123", expect: false },
      { input: "FT:abc:456", expect: false },
      { input: "", expect: false },
      { input: "0123456789012", expect: false },
    ];
    let passed = 0;
    for (const c of cases) {
      const result = parseCheckinQr(c.input);
      if ((result !== null) === c.expect) passed++;
    }
    tests.push({
      name: "qr-parse",
      pass: passed === cases.length,
      ms: Date.now() - start,
      detail: `${passed}/${cases.length} cases passed`,
    });
  }

  // 4. Headsock detection
  {
    const start = Date.now();
    const mockRows: DepositOverviewRow[] = [
      { OUT_DPK_ID: 12744867, OUT_DPK_NAME: "Credit - Race Weekday", OUT_DPS_AMOUNT: 3 },
    ];
    if (HEADSOCK_DEPOSIT_KIND_ID) {
      mockRows.push({
        OUT_DPK_ID: Number(HEADSOCK_DEPOSIT_KIND_ID),
        OUT_DPK_NAME: "Credit - Headsock",
        OUT_DPS_AMOUNT: 1,
      });
    }
    const found = findHeadsockCredit(mockRows);
    const noHeadsock = findHeadsockCredit([mockRows[0]]);
    const empty = findHeadsockCredit([]);
    const allPass =
      (HEADSOCK_DEPOSIT_KIND_ID ? found !== null && found.balance === 1 : found === null) &&
      noHeadsock === null &&
      empty === null;
    tests.push({
      name: "headsock-detect",
      pass: allPass,
      ms: Date.now() - start,
      detail: HEADSOCK_DEPOSIT_KIND_ID
        ? `HEADSOCK_DEPOSIT_KIND_ID=${HEADSOCK_DEPOSIT_KIND_ID}`
        : "HEADSOCK_DEPOSIT_KIND_ID not set — detection disabled",
    });
  }

  return NextResponse.json({
    tests,
    allPassed: tests.every((t) => t.pass),
  });
}
