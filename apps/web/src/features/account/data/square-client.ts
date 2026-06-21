/**
 * The ONE place Square HTTP config lives for the account module. A future
 * Square-Version bump (e.g. when Beta pause/swap-plan land) is a one-line edit
 * here, isolated from the booking / have-a-ball flows that share the token.
 *
 * Square ids are alphanumeric strings (NOT the 17-digit BMI/Pandora ids that
 * need raw-id handling), so ordinary JSON parsing is safe here.
 */

export const SQUARE_BASE = "https://connect.squareup.com/v2";
export const SQUARE_VERSION = "2024-12-18"; // GA for Customers/Subscriptions/Cards used in v1

function token(): string {
  return process.env.SQUARE_ACCESS_TOKEN || "";
}

export function sqHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${token()}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

export interface SquareResponse<T> {
  status: number;
  ok: boolean;
  data: T;
}

/** Thin fetch wrapper: prepends base URL + headers, parses JSON (empty body → {}). */
export async function squareFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<SquareResponse<T>> {
  const res = await fetch(`${SQUARE_BASE}${path}`, {
    ...init,
    headers: { ...sqHeaders(), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  return { status: res.status, ok: res.ok, data: data as T };
}

/** Pull the first Square error detail for safe logging (never log full bodies — PII). */
export function squareErrorDetail(data: unknown): string {
  const errs = (data as { errors?: { code?: string; detail?: string }[] })?.errors;
  if (Array.isArray(errs) && errs[0]) {
    return errs[0].detail || errs[0].code || "Square error";
  }
  return "Square error";
}
