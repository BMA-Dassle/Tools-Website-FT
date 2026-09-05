/**
 * Staff-mode client fetches — the three calls the kiosk makes. Thin on purpose:
 * every decision lives server-side; these only shape errors so the sheets can
 * show one honest line.
 */
import type { StaffEmployee, StaffLocation } from "./types";
import type { StaffAccountView } from "./service.server";

export type StaffCardClientResult =
  | { linked: true; employee: StaffEmployee; token: string }
  | { linked: false; reason: "not-linked" | "unconfigured" | "error" }
  | { linked: false; reason: "not-manager"; name: string };

export async function resolveStaffCardClient(body: {
  account: string;
  kioskId: string | null;
  location: StaffLocation;
}): Promise<StaffCardClientResult> {
  try {
    const res = await fetch("/api/kiosk/staff-card", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: body.account,
        location: body.location,
        ...(body.kioskId ? { kioskId: body.kioskId } : {}),
      }),
    });
    const data = (await res.json().catch(() => null)) as StaffCardClientResult | null;
    if (!res.ok || !data) return { linked: false, reason: "error" };
    return data;
  } catch {
    return { linked: false, reason: "error" };
  }
}

export type StaffActionBody =
  | {
      action: "membership";
      personId: string;
      pandoraPersonId?: string;
      personName?: string;
      kindKey: string;
      activates?: string;
      expires: string;
      location: StaffLocation;
      kioskId?: string;
    }
  | {
      action: "comp";
      personId: string;
      pandoraPersonId?: string;
      personName?: string;
      kindKey: string;
      qty: number;
      reason?: string;
      location: StaffLocation;
      kioskId?: string;
    };

export type StaffActionResult =
  | { ok: true; resultId: string; kindLabel: string }
  | { ok: false; error: string };

export async function postStaffAction(
  token: string,
  body: StaffActionBody,
): Promise<StaffActionResult> {
  try {
    const res = await fetch("/api/kiosk/staff-actions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-kiosk-staff-token": token },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      resultId?: string;
      kindLabel?: string;
      error?: string;
    } | null;
    if (res.status === 401)
      return { ok: false, error: "Staff session expired — scan your card again" };
    if (!res.ok || !data?.ok || !data.resultId) {
      return { ok: false, error: data?.error || `Request failed (HTTP ${res.status})` };
    }
    return { ok: true, resultId: data.resultId, kindLabel: data.kindLabel || "" };
  } catch {
    return { ok: false, error: "Couldn't reach the server" };
  }
}

export async function fetchStaffAccount(
  token: string,
  personId: string,
  location: StaffLocation,
): Promise<{ account: StaffAccountView } | { error: string }> {
  try {
    const qs = new URLSearchParams({ action: "account", personId, location });
    const res = await fetch(`/api/kiosk/staff-actions?${qs}`, {
      headers: { "x-kiosk-staff-token": token },
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as {
      account?: StaffAccountView;
      error?: string;
    } | null;
    if (res.status === 401) return { error: "Staff session expired — scan your card again" };
    if (!res.ok || !data?.account) return { error: data?.error || `HTTP ${res.status}` };
    return { account: data.account };
  } catch {
    return { error: "Couldn't reach the server" };
  }
}

/** Is this person on the on-site server yet? null = couldn't tell (fail closed). */
export async function fetchPersonLocal(
  token: string,
  personId: string,
  location: StaffLocation,
): Promise<boolean | null> {
  try {
    const qs = new URLSearchParams({ action: "local", personId, location });
    const res = await fetch(`/api/kiosk/staff-actions?${qs}`, {
      headers: { "x-kiosk-staff-token": token },
      cache: "no-store",
    });
    const data = (await res.json().catch(() => null)) as { local?: boolean | null } | null;
    if (!res.ok || !data || typeof data.local !== "boolean") return null;
    return data.local;
  } catch {
    return null;
  }
}
