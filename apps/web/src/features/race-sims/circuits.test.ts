import { describe, expect, it } from "vitest";
import {
  RACE_SIM_LINEUPS,
  SIM_CIRCUITS,
  circuitForTrack,
  circuitLengthLabel,
  getSimCircuit,
  simLineupFor,
  simSessionCircuitName,
} from "./circuits";
import { RACE_SIM_TRACKS } from "./products";
import { isRaceSimTrackLabel, raceSimConflictTrack } from "./scheduling";

describe("race-sim circuits", () => {
  it("programmes Baku / Bristol / Indianapolis onto keys A / B / C from 2026-09-15", () => {
    // The owner's lineup for the launch week. Keys are the BMI $0 products
    // (59535405 / 59537905 / 59537953) — the circuit is what each is RUNNING.
    expect(circuitForTrack("a", "2026-09-15")?.id).toBe("baku");
    expect(circuitForTrack("b", "2026-09-15")?.id).toBe("bristol");
    expect(circuitForTrack("c", "2026-09-15")?.id).toBe("indianapolis");
    expect(circuitForTrack("a", "2026-09-20")?.name).toBe("Baku City Circuit");
  });

  it("has no lineup before the first one — the placeholder phase", () => {
    expect(simLineupFor("2026-09-14")).toBeNull();
    expect(circuitForTrack("a", "2026-09-14")).toBeNull();
  });

  it("picks the LATEST lineup on or before the date", () => {
    // Programming next week = appending an entry, never editing a live row, so
    // an old booking still resolves to the circuit it was actually sold as.
    const sorted = [...RACE_SIM_LINEUPS].sort((a, b) => a.from.localeCompare(b.from));
    expect(RACE_SIM_LINEUPS.map((l) => l.from)).toEqual(sorted.map((l) => l.from));
    const last = sorted[sorted.length - 1]!;
    expect(simLineupFor("2099-01-01")?.from).toBe(last.from);
  });

  it("only programmes circuits that exist in the catalog", () => {
    for (const lineup of RACE_SIM_LINEUPS) {
      for (const key of ["a", "b", "c"] as const) {
        expect(getSimCircuit(lineup[key]), `${lineup.from} key ${key}`).toBeTruthy();
      }
    }
  });

  it("never lets a circuit name become the persisted conflict label", () => {
    // THE regression this file exists to prevent. The conflict label is written
    // into booking_metadata.racesims[].track and matched months later; the
    // circuit rotates. If a circuit name ever equalled a key label, a rotation
    // would silently reclassify already-sold sims as non-sims and swap the
    // same-start rule for the 30-minute one.
    const labels = new Set(RACE_SIM_TRACKS.map((t) => t.conflictLabel));
    for (const circuit of SIM_CIRCUITS) {
      expect(labels.has(circuit.name), `${circuit.name} collides with a key label`).toBe(false);
      expect(labels.has(circuit.shortName), `${circuit.shortName} collides`).toBe(false);
    }
    // And the labels themselves still round-trip as sim labels.
    for (const track of RACE_SIM_TRACKS) {
      expect(isRaceSimTrackLabel(track.conflictLabel)).toBe(true);
      expect(raceSimConflictTrack(track.key)).toBe(track.conflictLabel);
    }
  });

  it("names a booked session by the circuit that ran ON ITS OWN DATE", () => {
    // A receipt reprinted after the lineup rotates must still name what was
    // raced, so the lookup keys off the session's date, never today's.
    expect(simSessionCircuitName("b", "2026-09-16T10:00:00", "Track B")).toBe(
      "Bristol Motor Speedway",
    );
    // Before the first lineup there is no circuit — fall back to what those
    // bookings were actually sold as.
    expect(simSessionCircuitName("b", "2026-08-30T10:00:00", "Track B")).toBe("Track B");
    expect(simSessionCircuitName(null, "2026-09-16T10:00:00", "Race Sim")).toBe("Race Sim");
  });

  it("carries real specifications, not placeholders", () => {
    const baku = getSimCircuit("baku")!;
    expect(baku.turns).toBe(20);
    expect(baku.lengthMi).toBeCloseTo(3.73, 2);
    expect(baku.lengthKm).toBeCloseTo(6.003, 3);
    const bristol = getSimCircuit("bristol")!;
    expect(bristol.lengthMi).toBeCloseTo(0.533, 3);
    expect(bristol.layout).toBe("oval");
    const indy = getSimCircuit("indianapolis")!;
    expect(indy.lengthMi).toBe(2.5);
    expect(indy.turns).toBe(4);
    // mi ↔ km must agree to within a rounding step, or one of them is a typo.
    for (const c of SIM_CIRCUITS) {
      expect(c.lengthKm, `${c.id} km/mi disagree`).toBeCloseTo(c.lengthMi * 1.609344, 2);
      expect(c.turns).toBeGreaterThan(0);
    }
  });

  it("gives every circuit both languages — kiosk i18n rule", () => {
    // Guest-facing kiosk copy ships EN + ES in the same commit. The circuit
    // NAME is a proper noun and stays English (glossary rule); everything
    // descriptive around it must be translated.
    for (const c of SIM_CIRCUITS) {
      expect(c.es.eventName.length, `${c.id} es.eventName`).toBeGreaterThan(0);
      expect(c.es.blurb.length, `${c.id} es.blurb`).toBeGreaterThan(0);
      expect(c.signatureEs.length, `${c.id} signatureEs`).toBeGreaterThan(0);
      expect(c.es.blurb, `${c.id} es.blurb is untranslated`).not.toBe(c.blurb);
      expect(c.signatureEs, `${c.id} signatureEs is untranslated`).not.toBe(c.signature);
    }
  });

  it("formats a lap length without trailing-zero noise", () => {
    expect(circuitLengthLabel(getSimCircuit("bristol")!)).toBe("0.533 mi · 0.86 km");
    expect(circuitLengthLabel(getSimCircuit("indianapolis")!)).toBe("2.5 mi · 4.02 km");
  });
});
