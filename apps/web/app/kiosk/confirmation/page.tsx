import Link from "next/link";

/**
 * Kiosk confirmation — STAGE 1 PLACEHOLDER. The real page (QR, itinerary,
 * bowl-now live lane display, 60s auto-reset) lands with the checkout stage.
 */
export default function KioskConfirmationPage() {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-10 bg-[#000418] px-10 text-center">
      <div className="font-heading text-[6vh] font-extrabold italic">You&rsquo;re booked.</div>
      <div className="text-[2.4vh] text-white/55">
        Confirmation page arrives with the checkout stage.
      </div>
      <Link
        href="/kiosk"
        className="font-heading rounded-full bg-[#00e2e5] px-12 py-5 text-[2.6vh] font-extrabold uppercase italic tracking-wide text-[#04252b]"
      >
        Done — start over
      </Link>
    </div>
  );
}
