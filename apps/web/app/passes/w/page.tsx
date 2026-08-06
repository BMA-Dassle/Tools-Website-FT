import { redirect } from "next/navigation";
import WalletPackClient from "~/features/racing/components/WalletPackClient";

export const dynamic = "force-dynamic";

/**
 * `/passes/w?g=…` — where a waiver's licence QR lands.
 *
 * The twin of `/passes/{billId}`, for the guests who have no booking to hang
 * off: the standalone waiver and the group-events participant waiver both send
 * people here. A static `w` segment sits beside the `[billId]` one and wins the
 * match, so nothing about the booking route changes.
 *
 * WHY THIS EXISTS AT ALL, rather than pointing the QR straight at
 * `/r/{code}/wallet`: a pass PassKit has not finished rendering is served as an
 * HTML landing page, so a bare redirect hands the guest something they cannot
 * install. That is exactly what the kiosk shipped first and had to be fixed.
 * This page runs the same prepare-poll-hand-off behind the kiosk loader.
 *
 * The grants ARE the auth — each one is a server-signed proof that a waiver for
 * that person went on file, and it expires in two hours. See licence-grant.ts.
 */
export async function generateMetadata() {
  return {
    title: "Your FastTrax Racing Licence",
    robots: { index: false, follow: false },
  };
}

export default async function WaiverWalletPackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const g = typeof sp.g === "string" ? sp.g.trim() : "";
  // Nothing to prove, nothing to offer. Not an error page: a guest who opened a
  // stale link should land somewhere useful.
  if (!g) redirect("/racer");

  // `?p=` narrows to ONE racer, for the per-person QRs on the waiver card. It
  // grants nothing extra — the endpoints intersect it with the pack, so naming
  // someone the grants do not cover resolves nobody.
  const p = typeof sp.p === "string" ? sp.p.trim() : "";
  const personId = /^\d+$/.test(p) ? p : undefined;

  return <WalletPackClient packKey={`g=${g}`} personId={personId} />;
}
