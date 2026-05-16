# @ft/db

Database + safety primitives shared across the FastTrax Tools monorepo.

## What's in here

- **`sql()`** — Neon Postgres client (lazy-initialized from `DATABASE_URL`).
- **`isDbConfigured()`** — `true` iff `DATABASE_URL` is set.
- **`stringifyWithRawIds(obj, opts)`** — replaces `JSON.stringify` for HTTP
  bodies that contain BMI IDs (17-digit numbers that exceed
  `Number.MAX_SAFE_INTEGER`). String-injects the listed fields raw, then
  serializes the rest normally. Snapshot-tested against
  [`bookRaceHeat()`](../../apps/web/app/book/race/data.ts).
- **`withIdempotency(redis, key, fn)`** — Redis-locked wrapper for endpoints
  that consume shared inventory (Conq lane holds, POV codes, Square Orders,
  race-pack credits). Dedups by an owning resource id so retries don't
  double-allocate.

## Why this exists

Three production incidents drove the primitives:

1. **BMI ID precision loss** — `Number("63000000000021716")` silently becomes
   `63000000000021720`. The hand-rolled raw-injection pattern in
   `bookRaceHeat()` works but is easy to get wrong; `stringifyWithRawIds`
   makes it a typed, lint-enforceable helper.
2. **Shared-inventory double-allocation** — POV codes got popped twice
   from the pool when staff backfilled and a customer revisited. Every
   endpoint that consumes shared inventory now wraps writes in
   `withIdempotency(redis, key, fn)`.
3. **Convention drift across `lib/`** — each call site reimplementing the
   pattern by hand creates drift. Centralizing here is the prerequisite
   for an ESLint rule banning `JSON.stringify` in files that touch BMI
   IDs (planned follow-up).

See [`tasks/lessons.md`](../../tasks/lessons.md) "BMI ID Precision" and
"Idempotency on resource-consuming endpoints" for the underlying incidents.

## Usage

```ts
import { sql, isDbConfigured, stringifyWithRawIds, withIdempotency } from "@ft/db";

// Same shape as the previous apps/web/lib/db.ts.
if (isDbConfigured()) {
  const q = sql();
  const rows = await q`SELECT * FROM sales_log WHERE ts > ${cutoff}`;
}

// BMI-safe JSON serialization — no Number() on the IDs.
const body = stringifyWithRawIds(
  { productId: "abc", quantity: 1, proposal: { ... } },
  { rawIdFields: ["personId", "orderId"], rawIds: { personId, orderId } },
);
fetch("/api/bmi?endpoint=booking/book", { method: "POST", body });

// Idempotent inventory write.
import redis from "@/lib/redis";
const codes = await withIdempotency(
  redis,
  `pov:claimed:person:${personId}`,
  async () => allocatePovCodes(personId, 3),
);
```

## Status

Seeded in PR6 (2026-05-15). Phase 1 v2 Runway — read
[`tasks/restructure-plan.md`](../../tasks/restructure-plan.md) for context.
