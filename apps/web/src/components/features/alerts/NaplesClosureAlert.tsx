/**
 * HeadPinz Naples emergency closure notice — SERVER shell.
 *
 * 2026-08-09: Naples is closed for the REST OF TODAY due to a water main
 * break. This is an OPERATIONAL ALERT, not an ad — it fires immediately on
 * arrival (no dwell, no scroll trigger) and re-arms every browser session,
 * because a guest heading to a closed building is exactly who must see it.
 * The client half scopes it to Naples pages with the same idiom as
 * NaplesOfferPopup, and SELF-RETIRES at 6 AM ET Sunday 2026-08-10 so it can
 * never claim the center is closed on a day it is open.
 *
 * Kill switch: `NAPLES_CLOSURE_ALERT=false` (server-read) if it must die
 * before then. If the closure EXTENDS past today, update the copy and
 * `SHOW_UNTIL_MS` in the client half. Remove the component and its layout
 * mount in a cleanup commit once this is over.
 */

import { NaplesClosureAlertClient } from "./NaplesClosureAlertClient";

export function NaplesClosureAlert() {
  if (process.env.NAPLES_CLOSURE_ALERT === "false") return null;
  return <NaplesClosureAlertClient />;
}
