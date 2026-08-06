"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ReturningRacerLookup,
  type PersonData,
} from "~/components/features/booking/steps/race/ReturningRacerLookup";

/**
 * `/racer` — the way in to your own page when you have no link.
 *
 * NOT AN EXTRA STEP FOR ANYONE WHO HAS A LINK. A racer arriving from their
 * confirmation, their e-ticket or their wallet pass goes straight to
 * `/r/{code}` and is never asked to identify themselves — possession of the
 * code is the identity there, the same posture as `/v/{code}`. This page exists
 * only for the racer who has none of those in front of them: they came to the
 * site cold and want their licence.
 *
 * Reuses the returning-racer lookup the booking flow already uses, so there is
 * one identity flow on the site rather than a second one to keep in step. It
 * already offers all three routes in — phone, email, and login code — with the
 * OTP on the first two.
 */
export default function RacerSignInPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const goToHub = (person: PersonData) => {
    const code = String(person?.loginCode ?? "").trim();
    if (!code) {
      // A record with no tag yet — nothing to build a page around, and the
      // barcode would be empty. Say so rather than routing to a broken page.
      setError(
        "We found your account, but you don’t have a licence code yet — it’s created the first time you race.",
      );
      return;
    }
    router.push(`/r/${encodeURIComponent(code)}`);
  };

  return (
    // A SECTION, NOT A <main>. The root layout already wraps every page in one,
    // and this was the only route on the site rendering a second one inside it —
    // invalid nesting, two landmarks for a screen reader to choose between.
    //
    // `pb-28` clears the fixed mobile Book-Now bar. It should not be on this
    // page at all (middleware suppresses it), but the padding costs nothing and
    // means the last control is reachable even if that rule is ever missed
    // again — which is exactly how this page became untappable on iPhone.
    <section className="min-h-screen bg-[#00041b] px-4 pb-28 pt-32">
      <div className="mx-auto w-full max-w-md">
        <header className="text-center mb-7">
          <p className="font-display text-[11px] uppercase tracking-[0.25em] text-[#00E2E5]">
            FastTrax Racing Licence
          </p>
          <h1 className="mt-2 text-3xl sm:text-4xl font-display uppercase tracking-widest text-white">
            Find my licence
          </h1>
          <p className="mt-3 text-white/50 text-sm leading-relaxed">
            Your licence is your check-in code, your kiosk sign-in and your register login. Look it
            up with your phone, email, or the code itself.
          </p>
        </header>

        {error && (
          <div className="mb-5 rounded-2xl border border-[#f0b341]/40 bg-[#f0b341]/10 px-4 py-3">
            <p className="text-[#f0b341] text-sm leading-relaxed">{error}</p>
          </div>
        )}

        <ReturningRacerLookup
          onVerified={goToHub}
          // A household sharing a phone or email matches several accounts; the
          // first is the one whose page was asked for, and each of the others
          // can look themselves up the same way.
          onVerifiedMultiple={(people: PersonData[]) => people[0] && goToHub(people[0])}
          // "I'm new" here means there is no licence to find yet — send them to
          // book, which is where a first race (and therefore a first tag) comes
          // from. In the booking flow this switches to the new-racer form; on a
          // standalone lookup page there is no form to switch to.
          onSwitchToNew={() => router.push("/book/race")}
        />
      </div>
    </section>
  );
}
