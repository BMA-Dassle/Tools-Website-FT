/**
 * React Query keys for the availability sub (brief §3.4: `["crm", <sub>, …]`).
 * CLIENT-SAFE — no imports. Components import this file by path.
 *
 * The key carries the whole request, so dragging the start time through the
 * request bar reuses the 60-second server cache instead of refetching, and
 * going back to a start you already looked at is instant.
 */

export interface AvailabilityKeyParts {
  centre?: string;
  date?: string;
  start?: number;
  dur?: number;
  guests?: number;
  lead?: string;
}

export const availabilityKeys = {
  all: ["crm", "availability"] as const,
  grid: (q: AvailabilityKeyParts) => ["crm", "availability", "grid", q] as const,
  heats: (q: AvailabilityKeyParts & { resourceId?: string }) =>
    ["crm", "availability", "heats", q] as const,
};
