"use client";

/**
 * License-scan match picker — when a scanned driver's license matches MORE
 * than one account (duplicate records, twins sharing a last name + DOB), the
 * guest taps theirs. Reuses the returning-racer AccountCard so this looks
 * exactly like the OTP sign-in's account selection (owner 2026-07-23: "use
 * our existing return racer selector"). Single-select only — one physical ID
 * is one person.
 *
 * Overlay pattern mirrors the People step's guardian overlay (fixed, z-[76],
 * #000418) so it sits above the roster but below nothing it shouldn't.
 */
import { AccountCard } from "~/components/features/booking/steps/race/ReturningRacerLookup";
import type { LicenseMatch } from "../license/types";

export function LicenseMatchPicker({
  firstName,
  matches,
  busy = false,
  onPick,
  onNewInstead,
  onCancel,
}: {
  /** Scanned given name — personalizes the heading. */
  firstName: string;
  matches: LicenseMatch[];
  /** True while a pick is being applied — blocks double taps. */
  busy?: boolean;
  onPick: (match: LicenseMatch) => void;
  /** "None of these" — fall through to the prefilled new-player form. */
  onNewInstead: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[76] overflow-y-auto bg-[#000418] p-[48px]">
      <div className="mx-auto max-w-[900px] space-y-[28px]">
        <div>
          <div className="k-eyebrow text-[#00e2e5]">License scanned</div>
          <h2 className="k-display mt-[8px] text-[44px]">
            Welcome back
            {firstName ? (
              <>
                , <span style={{ textTransform: "none" }}>{firstName}</span>
              </>
            ) : null}{" "}
            — which account is yours?
          </h2>
          <p className="mt-[10px] text-[24px] text-white/55">
            More than one account matches your name and birthday. Tap yours to sign in.
          </p>
        </div>

        <div className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${busy ? "opacity-50" : ""}`}>
          {matches.map((m) => (
            <AccountCard key={m.personId} account={m} onSelect={() => !busy && onPick(m)} />
          ))}
        </div>

        <div className="grid grid-cols-2 gap-[16px]">
          <button
            type="button"
            disabled={busy}
            onClick={onNewInstead}
            className="k-tap rounded-[28px] border-2 border-dashed border-[#00e2e5]/45 px-[24px] py-[24px] text-[26px] font-bold text-[#00e2e5]"
          >
            None of these — set me up as new
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="k-tap rounded-[28px] border-2 border-white/15 px-[24px] py-[24px] text-[26px] font-semibold text-white/60"
          >
            ← Back
          </button>
        </div>
      </div>
    </div>
  );
}
