/**
 * Staff identity — resolving a typed punch ID to the person who holds it.
 *
 * The pure rules live in `punch-index`; the cached, server-only lookup lives in
 * `service`. Import `verifyPunchId` from a route handler, never from a client
 * component: it reads Redis and may page 7shifts.
 */

export {
  buildPunchIndex,
  isActiveUser,
  normalizePunchId,
  staffFirstName,
  staffFromUser,
  type BuiltPunchIndex,
  type PunchIndex,
  type StaffIdentity,
} from "./punch-index";

/** The attribution fold and its shapes — PURE, so a client hook may import them
 *  to read `hostConflict` off a response. See host-attribution.ts. */
export {
  hostAttribution,
  type ActingStaff,
  type HostAttribution,
  type SessionHost,
} from "./host-attribution";
