import "server-only";

/**
 * Addressing for the race report — every door onto the same shape.
 *
 * The owner's requirement (2026-09-05) is that this data is reachable however
 * you arrive: from the live driver view at the flag, from a text or an email
 * sent afterwards, from `/racer`, from a kiosk. So the report is assembled once
 * in `report.ts` and this module is nothing but the ways in:
 *
 *   by SESSION      the full result board — every driver in the heat
 *   by SESSION+KART the personal report, which is the same board with one
 *                   driver's detail pulled out. NOT a different query.
 *   by PERSON       the list of heats they have raced, each a link to the above
 *
 * There is no separate "my report" query on purpose. A personal report that
 * loaded different rows from the board it links to would eventually disagree
 * with it, and the guest would be right to trust neither.
 */
import { readRaceLapResults } from "~/features/racing/data/race-lap-results-db";
import { buildReport, driverInReport, type RaceReport, type ReportDriver } from "./report";
import { trackForResource } from "./classify";
import { readPersonSessions, readSessionCrossings, readSessionEvents } from "./store.server";

/** The full board for one heat. Null when we have nothing at all on it. */
export async function readRaceReport(sessionId: string): Promise<RaceReport | null> {
  const [standings, crossings, events] = await Promise.all([
    readRaceLapResults(sessionId).catch(() => []),
    readSessionCrossings(sessionId),
    readSessionEvents(sessionId),
  ]);

  if (standings.length === 0 && crossings.length === 0) return null;

  const sessionName =
    standings.find((s) => s.heatName)?.heatName ??
    crossings.find((c) => c.sessionName)?.sessionName ??
    null;
  const resourceId = crossings.find((c) => c.resourceId)?.resourceId ?? null;

  return buildReport({
    sessionId,
    sessionName,
    track: trackForResource(resourceId),
    standings: standings.map((s) => ({
      name: s.driverName,
      kart: s.kart ?? "",
      bestMs: s.bestMs,
      laps: s.laps ?? 0,
      position: s.position ?? 0,
    })),
    crossings: crossings.map((c) => ({
      kart: c.kart,
      participantName: c.participantName,
      passingId: c.passingId,
      lapTimeMs: c.lapTimeMs,
      atUtc: c.atUtc,
    })),
    events,
  });
}

/** The same board, with one driver's line pulled out for the personal view. */
export async function readDriverReport(
  sessionId: string,
  kart: string,
): Promise<{ report: RaceReport; driver: ReportDriver | null } | null> {
  const report = await readRaceReport(sessionId);
  if (!report) return null;
  return { report, driver: driverInReport(report, kart) };
}

/** Every heat a racer has run, newest first — the `/racer` and kiosk door. */
export async function listRacerReports(
  personId: string,
  limit = 25,
): Promise<{ sessionId: string; sessionName: string | null; kart: string; atUtc: string }[]> {
  return readPersonSessions(personId, limit);
}
