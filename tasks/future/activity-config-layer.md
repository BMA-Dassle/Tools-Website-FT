# Future: Activity config layer (admin-editable)

## Why this exists

Today every activity setting (price, availability, enabled/disabled, display copy, center coverage) is a hardcoded TypeScript constant in `lib/attractions-data.ts` / `lib/packages.ts` (v1) and will be the same in v2's `apps/web/src/features/booking/activities-catalog.ts`. Every change requires a code edit + redeploy.

PR-B2 deliberately keeps the static-TS-catalog pattern to avoid scope creep during the booking rewrite. This file captures the "config layer" idea so it doesn't get lost.

## Scope

A future PR that adds:

1. **Neon table** — `activity_config` with columns:
   - `slug` (PK, FK to catalog's activity slug)
   - `enabled` (boolean — overrides the catalog default)
   - `centers` (text[] — overrides which centers offer this; null = use catalog)
   - `price_overrides` (jsonb — per-product price override map)
   - `display_overrides` (jsonb — name, blurb, hero image overrides)
   - `metadata` (jsonb — escape hatch for ad-hoc fields)
   - `updated_at`, `updated_by`
2. **Admin route** `/admin/[token]/activities` — list activities, edit overrides, preview before save, audit trail.
3. **Runtime overlay** — `getActivityCatalog()` returns merged result of:
   - Static TS catalog (defaults — source of truth for shape/types)
   - + Neon overlay (overrides — fetched via React `cache()` or a 60s Redis TTL)
   - Defaults > overlay pattern: system boots even if DB is unreachable.
4. **Audit log** — every override change writes a row to `activity_config_audit` (who, when, before, after).

## Why defer

- PR-B2 doesn't need it. The static catalog is functionally complete.
- Building both at once doubles the scope and the failure surface.
- Today's config-change pace is fine (code edit + redeploy).
- The static catalog's TypeScript types are the canonical shape — a future overlay can validate against them.

## Trigger conditions

Build this when ANY of these are true:
- Marketing wants to flip an activity on/off without engineering on call.
- Pricing experiments require multi-day price A/B without redeploys.
- Center-level availability needs to differ across the day (e.g., laser-tag closes at 8pm on weekdays).
- More than ~3 config-only PRs land in a quarter — it's cheaper to build the layer.

## Estimated size

~3–5 days. Self-contained.

## Constraints to honor

- **Defaults > overlay**, never overlay-only. The static catalog must remain bootable on its own.
- **Type-safe overrides**: every override field maps to a typed catalog field. No untyped JSON soup.
- **Audit trail mandatory** — pricing/availability changes touch real customer money.
- **Read-through cache** with short TTL (60s) — admin edits should propagate fast but DB load stays bounded.
- **Admin permissions** — gate behind the existing admin token + a per-activity permission check.
