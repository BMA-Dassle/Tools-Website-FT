/**
 * Entry-screen scanning — public surface.
 *
 * Makes the four screens a guest sees before choosing anything (attract, the
 * "What are we doing today?" chooser, and the Attractions / Experiences
 * shelves) accept a scan and route it: reservation → check-in, voucher →
 * the codes screen, Game Zone card → Game Zone.
 *
 * A host mounts the listener, wires it to the router, and renders the toast:
 *
 *     const router = useEntryScanRouter({ config, goCheckin, goCodeEntry, goGameCard });
 *     <EntryScanListener onScan={router.handleScan} onLicense={router.handleLicense} />
 *     <EntryScanToast miss={router.miss} busy={router.busy} onDone={router.clearMiss} />
 */
export { EntryScanListener } from "./EntryScanListener";
export { EntryScanToast } from "./EntryScanToast";
export {
  useEntryScanRouter,
  type EntryScanMiss,
  type EntryScanRouterHost,
} from "./useEntryScanRouter";
export { classifyEntryScan, type EntryScanRoute, type UnsupportedReason } from "./classify-entry";
export {
  stashEntryScan,
  consumeEntryScan,
  clearEntryScan,
  KIOSK_ENTRY_SCAN_KEY,
  type EntryScanHandoff,
  type EntryScanTarget,
} from "./handoff";
