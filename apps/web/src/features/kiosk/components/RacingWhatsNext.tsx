"use client";

/**
 * Racing "what's next" panel + the big red "How does race check-in work?" button
 * and its race-check-in details popup. Lifted out of KioskConfirmation so the
 * self-service CHECK-IN done screen shows the SAME affordance a race booking does
 * (owner 2026-07-25). Self-contained (owns its popup state); pass `intro` for the
 * context-appropriate lead line and `onOpen` for analytics.
 *
 * NOTE: KioskConfirmation still has its own inline copy of this — de-duping that
 * into this component is a documented follow-up (it's a hot multi-writer file).
 */
import { useState, type ReactNode } from "react";

const RACE_ICON_PROPS = {
  width: 40,
  height: 40,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "#e53935",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

const RACE_CHECKIN_STEPS: { title: string; body: ReactNode; icon: ReactNode }[] = [
  {
    title: "eTicket by text",
    body: (
      <>
        Arrives shortly after checkout.{" "}
        <strong className="text-white">Have it open at Race Check-In.</strong>
      </>
    ),
    icon: (
      <svg {...RACE_ICON_PROPS}>
        <path d="M21 11.5a8.38 8.38 0 0 1-9 8.35 8.5 8.5 0 0 1-3.4-.7L3 20l1.1-4.1A8.38 8.38 0 0 1 3 11.5a8.5 8.5 0 0 1 8.5-8.5 8.38 8.38 0 0 1 9.5 8.5z" />
      </svg>
    ),
  },
  {
    title: "Where",
    body: (
      <>
        <strong className="text-white">1st floor, left side of the Red Track.</strong> All tracks
        and race types check in there.
      </>
    ),
    icon: (
      <svg {...RACE_ICON_PROPS}>
        <path d="M12 21s-7-5.3-7-11a7 7 0 0 1 14 0c0 5.7-7 11-7 11z" />
        <circle cx="12" cy="10" r="2.6" />
      </svg>
    ),
  },
  {
    title: "When",
    body: (
      <>
        Be there <strong className="text-white">about 5 minutes before your race</strong> —
        we&rsquo;ll text you and call it over the intercom. It&rsquo;s live racing, so delays can
        happen.
      </>
    ),
    icon: (
      <svg {...RACE_ICON_PROPS}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </svg>
    ),
  },
  {
    title: "Allow about 30 minutes",
    body: <>Briefing video, lockers for your stuff (in the briefing room), and safety gear.</>,
    icon: (
      <svg {...RACE_ICON_PROPS}>
        <path d="M12 3a9 9 0 0 1 9 9c0 1.5-.6 2-2 2h-3.5l-1 4h-5l-1-4H5c-1.4 0-2-.5-2-2a9 9 0 0 1 9-9z" />
        <path d="M8 12h8" />
      </svg>
    ),
  },
  {
    title: "Keep your head sock",
    body: (
      <>
        It&rsquo;s included with your license —{" "}
        <strong className="text-white">replacements cost extra.</strong>
      </>
    ),
    icon: (
      <svg {...RACE_ICON_PROPS}>
        <path d="M9 3h6v4a3 3 0 0 1-3 3 3 3 0 0 1-3-3z" />
        <path d="M9 5c-2 1-3.5 3.5-3.5 7 0 5 2 9 6.5 9s6.5-4 6.5-9c0-3.5-1.5-6-3.5-7" />
      </svg>
    ),
  },
];

const RED_BTN_STYLE = {
  flex: "0 0 auto",
  background: "#e53935",
  color: "#fff",
  boxShadow: "0 12px 44px rgba(229,57,53,0.35)",
} as const;

export function RacingWhatsNext({
  intro,
  onOpen,
  /** Drop the 860px cap so the panel matches the cards around it. The cap suits
   *  the web confirmation column; on the kiosk's wider canvas it left this
   *  panel visibly narrower than every sibling card (owner 2026-08-07: "the red
   *  box doesn't go all the way"). Opt-in, so no other caller shifts. */
  fullWidth = false,
}: {
  intro?: ReactNode;
  onOpen?: () => void;
  fullWidth?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div
        className={`relative w-full ${fullWidth ? "" : "max-w-[860px]"} rounded-[24px] border border-[#e53935]/45 bg-gradient-to-b from-[#e53935]/10 to-white/[0.03] p-[32px] text-left`}
      >
        <div className="k-eyebrow flex items-center gap-[14px] text-[#e53935]">
          <svg
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#e53935"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 21V4" />
            <path d="M4 4c3-1.5 6 1.5 9 0s5-1 7 0v9c-2-1-4-1.5-7 0s-6-1.5-9 0" />
          </svg>
          Racing — what&rsquo;s next
        </div>
        <p className="mt-[14px] text-[31px] leading-snug text-white/85">
          {intro ?? (
            <>
              Your race <strong className="text-[#ffd9d8]">eTicket arrives by text</strong> in a few
              minutes — have it open at{" "}
              <strong className="text-[#ffd9d8]">
                Race Check-In: 1st floor, left of the Red Track.
              </strong>
            </>
          )}
        </p>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            onOpen?.();
          }}
          style={RED_BTN_STYLE}
          className="k-btn-primary k-tap mt-[26px] w-full"
        >
          How does race check-in work?
          <svg
            width="34"
            height="34"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#000418]/85 p-[56px]">
          <div className="max-h-full w-full overflow-y-auto rounded-[28px] border border-white/15 bg-[#071027]/95 p-[48px] text-left shadow-[0_40px_120px_rgba(0,0,0,0.6)]">
            <div className="k-eyebrow text-[#e53935]">Race check-in</div>
            <h2 className="k-display mt-[10px] text-[64px]">What to expect</h2>
            <div className="mt-[30px] flex flex-col gap-[22px]">
              {RACE_CHECKIN_STEPS.map((step) => (
                <div
                  key={step.title}
                  className="flex items-start gap-[24px] rounded-[20px] border border-white/10 bg-white/[0.03] px-[28px] py-[24px]"
                >
                  <div className="flex h-[72px] w-[72px] flex-none items-center justify-center rounded-[18px] border border-[#e53935]/40 bg-[#e53935]/15">
                    {step.icon}
                  </div>
                  <div className="min-w-0">
                    <div className="text-[30px] font-extrabold leading-tight">{step.title}</div>
                    <p className="mt-[6px] text-[26px] leading-snug text-white/70">{step.body}</p>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={RED_BTN_STYLE}
              className="k-btn-primary k-tap mt-[34px] w-full"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
