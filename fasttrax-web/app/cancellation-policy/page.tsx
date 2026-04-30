import type { Metadata } from "next";
import { headers } from "next/headers";

export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const host = (h.get("host") || "").toLowerCase();
  const brand = host.includes("headpinz") ? "HeadPinz" : "FastTrax Entertainment";
  return {
    title: `Cancellation & Payment Policy – ${brand}`,
    description: `${brand} cancellation, refund, and payment policy for all reservations.`,
    robots: { index: false, follow: false },
  };
}

export default async function CancellationPolicyPage() {
  const h = await headers();
  const host = (h.get("host") || "").toLowerCase();
  const isHeadPinz = host.includes("headpinz");
  const brandName = isHeadPinz ? "HeadPinz" : "FastTrax Entertainment";

  return (
    <div className="min-h-screen bg-[#000418] pt-32 pb-20">
      <div className="max-w-3xl mx-auto px-4 sm:px-6">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-10 space-y-6 text-white/80 text-sm leading-relaxed font-body">

          <div className="text-center space-y-1">
            <p className="text-white/40 text-xs uppercase tracking-widest">{brandName}</p>
            <h1 className="text-white font-bold text-lg sm:text-xl uppercase tracking-wider">
              Cancellation &amp; Payment Policy
            </h1>
            <p className="text-white/40 text-xs">Effective April 30, 2026</p>
          </div>

          <p>
            Reservations at {brandName} are confirmed immediately upon payment.
            By completing payment, the customer acknowledges and agrees to the terms of this policy.
          </p>

          <section>
            <h2 className="text-white font-bold text-sm uppercase tracking-wider mb-3">
              Cancellation Windows
            </h2>
            <p className="mb-3 text-white/60">
              The minimum advance notice required for a cancellation to be eligible for a refund
              or credit depends on the type of reservation:
            </p>
            <div className="rounded-xl border border-white/10 overflow-hidden">
              <div className="grid grid-cols-2 text-xs">
                <div className="px-4 py-3 bg-white/[0.04] border-b border-white/10 font-semibold text-white">Reservation Type</div>
                <div className="px-4 py-3 bg-white/[0.04] border-b border-l border-white/10 font-semibold text-white">Minimum Notice</div>
                {isHeadPinz ? (
                  <>
                    <div className="px-4 py-3 border-b border-white/10">Bowling</div>
                    <div className="px-4 py-3 border-b border-l border-white/10 font-semibold text-white">1 hour before</div>
                    <div className="px-4 py-3 border-b border-white/10">Laser Tag, Gel Blaster &amp; other attractions</div>
                    <div className="px-4 py-3 border-b border-l border-white/10 font-semibold text-white">2 hours before</div>
                    <div className="px-4 py-3">All other bookings</div>
                    <div className="px-4 py-3 border-l border-white/10 font-semibold text-white">2 hours before</div>
                  </>
                ) : (
                  <>
                    <div className="px-4 py-3 border-b border-white/10">Race reservations</div>
                    <div className="px-4 py-3 border-b border-l border-white/10 font-semibold text-white">2 hours before</div>
                    <div className="px-4 py-3 border-b border-white/10">Attraction bookings</div>
                    <div className="px-4 py-3 border-b border-l border-white/10 font-semibold text-white">2 hours before</div>
                    <div className="px-4 py-3">Race pack credit purchases</div>
                    <div className="px-4 py-3 border-l border-white/10 font-semibold text-white">Non-refundable</div>
                  </>
                )}
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-white font-bold text-sm uppercase tracking-wider mb-3">
              Cancellations &amp; Refunds
            </h2>
            <ul className="space-y-2 ml-1">
              <li>
                &middot; Cancellations made within the required notice window (see table above) are{" "}
                <strong className="text-white">non-refundable</strong>, no exceptions.
              </li>
              <li>
                &middot; Cancellations outside the required notice window may be eligible for a
                full refund or credit toward a future visit at {brandName}&apos;s discretion.
              </li>
              <li>
                &middot; No-shows are non-refundable regardless of circumstances.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-bold text-sm uppercase tracking-wider mb-3">
              Reschedules
            </h2>
            <ul className="space-y-2 ml-1">
              <li>
                &middot; Reschedule requests are accepted at the discretion of {brandName} staff
                and are subject to availability.
              </li>
              <li>
                &middot; Reschedule requests must be made outside the required notice window for
                your reservation type.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-bold text-sm uppercase tracking-wider mb-3">
              How to Cancel or Reschedule
            </h2>
            <ul className="space-y-2 ml-1">
              <li>
                &middot; All cancellation and reschedule requests must be submitted by{" "}
                <strong className="text-white">phone call or SMS text message</strong>.
              </li>
              {isHeadPinz ? (
                <>
                  <li>
                    &middot; HeadPinz Fort Myers:{" "}
                    <a href="tel:+12393022155" className="text-[#00E2E5] hover:underline">(239) 302-2155</a>
                  </li>
                  <li>
                    &middot; HeadPinz Naples:{" "}
                    <a href="tel:+12394553755" className="text-[#00E2E5] hover:underline">(239) 455-3755</a>
                  </li>
                </>
              ) : (
                <li>
                  &middot; FastTrax Entertainment:{" "}
                  <a href="tel:+12394819666" className="text-[#00E2E5] hover:underline">(239) 481-9666</a>
                </li>
              )}
              <li>
                &middot; Online cancellation requests (email, website form, social media) are
                not accepted and will not be processed.
              </li>
              <li>
                &middot; A cancellation is not confirmed until you receive a reply from
                {brandName} staff via phone or SMS.
              </li>
            </ul>
          </section>

          {!isHeadPinz && (
            <section>
              <h2 className="text-white font-bold text-sm uppercase tracking-wider mb-3">
                Race Packs &amp; Credits
              </h2>
              <ul className="space-y-2 ml-1">
                <li>
                  &middot; Race pack credits are added to the customer&apos;s FastTrax account
                  immediately upon confirmed payment and are{" "}
                  <strong className="text-white">non-refundable</strong> once applied.
                </li>
                <li>
                  &middot; Credits have no cash value and cannot be transferred to another
                  account.
                </li>
              </ul>
            </section>
          )}

          <section>
            <h2 className="text-white font-bold text-sm uppercase tracking-wider mb-3">
              Payment Disputes &amp; Chargebacks
            </h2>
            <ul className="space-y-2 ml-1">
              <li>
                &middot; Customers with a concern about a charge are required to contact{" "}
                {brandName} directly by <strong className="text-white">phone or SMS</strong>{" "}
                before initiating a dispute with their card issuer.
              </li>
              <li>
                &middot; {brandName} will make every effort to resolve billing concerns
                within one business day of contact.
              </li>
              <li>
                &middot; At the time of payment, customers affirmatively agree to this policy
                via an on-screen checkbox. A timestamped record of each acceptance — including
                IP address, device, booking details, and amount — is retained by {brandName}{" "}
                and may be provided to card issuers as evidence in any dispute proceeding.
              </li>
              <li>
                &middot; Initiating a chargeback without first contacting {brandName}, or for
                a booking that falls within the non-refundable window, may result in the
                dispute being contested with supporting documentation.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-bold text-sm uppercase tracking-wider mb-3">
              Contact
            </h2>
            {isHeadPinz ? (
              <ul className="space-y-1 ml-1">
                <li>
                  &middot; HeadPinz Fort Myers &middot;{" "}
                  <a href="tel:+12393022155" className="text-[#00E2E5] hover:underline">(239) 302-2155</a>
                  {" "}&middot;{" "}
                  <a href="https://headpinz.com" className="text-[#00E2E5] hover:underline">headpinz.com</a>
                </li>
                <li>
                  &middot; HeadPinz Naples &middot;{" "}
                  <a href="tel:+12394553755" className="text-[#00E2E5] hover:underline">(239) 455-3755</a>
                </li>
              </ul>
            ) : (
              <p>
                FastTrax Entertainment &middot;{" "}
                <a href="tel:+12394819666" className="text-[#00E2E5] hover:underline">
                  (239) 481-9666
                </a>{" "}
                (phone or SMS) &middot;{" "}
                <a href="https://fasttraxent.com" className="text-[#00E2E5] hover:underline">
                  fasttraxent.com
                </a>
              </p>
            )}
          </section>

          <p className="text-white/30 text-xs border-t border-white/[0.06] pt-4">
            This policy applies to all reservations booked through {isHeadPinz ? "headpinz.com" : "fasttraxent.com"}.{" "}
            {brandName} reserves the right to update this policy at any time. The version
            agreed to at the time of booking governs that transaction.
          </p>

        </div>
      </div>
    </div>
  );
}
