/**
 * Post-confirmation heat setup patch — replaces the manual "Placeholder" step.
 *
 * Heats guests book into are created in the BMI dayplanner with a generic
 * placeholder setup; staff had to set the proper speed/style for the race
 * level before the heat ran. Pandora's `PATCH /v2/bmi/session/{locationID}`
 * locates the heat by track + center-local start time and applies the derived
 * display name + style (BMI SESS_SET) from `level` + `junior`. We fire it at
 * every point a race booking reaches fully-confirmed (unified reserve, legacy
 * v2 reserve, race-confirm-reconcile). Re-applying the same style is a no-op,
 * so double-firing across entry points is safe.
 *
 * NEVER throws and never fails the booking — the guest is already paid and
 * confirmed. A failed patch just means the status-quo manual setup step for
 * that one heat (logged loudly + bmi:api:log).
 */
import redis from "@/lib/redis";
import { getRaceProductById, type RaceTier, type RaceCategory } from "./race-products";

const PANDORA_BASE = "https://bma-pandora-api.azurewebsites.net/v2";
/** Races run only at FastTrax Fort Myers (same id the state→-3 call uses). */
const PANDORA_RACE_LOCATION_ID = "LAB52GY480CJF";

export interface HeatSetupInput {
  productId?: string | null;
  /** "Red" | "Blue" | "Mega" — Pandora matches the bare track name. */
  track?: string | null;
  /** Naive center-local heat start, e.g. "2026-07-30T16:30:00". */
  heatId?: string | null;
  /** $0 build-key parts — set on package/combo heats whose productId is a
   *  pack SKU not in RACE_PRODUCTS. Single-race heats resolve via productId. */
  tier?: RaceTier;
  category?: RaceCategory;
}

interface HeatPatch {
  track: string;
  heatStart: string;
  level: RaceTier;
  junior: boolean;
}

export async function patchHeatSetups(
  heats: HeatSetupInput[],
  ctx: { source: string; billId?: string },
): Promise<void> {
  const tag = `[session-setup] ${ctx.source}${ctx.billId ? ` bill=${ctx.billId}` : ""}`;
  try {
    if (heats.length === 0) return;
    const key = process.env.SWAGGER_ADMIN_KEY || "";
    if (!key) {
      console.error(`${tag}: SWAGGER_ADMIN_KEY missing — skipping ${heats.length} heat(s)`);
      return;
    }

    // Resolve level/junior per heat, dedupe by physical block (track|start) —
    // several racers share one block. Adult/junior never share a block (owner
    // 2026-07-01), so a level disagreement is a data bug: log it, keep the first.
    const unique = new Map<string, HeatPatch>();
    for (const h of heats) {
      const product = getRaceProductById(h.productId);
      const level = h.tier ?? product?.tier ?? null;
      const junior = (h.category ?? product?.category) === "junior";
      if (!h.track || !h.heatId || !level) {
        console.error(
          `${tag}: skipping unresolvable heat (track=${h.track ?? "?"} start=${h.heatId ?? "?"} productId=${h.productId ?? "?"} level=${level ?? "?"})`,
        );
        continue;
      }
      const blockKey = `${h.track}|${h.heatId}`;
      const prev = unique.get(blockKey);
      if (prev) {
        if (prev.level !== level || prev.junior !== junior) {
          console.error(
            `${tag}: level conflict on ${blockKey} (${prev.level}/${prev.junior ? "junior" : "adult"} vs ${level}/${junior ? "junior" : "adult"}) — keeping first`,
          );
        }
        continue;
      }
      unique.set(blockKey, { track: h.track, heatStart: h.heatId, level, junior });
    }

    for (const patch of unique.values()) {
      let outcome: string;
      try {
        const res = await fetch(`${PANDORA_BASE}/bmi/session/${PANDORA_RACE_LOCATION_ID}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(patch),
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        outcome = res.ok ? "OK" : `HTTP ${res.status} ${text.slice(0, 300)}`;
      } catch (err) {
        outcome = err instanceof Error ? err.message : "fetch error";
      }
      const line = `${tag}: ${patch.track} ${patch.heatStart} → ${patch.level}${patch.junior ? " junior" : ""}: ${outcome}`;
      if (outcome === "OK") console.log(line);
      else console.error(line);
      try {
        await redis.lpush(
          "bmi:api:log",
          JSON.stringify({
            type: "session-setup",
            timestamp: new Date().toISOString(),
            source: ctx.source,
            billId: ctx.billId ?? null,
            ...patch,
            outcome,
          }),
        );
        await redis.ltrim("bmi:api:log", 0, 4999);
      } catch {
        // Redis failure is non-fatal
      }
    }
  } catch (err) {
    console.error(`${tag}: unexpected failure:`, err);
  }
}
