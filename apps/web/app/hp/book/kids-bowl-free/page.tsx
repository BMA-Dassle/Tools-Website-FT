import { redirect } from "next/navigation";
import { isKbfOffered, KBF_OFFSEASON_PATH } from "@/lib/kbf-schedule";
import BowlingWizard from "@/components/bowling/BowlingWizard";

/**
 * v1 Kids Bowl Free wizard.
 *
 * On headpinz.com this route never renders — middleware's v1→v2 cutover
 * redirects it to /book/kbf/v2 first. It stays reachable on the FastTrax host
 * and on preview deployments, so it carries the season gate too rather than
 * relying on a redirect that is host-conditional.
 *
 * A server component wrapping the client wizard (it was "use client" itself
 * before): `redirect()` has to run on the server, and the wizard's own date
 * picker would otherwise render an empty month with no explanation.
 */

/** Hourly re-render so the gate below isn't baked into a deploy. */
export const revalidate = 3600;

export default function KidsBowlFreeV2Page() {
  if (!isKbfOffered()) redirect(KBF_OFFSEASON_PATH);

  return <BowlingWizard kind="kbf" />;
}
