/**
 * Client-side fetch wrappers for the account API. Cookies ride along on
 * same-origin requests; mutations attach the double-submit CSRF header.
 * Non-2xx responses throw AccountApiError (react-query surfaces `.message`).
 */

export class AccountApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterSec?: number,
  ) {
    super(message);
    this.name = "AccountApiError";
  }
}

async function handle(res: Response): Promise<unknown> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new AccountApiError(
      res.status,
      typeof data.code === "string" ? data.code : "ERROR",
      typeof data.error === "string" ? data.error : "Something went wrong",
      typeof data.retryAfterSec === "number" ? data.retryAfterSec : undefined,
    );
  }
  return data;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  return handle(res) as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown, csrf?: string): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "x-account-csrf": csrf } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return handle(res) as Promise<T>;
}
