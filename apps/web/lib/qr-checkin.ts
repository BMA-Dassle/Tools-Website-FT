import QRCode from "qrcode";

const PREFIX = "FT";

/**
 * Build the check-in QR payload.
 *
 *   3-part (legacy):  FT:{personId}:{sessionId}
 *   4-part (current): FT:{personId}:{sessionId}:{participantId}
 *
 * The optional participantId makes the QR move-resilient — the check-in
 * route resolves the racer's LIVE session from it at scan time, so a
 * ticket survives a heat move. Omitting it emits the legacy 3-part
 * string unchanged (back-compat for callers / tickets without one).
 */
export function checkinQrPayload(
  personId: string | number,
  sessionId: string | number,
  participantId?: string | number | null,
): string {
  const pid = String(personId);
  const sid = String(sessionId);
  if (!pid || !/^\d+$/.test(pid)) throw new Error("personId must be a non-empty digit string");
  if (!sid || !/^\d+$/.test(sid)) throw new Error("sessionId must be a non-empty digit string");
  const partId = participantId == null ? "" : String(participantId);
  if (partId) {
    if (!/^\d+$/.test(partId)) throw new Error("participantId must be a digit string");
    return `${PREFIX}:${pid}:${sid}:${partId}`;
  }
  return `${PREFIX}:${pid}:${sid}`;
}

export async function checkinQrDataUrl(
  personId: string | number,
  sessionId: string | number,
  participantId?: string | number | null,
  width = 160,
): Promise<string> {
  const payload = checkinQrPayload(personId, sessionId, participantId);
  return QRCode.toDataURL(payload, {
    width,
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

export interface ParsedCheckinQr {
  personId: string;
  sessionId: string;
  /** Present only for 4-part QRs. Stable across a heat move — drives
   *  live-session resolution at check-in. */
  participantId?: string;
}

export function parseCheckinQr(raw: string): ParsedCheckinQr | null {
  if (!raw) return null;
  const parts = raw.trim().split(":");
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
