/**
 * Employee perks — the client's view of `POST /api/booking/v2/employee`.
 * Typed wrappers only; no rules live here (the server owns them). Safe in
 * client bundles: no server imports, no env.
 */
import type { MatchablePerson, SessionEmployee } from "./employee";

export interface EmployeeKioskCtx {
  deviceKey?: string;
  /** "fasttrax" | "headpinz" | "naples" — the lookup location. */
  center?: string;
  brand?: string;
}

export type StartResponse =
  | { ok: true; challenge: string; maskedPhone: string }
  | { ok: false; reason: string; retryAfterSec?: number };

export type VerifyResponse =
  | { ok: true; employee: SessionEmployee; linked: boolean }
  | { ok: false; reason: string; attemptsLeft?: number };

export type RecognizeResponse =
  | { ok: true; employee: SessionEmployee }
  | { ok: false; reason: string };

async function post<T>(body: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    const res = await fetch("/api/booking/v2/employee", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as T | null;
    return data ?? fallback;
  } catch {
    return fallback;
  }
}

export const employeeApi = {
  start(id: { punchId?: string; phone?: string }, kiosk?: EmployeeKioskCtx) {
    return post<StartResponse>(
      { action: "start", ...id, ...(kiosk ? { kiosk } : {}) },
      { ok: false, reason: "unavailable" },
    );
  },
  verify(
    input: { challenge: string; code: string; party: MatchablePerson[] },
    kiosk?: EmployeeKioskCtx,
  ) {
    return post<VerifyResponse>(
      { action: "verify", ...input, ...(kiosk ? { kiosk } : {}) },
      { ok: false, reason: "unavailable" },
    );
  },
  recognize(member: MatchablePerson, kiosk?: EmployeeKioskCtx) {
    return post<RecognizeResponse>(
      { action: "recognize", member, ...(kiosk ? { kiosk } : {}) },
      { ok: false, reason: "unavailable" },
    );
  },
};
