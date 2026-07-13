/**
 * One-off backfill: copy the employee portal's event_metadata rows (food-out
 * times for group events) into the website Neon, as part of moving the Daily
 * Events page to the website.
 *
 * The two apps use DIFFERENT Neon instances; the table shape is identical
 * (the website port kept the portal DDL verbatim), so this is a straight,
 * idempotent row copy. Migrating everything keeps manual food-out overrides
 * for already-booked future events — the rows that actually matter.
 *
 * Usage (local, never deployed):
 *   PORTAL_DATABASE_URL=postgres://...portal... \
 *   DATABASE_URL=postgres://...website... \
 *   node apps/web/scripts/migrate-daily-event-metadata.mjs
 */
import { neon } from "@neondatabase/serverless";

const portalUrl = process.env.PORTAL_DATABASE_URL;
const websiteUrl = process.env.DATABASE_URL;
if (!portalUrl || !websiteUrl) {
  console.error("Set PORTAL_DATABASE_URL and DATABASE_URL");
  process.exit(1);
}

const portal = neon(portalUrl);
const website = neon(websiteUrl);

// Ensure the target table exists (same DDL the app bootstraps).
await website.query(`
  CREATE TABLE IF NOT EXISTS event_metadata (
    id SERIAL PRIMARY KEY,
    project_id VARCHAR(100) NOT NULL,
    location_id INTEGER NOT NULL,
    event_date DATE NOT NULL,
    food_out_time VARCHAR(50),
    food_out_source VARCHAR(20) DEFAULT 'ai',
    food_out_confidence VARCHAR(20),
    food_out_reasoning TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(project_id, location_id, event_date)
  )
`);
await website.query(
  `CREATE INDEX IF NOT EXISTS idx_event_metadata_lookup ON event_metadata(project_id, location_id, event_date)`,
);

const rows = await portal.query(`
  SELECT project_id, location_id, event_date::text AS event_date, food_out_time,
         food_out_source, food_out_confidence, food_out_reasoning, metadata,
         created_at, updated_at
  FROM event_metadata
  ORDER BY id
`);
console.log(`Portal rows: ${rows.length}`);

let copied = 0;
for (const r of rows) {
  await website.query(
    `INSERT INTO event_metadata
       (project_id, location_id, event_date, food_out_time, food_out_source,
        food_out_confidence, food_out_reasoning, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (project_id, location_id, event_date)
     DO UPDATE SET
       food_out_time = EXCLUDED.food_out_time,
       food_out_source = EXCLUDED.food_out_source,
       food_out_confidence = EXCLUDED.food_out_confidence,
       food_out_reasoning = EXCLUDED.food_out_reasoning,
       metadata = EXCLUDED.metadata,
       updated_at = EXCLUDED.updated_at`,
    [
      r.project_id,
      r.location_id,
      r.event_date,
      r.food_out_time,
      r.food_out_source,
      r.food_out_confidence,
      r.food_out_reasoning,
      r.metadata ?? {},
      r.created_at,
      r.updated_at,
    ],
  );
  copied++;
}
console.log(`Upserted ${copied} rows into website event_metadata.`);
