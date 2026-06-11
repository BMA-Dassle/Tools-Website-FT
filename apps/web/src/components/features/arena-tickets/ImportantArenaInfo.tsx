/**
 * Important arena info banner shown above the ticket card on arena
 * /t/[id] and /g/[id] views. Same rationale as the racing
 * ImportantRaceInfo: keep the SMS body under 2 segments (carrier
 * rejection lesson) and surface the full instructions on the page.
 *
 * Hidden on the past state (session already ran).
 *
 * NOTE: copy pending owner sign-off (step 0d in the rollout plan) —
 * defaults below are conservative and match what the HP Arena desk
 * tells walk-ins today.
 */
export default function ImportantArenaInfo() {
  return (
    <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/[0.08] px-4 py-3.5 text-sm">
      <p className="text-amber-300 text-[11px] font-bold uppercase tracking-widest mb-2">
        Please read — important session info
      </p>
      <ul className="space-y-2 text-white/85 text-[13px] leading-snug">
        <li>
          Arrive at the <strong className="text-white">HP Arena desk 15 minutes early</strong> to
          check in and gear up. Late arrivals may not be able to join their session —{" "}
          <strong className="text-white">missed sessions are non-refundable</strong>.
        </li>
        <li>
          Have your e-ticket <strong className="text-white">open and ready</strong> at the desk — no
          paper ticket needed.
        </li>
        <li>
          Every player needs a <strong className="text-white">signed waiver</strong> on file —
          parents/guardians sign for players under 18.
        </li>
        <li>Closed-toe shoes are required. Lockers are available for loose items.</li>
      </ul>
    </div>
  );
}
