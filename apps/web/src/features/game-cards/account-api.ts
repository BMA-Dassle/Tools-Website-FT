"use client";

/**
 * Client calls for the signed-in layer of the reload page. Sign-in reuses the
 * existing account OTP/session endpoints (`/api/account/*`); game-card linking
 * + saved-card management use the `/api/game-cards/*` session-gated routes.
 * Mutations attach the double-submit CSRF header (value from session/me).
 */
import type { CardBalance } from "./types";

export class GcAccountError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "GcAccountError";
  }
}

async function handle(res: Response): Promise<unknown> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new GcAccountError(
      res.status,
      typeof data.code === "string" ? data.code : "ERROR",
      typeof data.error === "string" ? data.error : "Something went wrong",
    );
  }
  return data;
}

function get<T>(path: string): Promise<T> {
  return fetch(path, { credentials: "same-origin", headers: { Accept: "application/json" } }).then(
    handle,
  ) as Promise<T>;
}
function post<T>(path: string, body?: unknown, csrf?: string): Promise<T> {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(csrf ? { "x-account-csrf": csrf } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(handle) as Promise<T>;
}

// ── Session / OTP (reuse account endpoints) ──────────────────────────────────
export interface GcSession {
  authenticated: boolean;
  contactMasked?: string;
  contactType?: "phone" | "email";
  customerCount?: number;
  csrf?: string;
}
export const getGcSession = () => get<GcSession>("/api/account/session/me");
export const requestOtp = (contact: string) =>
  post<{ channel: string; maskedDestination: string }>("/api/account/request-otp", { contact });
export const verifyOtp = (contact: string, code: string) =>
  post<{ ok: boolean; hasCustomers?: boolean; error?: string; attemptsLeft?: number }>(
    "/api/account/verify-otp",
    { contact, code },
  );
export const logout = (csrf?: string) => post<{ ok: true }>("/api/account/logout", {}, csrf);

// ── Game cards ───────────────────────────────────────────────────────────────
export interface LinkedGameCard {
  accountNumber: string;
  label: string | null;
  locationCode: number | null;
  exists: boolean;
  balance?: CardBalance;
}
export interface SavedPaymentCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  expired: boolean;
  customerId: string;
}
export interface MyCardsResponse {
  customerId: string | null;
  customerIds: string[];
  counts: Record<string, number>;
  gameCards: LinkedGameCard[];
  savedCards: SavedPaymentCard[];
}

export const fetchMyCards = (customerId?: string) =>
  post<MyCardsResponse>("/api/game-cards/my-cards", { customerId });
export const linkCard = (
  b: { customerId: string; accountNumber: string; locationCode?: number },
  csrf?: string,
) => post<{ ok: true; card: LinkedGameCard }>("/api/game-cards/link", b, csrf);
export const unlinkCard = (b: { customerId: string; accountNumber: string }, csrf?: string) =>
  post<{ ok: true }>("/api/game-cards/unlink", b, csrf);
export const renameCard = (
  b: { customerId: string; accountNumber: string; nickname: string },
  csrf?: string,
) => post<{ ok: true }>("/api/game-cards/rename", b, csrf);
export const disableSavedCard = (b: { customerId: string; cardId: string }, csrf?: string) =>
  post<{ ok: true }>("/api/game-cards/saved-card", b, csrf);
export const createRewardsAccount = (csrf?: string) =>
  post<{ ok: true; customerId: string }>("/api/game-cards/create-account", {}, csrf);
