import QRCode from "qrcode";

const PREFIX = "FT";
const HP_PREFIX = "HP";

/**
 * Build the check-in QR payload.
 *
 *   3-part (legacy):  FT:{personId}:{sessionId}
 *   4-part (current): FT:{personId}:{sessionId}:{participantId}
 *   HP (arena):       HP:{locationId}:{personId}:{sessionId}[:{participantId}]
 *
 * The optional participantId makes the QR move-resilient — the check-in
 * route resolves the racer's LIVE session from it at scan time, so a
 * ticket survives a heat move. Omitting it emits the legacy 3-part
 * string unchanged (back-compat for callers / tickets without one).
 *
 * The HP form carries an explicit Square locationId because arena
 * tickets aren't FastTrax-only: HP FM shares FastTrax's BMI server
 * (shared sessionId namespace) but Naples runs a separate BMI server,
 * so the scanner must know which location a session id belongs to.
 * Racing tickets keep emitting the FT form byte-identically.
 */
export function checkinQrPayload(
  personId: string | number,
  sessionId: string | number,
  participantId?: string | number | null,
  locationId?: string | null,
): string {
  const pid = String(personId);
  const sid = String(sessionId);
  if (!pid || !/^\d+$/.test(pid)) throw new Error("personId must be a non-empty digit string");
  if (!sid || !/^\d+$/.test(sid)) throw new Error("sessionId must be a non-empty digit string");
  const partId = participantId == null ? "" : String(participantId);
  if (partId && !/^\d+$/.test(partId)) throw new Error("participantId must be a digit string");
  const loc = locationId == null ? "" : String(locationId);
  if (loc) {
    // Square location ids are uppercase alphanumeric with at least one
    // letter (e.g. TXBSQN0FEKQ11) — the letter requirement keeps a
    // digits-only segment from ever being mistaken for a location.
    if (!/^(?=.*[A-Z])[A-Z0-9]+$/.test(loc))
      throw new Error("locationId must be uppercase alphanumeric");
    return partId
      ? `${HP_PREFIX}:${loc}:${pid}:${sid}:${partId}`
      : `${HP_PREFIX}:${loc}:${pid}:${sid}`;
  }
  if (partId) {
    return `${PREFIX}:${pid}:${sid}:${partId}`;
  }
  return `${PREFIX}:${pid}:${sid}`;
}

export async function checkinQrDataUrl(
  personId: string | number,
  sessionId: string | number,
  participantId?: string | number | null,
  width = 160,
  locationId?: string | null,
): Promise<string> {
  const payload = checkinQrPayload(personId, sessionId, participantId, locationId);
  return QRCode.toDataURL(payload, {
    width,
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

export interface ParsedCheckinQr {
  personId: string;
  sessionId: string;
  /** Present only for 4-part FT / 5-part HP QRs. Stable across a heat
   *  move — drives live-session resolution at check-in. */
  participantId?: string;
  /** Present only for HP (arena) QRs — the Square locationId the
   *  session belongs to. Absent on FT QRs (implicitly FastTrax). */
  locationId?: string;
}

export function parseCheckinQr(raw: string): ParsedCheckinQr | null {
  if (!raw) return null;
  const parts = raw.trim().split(":");

  // HP (arena) form: HP:{locationId}:{personId}:{sessionId}[:{participantId}]
  if (parts[0] === HP_PREFIX) {
    if (parts.length !== 4 && parts.length !== 5) return null;
    const [, locationId, personId, sessionId, participantId] = parts;
    // Must contain a letter — a digits-only segment is ids, not a location.
    if (!locationId || !/^(?=.*[A-Z])[A-Z0-9]+$/.test(locationId)) return null;
    if (!personId || !sessionId) return null;
    if (!/^\d+$/.test(personId) || !/^\d+$/.test(sessionId)) return null;
    if (parts.length === 5) {
      if (!participantId || !/^\d+$/.test(participantId)) return null;
      return { personId, sessionId, participantId, locationId };
    }
    return { personId, sessionId, locationId };
  }

  // 3-part = legacy (personId, sessionId); 4-part adds participantId.
  if (parts.length !== 3 && parts.length !== 4) return null;
  if (parts[0] !== PREFIX) return null;
  const [, personId, sessionId, participantId] = parts;
  if (!personId || !sessionId) return null;
  if (!/^\d+$/.test(personId) || !/^\d+$/.test(sessionId)) return null;
  if (parts.length === 4) {
    if (!participantId || !/^\d+$/.test(participantId)) return null;
    return { personId, sessionId, participantId };
  }
  return { personId, sessionId };
}
