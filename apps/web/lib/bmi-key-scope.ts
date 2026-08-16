/**
 * Location scoping for Redis keys built from raw BMI ids (sessionId /
 * personId / participantId).
 *
 * FastTrax FM and HeadPinz FM share ONE BMI server, so their numeric id
 * namespaces can never collide — every e-ticket key written since launch
 * assumes that. HeadPinz Naples (PPTR5G2N0QXF7) runs a SEPARATE BMI server
 * whose ids CAN collide with FM's, which corrupts cross-location state:
 * ticket reuse for the wrong venue, false move detection, cross-fired
 * "checking in now" banners. (Documented blocker in
 * src/features/arena-tickets/constants.ts + docs/hp-arena-etickets-rollout.md.)
 *
 * Scheme: keys for the ORIGINAL shared BMI server keep their legacy shape
 * byte-for-byte (no migration, no orphaned dedup state, no double-sends at
 * FM), and any OTHER location gets a `{locationId}:` segment. Same idea as
 * the QR payload split in lib/qr-checkin.ts (location-less FT form vs
 * HP:{locationId}:... form).
 */

/** Square/Pandora location ids that live on the original shared FM BMI
 *  server: FastTrax Fort Myers + HeadPinz Fort Myers. */
const SHARED_FM_BMI_LOCATIONS = new Set(["LAB52GY480CJF", "TXBSQN0FEKQ11"]);

/**
 * Key segment for a location: "" for the shared FM server (legacy shape),
 * `{locationId}:` for everything else (Naples, future centers). Insert
 * between the key prefix and the first BMI id:
 *
 *   `ticket:bySession:${bmiKeyScope(loc)}${sessionId}:${personId}`
 *
 * An absent/empty locationId maps to the legacy shape — matches every
 * record minted before locations existed on this rail.
 */
export function bmiKeyScope(locationId: string | number | null | undefined): string {
  const loc = String(locationId ?? "").trim();
  if (!loc || SHARED_FM_BMI_LOCATIONS.has(loc)) return "";
  return `${loc}:`;
}
