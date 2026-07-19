/** Redis keys shared by the kiosk waiver roster route (reader) and join route
 *  (invalidator) — a join must bust the roster + person-validity caches so the
 *  post-add refetch shows the new signer immediately. */

export function rosterCacheKey(projectId: string): string {
  return `kiosk:waiver:roster:${projectId}`;
}

export function personValidCacheKey(personId: string): string {
  return `kiosk:waiver:pv:${personId}`;
}
