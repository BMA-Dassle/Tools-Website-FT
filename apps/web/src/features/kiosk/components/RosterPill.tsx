"use client";

/**
 * The small cyan pill on a roster card — "Add to wallet", "3 family members",
 * "Today's Crew · 5" — in ONE component so the two people screens stop
 * drifting (they carried the same pill at 18/8/20px and 20/10/22px).
 *
 * The PENDING state is the point (owner 2026-09-06: the family pill "randomly
 * appeared" whenever its fetch landed — "there should be some loading
 * indication first"). The lookup starts the instant a sign-in lands, so the
 * pill is drawn at once, dimmed, with a spinner where the icon goes and a
 * short label ("Family…", "Today's Crew…" — the spinner already says
 * "checking"; the long form wrapped the row). It then resolves IN PLACE to the
 * live pill or leaves. Pending pills are disabled and `aria-busy`.
 *
 * Metrics match LicenceWalletChip's closed state so the three read as one row.
 */
import type { ReactNode } from "react";

export function RosterPill({
  icon,
  label,
  pending = false,
  onClick,
  ariaLabel,
}: {
  icon: ReactNode;
  label: string;
  pending?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      disabled={pending}
      aria-busy={pending || undefined}
      aria-label={ariaLabel}
      onClick={pending ? undefined : onClick}
      className={`k-tap inline-flex shrink-0 items-center gap-[10px] rounded-full border border-[#00e2e5]/40 bg-[#00e2e5]/10 px-[18px] py-[8px] text-[20px] font-semibold whitespace-nowrap text-[#00e2e5] ${
        pending ? "opacity-60" : ""
      }`}
    >
      {pending ? (
        <span
          aria-hidden="true"
          className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-[#00e2e5]/30 border-t-[#00e2e5]"
        />
      ) : (
        icon
      )}
      {label}
    </button>
  );
}

/** Two people — the linked-family pill. */
export const FAMILY_ICON = (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

/** A clock — "earlier today". The Today's Crew pill. */
export const CREW_ICON = (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
