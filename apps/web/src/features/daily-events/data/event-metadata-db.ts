import { sql, isDbConfigured } from "@ft/db";
import type { EventMetadata } from "../types";

/**
 * event_metadata — food-out times for group events, re-homed from the
 * employee portal into the website Neon (different DB instance, so the
 * portal-verbatim table name/shape carries over without collision; the
 * one-off backfill in scripts/migrate-daily-event-metadata.mjs is a
 * straight row copy).
 *
 * Portal DDL source: Tools-Team-Member-Portal api/lib/db.ts (event_metadata).
 */

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const q = sql();
      await q`
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
      `;
      await q`CREATE INDEX IF NOT EXISTS idx_event_metadata_lookup ON event_metadata(project_id, location_id, event_date)`;
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

interface EventMetadataRow {
  food_out_time: string | null;
  food_out_source: string | null;
  food_out_confidence: string | null;
  food_out_reasoning: string | null;
  metadata: Record<string, unknown> | null;
  updated_at: string | null;
}

function toEventMetadata(row: EventMetadataRow): EventMetadata {
  return {
    foodOutTime: row.food_out_time,
    foodOutSource: (row.food_out_source as EventMetadata["foodOutSource"]) ?? null,
    foodOutConfidence: row.food_out_confidence,
    foodOutReasoning: row.food_out_reasoning,
    metadata: row.metadata || {},
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export const EMPTY_EVENT_METADATA: EventMetadata = {
  foodOutTime: null,
  foodOutSource: null,
  foodOutConfidence: null,
  foodOutReasoning: null,
  metadata: {},
  updatedAt: null,
};

export async function getEventMetadataRow(
  projectId: string,
  locationId: number,
  date: string,
): Promise<EventMetadata | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT food_out_time, food_out_source, food_out_confidence, food_out_reasoning, metadata, updated_at
    FROM event_metadata
    WHERE project_id = ${projectId}
      AND location_id = ${locationId}
      AND event_date = ${date}
    LIMIT 1
  `) as EventMetadataRow[];
  return rows.length > 0 ? toEventMetadata(rows[0]) : null;
}

/** Manual-source row for the POST short-circuit (portal parity). */
export async function getManualEventMetadataRow(
  projectId: string,
  locationId: number,
  date: string,
): Promise<EventMetadata | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT food_out_time, food_out_source, food_out_confidence, food_out_reasoning, metadata, updated_at
    FROM event_metadata
    WHERE project_id = ${projectId}
      AND location_id = ${locationId}
      AND event_date = ${date}
      AND food_out_source = 'manual'
    LIMIT 1
  `) as EventMetadataRow[];
  return rows.length > 0 ? toEventMetadata(rows[0]) : null;
}

export async function upsertEventMetadataAi(params: {
  projectId: string;
  locationId: number;
  date: string;
  foodOutTime: string | null;
  confidence: string;
  reasoning: string;
}): Promise<void> {
  await ensureSchema();
  const q = sql();
  // Belt-and-braces: never clobber a manual row even if the service-level
  // manual check raced (the portal relied on the check alone).
  await q`
    INSERT INTO event_metadata (project_id, location_id, event_date, food_out_time, food_out_source, food_out_confidence, food_out_reasoning)
    VALUES (${params.projectId}, ${params.locationId}, ${params.date}, ${params.foodOutTime}, 'ai', ${params.confidence}, ${params.reasoning})
    ON CONFLICT (project_id, location_id, event_date)
    DO UPDATE SET
      food_out_time = ${params.foodOutTime},
      food_out_source = 'ai',
      food_out_confidence = ${params.confidence},
      food_out_reasoning = ${params.reasoning},
      updated_at = NOW()
    WHERE event_metadata.food_out_source IS DISTINCT FROM 'manual'
  `;
}

export async function upsertEventMetadataManual(params: {
  projectId: string;
  locationId: number;
  date: string;
  foodOutTime: string | null;
}): Promise<void> {
  await ensureSchema();
  const q = sql();
  await q`
    INSERT INTO event_metadata (project_id, location_id, event_date, food_out_time, food_out_source, food_out_confidence)
    VALUES (${params.projectId}, ${params.locationId}, ${params.date}, ${params.foodOutTime}, 'manual', 'high')
    ON CONFLICT (project_id, location_id, event_date)
    DO UPDATE SET
      food_out_time = ${params.foodOutTime},
      food_out_source = 'manual',
      food_out_confidence = 'high',
      food_out_reasoning = NULL,
      updated_at = NOW()
  `;
}

/** Food-out time for the BMI note sync (portal parity: any row, LIMIT 1). */
export async function getFoodOutTimeForProject(
  projectId: string,
  locationId: number,
): Promise<string | null> {
  if (!isDbConfigured()) return null;
  await ensureSchema();
  const q = sql();
  const rows = (await q`
    SELECT food_out_time
    FROM event_metadata
    WHERE project_id = ${projectId} AND location_id = ${locationId}
    ORDER BY event_date DESC
    LIMIT 1
  `) as { food_out_time: string | null }[];
  return rows[0]?.food_out_time ?? null;
}
