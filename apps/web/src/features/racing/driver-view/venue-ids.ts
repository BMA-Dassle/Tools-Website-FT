/**
 * Identifier fields on the venue timing wire.
 *
 * The app-side twin of `kart-timing-bridge/src/raw-ids.ts` — the bridge cannot
 * import from the monorepo (standalone Railway service, own package.json), so
 * the list exists in both places and the two must be kept in step. Changing one
 * without the other reopens the hole at whichever end was missed.
 *
 * Fed to `parseWithRawIds` at the webhook so 17-digit ids arrive as exact digit
 * strings. Quoting a field that happens to be small costs nothing: downstream
 * reads them all with `String()`, which is a no-op on an already-quoted value.
 */
export const VENUE_ID_FIELDS = [
  "PersonId",
  "ParticipantId",
  "DriverId",
  "RaceId",
  "SessionId",
  "PassingId",
  "RentalObjectId",
  "KartId",
  "TrapId",
  "ProductId",
  "NotificationMetaId",
  "RecordVersion",
  "Id",
] as const;
