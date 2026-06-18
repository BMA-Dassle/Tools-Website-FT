import { redirect } from "next/navigation";

/**
 * Short, shareable check-in URL: headpinz.com/healthnet
 *
 * For coworkers who didn't get the tokenized email link. Redirects to the
 * Health Net check-in page, which (with no token) asks for their email and
 * looks them up on the roster.
 *
 * NOTE: registered in middleware.ts `isSharedTopLevelRoute` so it serves on
 * both brand domains without the /hp rewrite.
 */
export default function HealthnetShortlink() {
  redirect("/event/healthnet-2026/confirm");
}
