/**
 * Input validation for admin discount-code CRUD.
 *
 * Kept separate from the route handler so the same validator can be reused
 * by PATCH/PUT and unit-tested without spinning up Next handlers.
 */

import type {
  DiscountCodeInput,
  DiscountMechanic,
  DiscountScopes,
} from "~/features/discount-codes";

const MECHANICS_ALLOWED_FOR_CREATE = new Set<DiscountMechanic>(["percent", "fixed"]);

type ParseResult = { ok: true; value: DiscountCodeInput } | { ok: false; error: string };

export function validateInput(body: unknown): ParseResult {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;

  const codeRaw = typeof b.code === "string" ? b.code.trim() : "";
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(codeRaw)) {
    return { ok: false, error: "code must be 3–40 chars, letters/digits/dash/underscore only" };
  }
  const code = codeRaw.toUpperCase();

  const mechanic = b.mechanic as DiscountMechanic | undefined;
  if (!mechanic || !MECHANICS_ALLOWED_FOR_CREATE.has(mechanic)) {
    return {
      ok: false,
      error: "mechanic must be 'percent' or 'fixed' (other mechanics not supported yet)",
    };
  }

  if (mechanic === "percent") {
    if (typeof b.amountPct !== "number" || b.amountPct <= 0 || b.amountPct > 100) {
      return { ok: false, error: "amountPct must be a number > 0 and ≤ 100" };
    }
  }
  if (mechanic === "fixed") {
    if (
      typeof b.amountCents !== "number" ||
      b.amountCents <= 0 ||
      !Number.isInteger(b.amountCents)
    ) {
      return { ok: false, error: "amountCents must be a positive integer" };
    }
  }

  const startsAt = parseIso(b.startsAt);
  const expiresAt = parseIso(b.expiresAt);
  if (!startsAt) return { ok: false, error: "startsAt must be an ISO timestamp" };
  if (!expiresAt) return { ok: false, error: "expiresAt must be an ISO timestamp" };
  if (Date.parse(expiresAt) <= Date.parse(startsAt)) {
    return { ok: false, error: "expiresAt must be after startsAt" };
  }

  let allowedWeekdays: number[] | null = null;
  if (Array.isArray(b.allowedWeekdays)) {
    const arr = b.allowedWeekdays as unknown[];
    if (!arr.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 6)) {
      return { ok: false, error: "allowedWeekdays must be integers 0–6 (Sun=0)" };
    }
    allowedWeekdays = arr as number[];
  }

  let allowedLocations: string[] | null = null;
  if (Array.isArray(b.allowedLocations)) {
    const arr = b.allowedLocations as unknown[];
    if (!arr.every((s) => typeof s === "string" && s.length > 0)) {
      return { ok: false, error: "allowedLocations must be an array of non-empty strings" };
    }
    allowedLocations = arr as string[];
  }

  const scopes = parseScopes(b.scopes);
  if (!scopes.ok) return { ok: false, error: scopes.error };
  if (Object.keys(scopes.value).length === 0) {
    return { ok: false, error: "scopes must include at least one of bowling/racing/attractions" };
  }

  const maxUses = optionalNonNegInt(b.maxUses);
  if (maxUses === "ERR") return { ok: false, error: "maxUses must be a non-negative integer" };
  const maxUsesPerCustomer = optionalNonNegInt(b.maxUsesPerCustomer);
  if (maxUsesPerCustomer === "ERR") {
    return { ok: false, error: "maxUsesPerCustomer must be a non-negative integer" };
  }

  const active = b.active == null ? true : Boolean(b.active);

  const squareDisplayName = optionalShortString(b.squareDisplayName, 200);
  if (squareDisplayName === "ERR") {
    return { ok: false, error: "squareDisplayName must be a string up to 200 chars" };
  }
  const marketingAccount = optionalShortString(b.marketingAccount, 40);
  if (marketingAccount === "ERR") {
    return { ok: false, error: "marketingAccount must be a string up to 40 chars" };
  }

  return {
    ok: true,
    value: {
      code,
      description: typeof b.description === "string" ? b.description : undefined,
      mechanic,
      amountPct: mechanic === "percent" ? (b.amountPct as number) : null,
      amountCents: mechanic === "fixed" ? (b.amountCents as number) : null,
      startsAt,
      expiresAt,
      allowedWeekdays,
      allowedLocations,
      scopes: scopes.value,
      squareDisplayName,
      marketingAccount,
      maxUses,
      maxUsesPerCustomer,
      active,
    },
  };
}

function parseIso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ts = Date.parse(v);
  if (isNaN(ts)) return null;
  return new Date(ts).toISOString();
}

function optionalNonNegInt(v: unknown): number | null | "ERR" {
  if (v == null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return "ERR";
  return v;
}

function optionalShortString(v: unknown, maxLen: number): string | null | "ERR" {
  if (v == null) return null;
  if (typeof v !== "string") return "ERR";
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLen) return "ERR";
  return trimmed;
}

function parseScopes(
  v: unknown,
): { ok: true; value: DiscountScopes } | { ok: false; error: string } {
  if (!v || typeof v !== "object") return { ok: false, error: "scopes must be an object" };
  const out: DiscountScopes = {};
  const s = v as Record<string, unknown>;

  if ("bowling" in s) {
    const r = parseScopeBucket(s.bowling, "experienceSlugs");
    if (!r.ok) return { ok: false, error: `scopes.bowling: ${r.error}` };
    out.bowling = { experienceSlugs: r.value };
  }
  if ("racing" in s) {
    const r = parseScopeBucket(s.racing, "productSlugs");
    if (!r.ok) return { ok: false, error: `scopes.racing: ${r.error}` };
    out.racing = { productSlugs: r.value };
  }
  if ("attractions" in s) {
    const r = parseScopeBucket(s.attractions, "slugs");
    if (!r.ok) return { ok: false, error: `scopes.attractions: ${r.error}` };
    out.attractions = { slugs: r.value };
  }
  return { ok: true, value: out };
}

function parseScopeBucket(
  v: unknown,
  key: string,
): { ok: true; value: string[] | null } | { ok: false; error: string } {
  if (!v || typeof v !== "object") return { ok: false, error: "must be an object" };
  const o = v as Record<string, unknown>;
  const raw = o[key];
  if (raw == null) return { ok: true, value: null };
  if (!Array.isArray(raw) || !raw.every((s) => typeof s === "string" && s.length > 0)) {
    return { ok: false, error: `${key} must be null or array of non-empty strings` };
  }
  return { ok: true, value: raw as string[] };
}
