import { redirect } from "next/navigation";

/**
 * Short, shareable SMS URL: headpinz.com/j
 *
 * Used in the Christmas in July text blast (keeps the SMS body to one GSM-7
 * segment). Redirects to the RSVP landing page with SMS UTM tags.
 *
 * NOTE: registered in middleware.ts `isSharedTopLevelRoute` so it serves on
 * both brand domains without the /hp rewrite.
 */
export default function JShortlink() {
  redirect("/event/xmas-in-july?utm_source=sms&utm_medium=blast&utm_campaign=xmas_in_july_2026");
}
