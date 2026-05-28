import QRCode from "qrcode";

const PREFIX = "FT";

export function checkinQrPayload(personId: string | number, sessionId: string | number): string {
  const pid = String(personId);
  const sid = String(sessionId);
  if (!pid || !/^\d+$/.test(pid)) throw new Error("personId must be a non-empty digit string");
  if (!sid || !/^\d+$/.test(sid)) throw new Error("sessionId must be a non-empty digit string");
  return `${PREFIX}:${pid}:${sid}`;
}

export async function checkinQrDataUrl(
  personId: string | number,
  sessionId: string | number,
  width = 160,
): Promise<string> {
  const payload = checkinQrPayload(personId, sessionId);
  return QRCode.toDataURL(payload, {
    width,
    margin: 1,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

export interface ParsedCheckinQr {
  personId: string;
  sessionId: string;
}

export function parseCheckinQr(raw: string): ParsedCheckinQr | null {
  if (!raw) return null;
  const parts = raw.trim().split(":");
  if (parts.length !== 3) return null;
  if (parts[0] !== PREFIX) return null;
  const [, personId, sessionId] = parts;
  if (!personId || !sessionId) return null;
  if (!/^\d+$/.test(personId) || !/^\d+$/.test(sessionId)) return null;
  return { personId, sessionId };
}
