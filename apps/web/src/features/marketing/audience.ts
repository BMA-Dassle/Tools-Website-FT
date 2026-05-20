/**
 * Audience resolution — Square customer lookup / create.
 *
 * Single canonical way to go from "phone (+ optional name)" to a Square
 * customer id. Used by:
 *   - guest-survey enqueue (this PR)
 *   - bowling reservation creation (this PR — wires in)
 *   - future marketing campaigns
 *
 * Search order:
 *   1. Phone exact-match (E.164) via /v2/customers/search
 *   2. If still nothing AND a name was supplied, try `given_name + family_name`
 *      filter as a fallback (some customers have phone stored without country
 *      code or formatted differently).
 *   3. Create a new customer if no match.
 *
 * Optionally updates name/email on an existing customer if those fields are
 * missing and we have values for them (matches the existing route behavior
 * in apps/web/app/api/square/customer/route.ts).
 */

const SQUARE_BASE = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-12-18";

function squareHeaders(): HeadersInit {
  const token = process.env.SQUARE_ACCESS_TOKEN || "";
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

/**
 * Split a single "First Last" display name into first/last parts.
 * Rules:
 *   - Empty input → both fields empty strings
 *   - Single token → firstName only ("Madonna" → { firstName: "Madonna", lastName: "" })
 *   - Multi-token → first token = firstName, rest joined = lastName
 *     ("Mary Jane Watson" → { firstName: "Mary", lastName: "Jane Watson" })
 */
export function splitGuestName(name: string): { firstName: string; lastName: string } {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { firstName: "", lastName: "" };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * Normalize a phone number to E.164 (US default).
 * Accepts: "5551234567", "(555) 123-4567", "+15551234567", "15551234567"
 * Rejects: empty / non-numeric input → throws.
 */
export function normalizePhoneE164(input: string): string {
  if (!input || typeof input !== "string") {
    throw new Error("normalizePhoneE164: phone is required");
  }
  const trimmed = input.trim();
  const startsWithPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (digits.length === 0) {
    throw new Error(`normalizePhoneE164: no digits in "${input}"`);
  }

  // Already had a + → trust the digits as-is.
  if (startsWithPlus) return `+${digits}`;

  // US 10-digit → prefix +1.
  if (digits.length === 10) return `+1${digits}`;

  // US 11-digit starting with 1 → prefix +.
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  // Anything else → assume it's already country-code-prefixed.
  return `+${digits}`;
}

interface SquareCustomer {
  id: string;
  given_name?: string;
  family_name?: string;
  email_address?: string;
  phone_number?: string;
}

export interface AudienceMember {
  squareCustomerId: string;
  phoneE164: string;
  givenName: string | null;
  familyName: string | null;
  email: string | null;
  /** True when this call created a new Square customer (vs returning an existing match). */
  isNew: boolean;
}

export interface ResolveAudienceMemberInput {
  phone: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

/**
 * Resolve a phone (+ optional name/email) to a Square customer.
 *
 * Behavior:
 *   - Phone-exact match found → returns it; if name/email were missing on the
 *     Square row and we have values, PATCH them in.
 *   - Phone miss + name supplied → name fallback search.
 *   - No match at all → create with idempotency_key = `audience-{phone}-{date}`
 *     so retries within the same second don't double-create.
 *
 * Throws on Square API errors. Callers can catch and degrade.
 */
export async function resolveAudienceMember(
  input: ResolveAudienceMemberInput,
): Promise<AudienceMember> {
  const phoneE164 = normalizePhoneE164(input.phone);

  // 1. Phone exact-match search
  const existing = await searchByPhone(phoneE164);
  if (existing) {
    await maybePatchMissingFields(existing, input);
    return toAudienceMember(existing, phoneE164, false);
  }

  // 2. Name fallback (only if a name was supplied)
  if (input.firstName || input.lastName) {
    const byName = await searchByName({
      firstName: input.firstName,
      lastName: input.lastName,
    });
    if (byName) {
      // Found by name — patch the phone in if it was missing.
      if (!byName.phone_number) {
        await patchCustomer(byName.id, { phone_number: phoneE164 });
      }
      await maybePatchMissingFields(byName, input);
      return toAudienceMember(byName, phoneE164, false);
    }
  }

  // 3. Create
  const created = await createCustomer({
    phoneE164,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
  });
  return toAudienceMember(created, phoneE164, true);
}

// ─────────────────────────────────────────────────────────────────
// Internals (exported for tests)
// ─────────────────────────────────────────────────────────────────

async function searchByPhone(phoneE164: string): Promise<SquareCustomer | null> {
  const res = await fetch(`${SQUARE_BASE}/customers/search`, {
    method: "POST",
    headers: squareHeaders(),
    body: JSON.stringify({
      query: { filter: { phone_number: { exact: phoneE164 } } },
    }),
  });
  if (!res.ok) {
    throw new Error(`Square customer search (phone) failed: ${res.status}`);
  }
  const data = (await res.json()) as { customers?: SquareCustomer[] };
  return data.customers?.[0] ?? null;
}

async function searchByName(opts: {
  firstName?: string;
  lastName?: string;
}): Promise<SquareCustomer | null> {
  // Square's name fuzzy filter searches against the combined display name.
  const fuzzy = [opts.firstName, opts.lastName].filter(Boolean).join(" ").trim();
  if (!fuzzy) return null;
  const res = await fetch(`${SQUARE_BASE}/customers/search`, {
    method: "POST",
    headers: squareHeaders(),
    body: JSON.stringify({
      query: { filter: { reference_id: { fuzzy } } },
    }),
  });
  if (!res.ok) {
    // Name search is best-effort — log + continue with create.
    console.warn(`[audience] Square name search non-200: ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { customers?: SquareCustomer[] };
  return data.customers?.[0] ?? null;
}

async function createCustomer(opts: {
  phoneE164: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}): Promise<SquareCustomer> {
  // Idempotency key keyed on phone + date so the same call within a day
  // doesn't double-create if a previous request errored mid-flight.
  const dayStamp = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `audience-${opts.phoneE164.replace(/\D/g, "")}-${dayStamp}`;

  const res = await fetch(`${SQUARE_BASE}/customers`, {
    method: "POST",
    headers: squareHeaders(),
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      given_name: opts.firstName || undefined,
      family_name: opts.lastName || undefined,
      email_address: opts.email || undefined,
      phone_number: opts.phoneE164,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Square customer create failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as { customer?: SquareCustomer };
  if (!data.customer) {
    throw new Error("Square customer create returned no customer object");
  }
  return data.customer;
}

async function patchCustomer(
  customerId: string,
  patch: {
    given_name?: string;
    family_name?: string;
    email_address?: string;
    phone_number?: string;
  },
): Promise<void> {
  await fetch(`${SQUARE_BASE}/customers/${customerId}`, {
    method: "PUT",
    headers: squareHeaders(),
    body: JSON.stringify(patch),
  }).catch((err) => {
    // Best-effort patch — never fail the audience resolve over a missing-field update.
    console.warn(`[audience] Square customer PATCH failed for ${customerId}:`, err);
  });
}

async function maybePatchMissingFields(
  customer: SquareCustomer,
  input: ResolveAudienceMemberInput,
): Promise<void> {
  const patch: Record<string, string> = {};
  if (!customer.given_name && input.firstName) patch.given_name = input.firstName;
  if (!customer.family_name && input.lastName) patch.family_name = input.lastName;
  if (!customer.email_address && input.email) patch.email_address = input.email;
  if (Object.keys(patch).length === 0) return;
  await patchCustomer(customer.id, patch);
}

function toAudienceMember(c: SquareCustomer, phoneE164: string, isNew: boolean): AudienceMember {
  return {
    squareCustomerId: c.id,
    phoneE164,
    givenName: c.given_name ?? null,
    familyName: c.family_name ?? null,
    email: c.email_address ?? null,
    isNew,
  };
}
