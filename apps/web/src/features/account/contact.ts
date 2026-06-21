import { canonicalizePhone } from "@/lib/participant-contact";
import type { ContactType } from "./types";

export interface NormalizedContact {
  type: ContactType;
  /** E.164 phone (`+1XXXXXXXXXX`) or lowercased email. */
  value: string;
  /** Redis namespace key, e.g. `email:a@b.com` / `phone:+12395551234`. */
  key: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Single smart field: contains `@` → treat as email; otherwise a US phone.
 * Channel is ALWAYS derived server-side here — never trusted from the client.
 * Returns null for anything that isn't a valid email or 10-digit US number.
 */
export function normalizeContact(raw: string): NormalizedContact | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    if (!EMAIL_RE.test(email)) return null;
    return { type: "email", value: email, key: `email:${email}` };
  }
  const phone = canonicalizePhone(trimmed);
  if (!phone) return null;
  return { type: "phone", value: phone, key: `phone:${phone}` };
}

/** Masked destination shown on the OTP screen (no full PII leaves the server). */
export function maskValue(value: string, type: ContactType): string {
  if (type === "email") {
    const [local, domain] = value.split("@");
    const shown = !local ? "" : local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
    return `${shown}***@${domain ?? ""}`;
  }
  return `•••• ${value.slice(-4)}`;
}

export function maskDestination(c: NormalizedContact): string {
  return maskValue(c.value, c.type);
}

/** First-hop client IP for per-IP rate limiting. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") || "unknown";
}
