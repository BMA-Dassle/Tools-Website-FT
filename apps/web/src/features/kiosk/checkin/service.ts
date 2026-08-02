"use client";

/**
 * Thin client fetch layer for the kiosk check-in routes. Keeps KioskCheckinFlow
 * free of fetch boilerplate and gives one place to shape errors.
 */
import type {
  CheckinBindMember,
  CheckinBindResponse,
  CheckinCompleteResponse,
  CheckinConfirmOtpResponse,
  CheckinItinerary,
  CheckinLookupResponse,
  CheckinPartyMember,
  CheckinPartyResponse,
  CheckinSendOtpResponse,
  CheckinSlotAssignment,
} from "./types";

async function postLookup(
  body: Record<string, unknown>,
  action?: "send-otp" | "confirm-otp",
): Promise<Response> {
  const url = action ? `/api/kiosk/checkin/lookup?action=${action}` : "/api/kiosk/checkin/lookup";
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function lookupByScan(center: string, scan: string): Promise<CheckinLookupResponse> {
  try {
    const res = await postLookup({ center, scan });
    return (await res.json()) as CheckinLookupResponse;
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export async function lookupByPhone(
  center: string,
  phone: string,
  /** Test-bypass kioskId — server honors it only via its env allowlist. */
  kioskId?: string,
): Promise<CheckinLookupResponse> {
  try {
    const res = await postLookup({ center, phone, ...(kioskId ? { kioskId } : {}) });
    return (await res.json()) as CheckinLookupResponse;
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** Test-bypass row open (kiosk 99): browse ref → proof, no last-4/OTP. The
 *  server refuses unless the kioskId is on its env allowlist — callers fall
 *  back to the normal verify path on any failure. */
export async function lookupByRefBypass(
  center: string,
  ref: string,
  kioskId: string,
): Promise<CheckinLookupResponse> {
  try {
    const res = await postLookup({ center, ref, kioskId });
    return (await res.json()) as CheckinLookupResponse;
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export async function lookupBrowse(center: string): Promise<CheckinLookupResponse> {
  try {
    const res = await postLookup({ center, browse: true });
    return (await res.json()) as CheckinLookupResponse;
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export async function sendContactOtp(
  center: string,
  ref: string,
  last4: string,
): Promise<CheckinSendOtpResponse> {
  try {
    const res = await postLookup({ center, ref, last4 }, "send-otp");
    return (await res.json()) as CheckinSendOtpResponse;
  } catch {
    return { ok: false };
  }
}

export async function confirmContactOtp(
  center: string,
  ref: string,
  code: string,
): Promise<CheckinConfirmOtpResponse> {
  try {
    const res = await postLookup({ center, ref, code }, "confirm-otp");
    return (await res.json()) as CheckinConfirmOtpResponse;
  } catch {
    return { ok: false };
  }
}

export async function fetchItinerary(
  center: string,
  proofToken: string,
): Promise<CheckinItinerary | null> {
  try {
    const res = await fetch(
      `/api/kiosk/checkin/itinerary?proof=${encodeURIComponent(proofToken)}&center=${center}`,
      { cache: "no-store" },
    );
    return (await res.json()) as CheckinItinerary;
  } catch {
    return null;
  }
}

/** Bind-ready party of a proven reservation (voucher-QR prefill). Null on any
 *  failure — the panel just doesn't offer the shortcut. */
export async function fetchBindableParty(
  center: string,
  proofToken: string,
): Promise<CheckinPartyMember[] | null> {
  try {
    const res = await fetch("/api/kiosk/checkin/lookup?action=party", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ center, proofToken }),
      cache: "no-store",
    });
    const data = (await res.json()) as CheckinPartyResponse;
    return data.ok ? data.members : null;
  } catch {
    return null;
  }
}

export async function bindParty(
  center: string,
  proofToken: string,
  members: CheckinBindMember[],
  kioskId?: string,
): Promise<CheckinBindResponse> {
  try {
    const res = await fetch("/api/kiosk/checkin/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ center, proofToken, members, kioskId }),
    });
    return (await res.json()) as CheckinBindResponse;
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function completeCheckin(
  center: string,
  proofToken: string,
  kioskId?: string,
  assignments?: CheckinSlotAssignment[],
): Promise<CheckinCompleteResponse> {
  try {
    const res = await fetch("/api/kiosk/checkin/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ center, proofToken, kioskId, assignments }),
    });
    return (await res.json()) as CheckinCompleteResponse;
  } catch {
    return { ok: false, error: "network" };
  }
}

// ── own-phone OTP (reuses the shared /api/sms-verify rail, like ReturningRacerLookup) ──
export async function sendOwnPhoneOtp(phone: string): Promise<boolean> {
  try {
    const res = await fetch("/api/sms-verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    const data = (await res.json()) as { sent?: boolean };
    return !!data.sent;
  } catch {
    return false;
  }
}

export async function verifyOwnPhoneOtp(
  phone: string,
  code: string,
): Promise<{ verified: boolean; attemptsLeft?: number }> {
  try {
    const res = await fetch("/api/sms-verify", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, code }),
    });
    const data = (await res.json()) as { verified?: boolean; attemptsLeft?: number };
    return { verified: !!data.verified, attemptsLeft: data.attemptsLeft };
  } catch {
    return { verified: false };
  }
}
