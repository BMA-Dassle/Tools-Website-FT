import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Cancellation & Payment Policy – FastTrax Entertainment",
  description: "FastTrax Entertainment cancellation, refund, and payment policy for race reservations and race packs.",
  robots: { index: false, follow: false },
};

export default function CancellationPolicyPage() {
  return (
    <div className="min-h-screen bg-[#000418] pt-32 pb-20">
      <div className="max-w-3xl mx-auto px-4 sm:px-6">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-10 space-y-6 text-white/80 text-sm leading-relaxed font-body">

          <div className="text-center space-y-1">
            <p className="text-white/40 text-xs uppercase tracking-widest">FastTrax Entertainment</p>
            <h1 className="text-white font-bold text-lg sm:text-xl uppercase tracking-wider">
              Cancellation &amp; Payment Policy
            </h1>
            <p className="text-white/40 text-xs">Effective April 30, 2026</p>
          </div>

          <p>
            Race reservations at FastTrax Entertainment are confirmed immediately upon payment.
            By completing payment, the customer acknowledges and agrees to the terms of this policy.
          </p>

          <section>
            <h2 className="text-white font-bold text-sm uppercase tracking-wider mb-3">
              Cancellations &amp; Refunds
            </h2>
            <ul className="space-y-2 ml-1">
              <li>
                &middot; Cancellations must be requested{" "}
                <strong className="text-white">more than 2 hours</strong> before the
                scheduled race time to be eligible for a refund or credit toward a future visit.
              </li>
              <li>
                &middot; Cancellations made within{" "}
                <strong className="text-white">2 hours</strong> of the scheduled race time are{" "}
                <strong className="text-white">non-refundable</strong>, no exceptions.
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
                &middot; Reschedule requests are accepted at the discretion of FastTrax staff
                and are subject to availability.
              </li>
              <li>
                &middot; Reschedule requests must be made more than{" "}
                <strong className="text-white">2 hours</strong> before the scheduled race time.
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
                <strong className="text-white">phone call or SMS text message</strong> to{" "}
                <a href="tel:+12394819666" className="text-[#00E2E5] hover:underline">
                  (239) 481-9666
                </a>
                .
              </li>
              <li>
                &middot; Online cancellation requests (email, website form, social media) are
                not accepted and will not be processed.
              </li>
              <li>
                &middot; The cancellation is not confirmed until you receive a reply from
                FastTrax staff via phone or SMS.
              </li>
            </ul>
          </section>

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

          <section>
            <h2 className="text-white font-bold text-sm uppercase tracking-wider mb-3">
              Payment Disputes &amp; Chargebacks
            </h2>
            <ul className="space-y-2 ml-1">
              <li>
                &middot; Customers with a concern about a charge are required to contact
                FastTrax directly by{" "}
                <strong className="text-white">phone or SMS at{" "}
                <a href="tel:+12394819666" className="text-[#00E2E5] hover:underline">
                  (239) 481-9666
                </a></strong>{" "}
                before initiating a dispute with their card issuer.
              </li>
              <li>
                &middot; FastTrax will make every effort to resolve billing concerns within
                one business day of contact.
              </li>
              <li>
                &middot; At the time of payment, customers affirmatively agree to this policy
                via an on-screen checkbox. A timestamped record of each acceptance — including
                IP address, device, booking details, and amount — is retained by FastTrax
                and may be provided to card issuers as evidence in any dispute proceeding.
              </li>
              <li>
                &middot; Initiating a chargeback without first contacting FastTrax, or for
                a booking that falls within the non-refundable window, may result in the
                dispute being contested with supporting documentation.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-white font-bold text-sm uppercase tracking-wider mb-3">
              Contact
            </h2>
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
          </section>

          <p className="text-white/30 text-xs border-t border-white/[0.06] pt-4">
            This policy applies to all reservations booked through fasttraxent.com. FastTrax
            Entertainment reserves the right to update this policy at any time. The version
            agreed to at the time of booking governs that transaction.
          </p>

        </div>
      </div>
    </div>
  );
}
