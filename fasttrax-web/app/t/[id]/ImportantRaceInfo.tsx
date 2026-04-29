/**
 * Important race info banner shown above the ticket card on
 * /t/[id] and /g/[id]. The exact bullets used to live in the SMS
 * body — but multi-paragraph messages with all-caps headers were
 * being rejected by T-Mobile / Verizon as "code 4505: carrier
 * rejected message too long" (11+ segments). Moving the content
 * here keeps customers fully informed without relying on the
 * carrier to deliver a 1500-character SMS body.
 *
 * Visible on PreRaceCard, CheckingInCard, and InvalidCard states.
 * Hidden on PastCard (race already happened, info is moot).
 */
export default function ImportantRaceInfo() {
  return (
    <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/[0.08] px-4 py-3.5 text-sm">
      <p className="text-amber-300 text-[11px] font-bold uppercase tracking-widest mb-2">
        Please read — important race info
      </p>
      <ul className="space-y-2 text-white/85 text-[13px] leading-snug">
        <li>
          The time on your ticket is your <strong className="text-white">check-in cut-off</strong>.
          Arrive at the Karting check-in desk on the 1st Floor at least 5 min early.
          Miss check-in and we may not be able to reschedule —{" "}
          <strong className="text-white">missed races are non-refundable</strong>.
        </li>
        <li>
          Have your e-ticket <strong className="text-white">open and ready</strong> at check-in —
          staff scans the screen, no paper ticket needed.
        </li>
        <li>
          Allow ~30 min from check-in to race time for briefing, helmet fitting, and prep.
          Lockers are available in the briefing rooms.{" "}
          <strong className="text-white">No loose items on the track.</strong>
        </li>
        <li>
          This is live racing — yellow flags or track conditions may cause delays.
          We&apos;ll announce upcoming races.
        </li>
      </ul>
    </div>
  );
}
