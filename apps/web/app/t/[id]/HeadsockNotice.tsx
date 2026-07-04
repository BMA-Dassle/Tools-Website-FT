/**
 * Flashing "keep your headsock" notice — sits inside the ticket card
 * between the headsock-credit strip and the QR block, on both the
 * pre-race and checking-in states of /t/[id] and /g/[id]. That slot
 * is in the racer's eyeline while staff scans them in — the moment
 * the headsock is handed out.
 *
 * The `headsock-flash` animation class lives in TICKET_PULSE_CSS
 * (cards.tsx), which both views already inject; it pulses only the
 * background (not the text) and goes static under
 * prefers-reduced-motion.
 */
export default function HeadsockNotice() {
  return (
    <div className="headsock-flash border-t border-amber-400/45 px-4 py-2.5 text-center">
      <p className="text-amber-300 text-xs font-extrabold uppercase tracking-wider">
        Keep your headsock after your race
      </p>
      <p className="text-white/75 text-xs mt-0.5">
        Additional headsocks are <strong className="text-white">$3</strong>
      </p>
    </div>
  );
}
