import { guestMeta } from "~/features/kiosk/join/service";
import { JoinPhoneFlow } from "~/features/kiosk/join/phone/JoinPhoneFlow";
import type { JoinMeta } from "~/features/kiosk/join/phone/join-helpers";

/**
 * /join/{code} — the phone page a guest lands on after scanning the kiosk's
 * "join from your phone" QR. Shared top-level route on BOTH brand domains
 * (registered in middleware.ts isSharedTopLevelRoute + x-no-chrome); brand
 * theming comes from the join-session RECORD, not the host.
 *
 * No notFound() on a bad/expired code — that's an EXPECTED end state (Redis
 * TTL after the kiosk moved on), so the client flow renders a friendly
 * "scan again" screen instead of a 404. The SSR meta read is a first-paint
 * optimization only (brand + venue header); the client poll is authoritative,
 * so an SSR Redis blip never bricks a live session.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Join your group",
  robots: { index: false, follow: false },
};

const CODE_RE = /^[A-Za-z0-9_-]{8,24}$/;

export default async function JoinPage(props: { params: Promise<{ code: string }> }) {
  const { code } = await props.params;
  let initialMeta: JoinMeta | null = null;
  if (CODE_RE.test(code)) {
    try {
      const meta = await guestMeta(code);
      if (meta.status !== "gone") initialMeta = meta;
    } catch {
      /* Redis blip — the client poll resolves it. */
    }
  }
  return <JoinPhoneFlow code={code} initialMeta={initialMeta} />;
}
