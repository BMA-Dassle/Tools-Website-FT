/**
 * Client-side fetch wrappers for the game-cards API. Public endpoints (no
 * login / CSRF). Non-2xx responses throw GameCardApiError (react-query surfaces
 * `.message`).
 */

export class GameCardApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "GameCardApiError";
  }
}

async function handle(res: Response): Promise<unknown> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new GameCardApiError(
      res.status,
      typeof data.code === "string" ? data.code : "ERROR",
      typeof data.error === "string" ? data.error : "Something went wrong",
    );
  }
  return data;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handle(res) as Promise<T>;
}
