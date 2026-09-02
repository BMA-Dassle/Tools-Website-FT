import Link from "next/link";
import { KBF_PROGRAM_END_YMD } from "@/lib/kbf-schedule";

/**
 * What `/hp/kids-bowl-free` shows once the KBF season has closed.
 *
 * This page is the terminus every other KBF URL redirects to off-season —
 * the booking wizard, the location chooser, the registration page, and via
 * middleware's v1→v2 cutover the legacy `/book/kids-bowl-free*` links that
 * still sit in old emails and in Google. So it has ONE job: tell a parent
 * who was promised free bowling that the program is between seasons, and
 * give them somewhere real to go instead. Never a 404 — a dead end here
 * reads as "this business vanished", not "come back in May".
 *
 * It replaces the marketing page rather than sitting alongside it because
 * the pitch itself ("register today", "book a lane") is the misleading part.
 */

/** "2026-08-28" → "August 28, 2026" — read off the schedule constant so the
 *  copy can never drift from the window the booking gate actually enforces. */
function longDate(ymd: string): string {
  // Noon UTC keeps the calendar date stable in every US timezone.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${ymd}T17:00:00Z`));
}

export default function KbfOffSeasonNotice() {
  return (
    <div className="bg-[#0a1628] min-h-[70vh] flex items-center">
      <section className="mx-auto w-full max-w-2xl px-6 py-20 text-center">
        <p className="font-body text-[#FFD700] text-xs uppercase tracking-[0.2em] mb-4">
          Between seasons
        </p>

        <h1
          className="font-heading text-white uppercase"
          style={{ fontSize: "clamp(28px, 6vw, 52px)", lineHeight: 1.05, marginBottom: "20px" }}
        >
          Kids Bowl Free is finished for the summer
        </h1>

        <p
          className="font-body text-white/75 mx-auto"
          style={{ fontSize: "clamp(15px, 2.2vw, 18px)", lineHeight: 1.6, marginBottom: "14px" }}
        >
          This year&rsquo;s program ended {longDate(KBF_PROGRAM_END_YMD)}, so there are no free
          lanes to reserve right now. Kids Bowl Free returns next summer at HeadPinz Fort Myers,
          HeadPinz Naples and FastTrax Fort Myers &mdash; check back in the spring and we&rsquo;ll
          have registration and lane booking open again.
        </p>

        <p className="font-body text-white/50 text-sm mb-10">
          Already had a lane booked for a date this summer? Your confirmation still stands &mdash;
          bring it to the front desk.
        </p>

        <div className="flex flex-wrap justify-center gap-3">
          <Link
            href="/book/bowling/v2"
            className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-body font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105"
            style={{ boxShadow: "0 0 20px rgba(253,91,86,0.3)" }}
          >
            Book bowling
          </Link>
          <Link
            href="/hp"
            className="inline-flex items-center text-white font-body font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105 border border-white/20 hover:border-white/40"
            style={{ backgroundColor: "rgba(255,255,255,0.1)" }}
          >
            HeadPinz home
          </Link>
        </div>
      </section>
    </div>
  );
}
