"use client";

import type { StepDef } from "~/features/booking";

/**
 * Contact info — a shared FIRST step across booking flows (race, attraction,
 * bowling) so we always capture a base level of customer info up front, before
 * anything is booked.
 *
 * Why up front: BMI bills are created early (race heats book on heat-picker
 * advance; attraction slots on slot advance). Collecting + REQUIRING contact
 * before that means the customer is attached the moment a bill is created
 * (registerContact at bill creation), so a reservation never exists without a
 * customer. The wizard Next is gated until firstName/lastName/email/phone valid.
 *
 * Kind-agnostic — reads/writes session.contact only (never the item). For race,
 * it sits right after the party step so a returning racer's verified lookup
 * (RacePartyStep dispatches setContact) pre-fills it. KBF is excluded — its
 * KbfIdentityStep already captures the parent's email/phone (COPPA).
 *
 * v1 parity: same fields as the v1 ContactForm (app/book/checkout); the customer
 * attaches via registerContactPerson.
 */

const inputClass =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/30 outline-none transition-colors focus:border-[#00E2E5]/60";

export function contactIsComplete(contact: {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}): boolean {
  return (
    !!contact.firstName?.trim() &&
    !!contact.lastName?.trim() &&
    !!contact.email?.includes("@") &&
    (contact.phone ?? "").replace(/\D/g, "").length >= 10
  );
}

const ContactStepComponent: StepDef["Component"] = ({ session, dispatch }) => {
  const c = session.contact;
  const smsOptIn = c.smsOptIn ?? true;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="text-center">
        <h2 className="font-display text-2xl tracking-widest text-white uppercase">Your Info</h2>
        <p className="mt-1 text-sm text-white/40">
          We&apos;ll send your confirmation and check-in details here.
        </p>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="contact-first"
              className="mb-1 block text-xs font-semibold text-white/50"
            >
              First name
            </label>
            <input
              id="contact-first"
              type="text"
              value={c.firstName ?? ""}
              onChange={(e) =>
                dispatch({ type: "setContact", patch: { firstName: e.target.value } })
              }
              className={inputClass}
              placeholder="First name"
            />
          </div>
          <div>
            <label
              htmlFor="contact-last"
              className="mb-1 block text-xs font-semibold text-white/50"
            >
              Last name
            </label>
            <input
              id="contact-last"
              type="text"
              value={c.lastName ?? ""}
              onChange={(e) =>
                dispatch({ type: "setContact", patch: { lastName: e.target.value } })
              }
              className={inputClass}
              placeholder="Last name"
            />
          </div>
        </div>
        <div>
          <label htmlFor="contact-email" className="mb-1 block text-xs font-semibold text-white/50">
            Email
          </label>
          <input
            id="contact-email"
            type="email"
            value={c.email ?? ""}
            onChange={(e) => dispatch({ type: "setContact", patch: { email: e.target.value } })}
            className={inputClass}
            placeholder="email@example.com"
          />
        </div>
        <div>
          <label htmlFor="contact-phone" className="mb-1 block text-xs font-semibold text-white/50">
            Phone
          </label>
          <input
            id="contact-phone"
            type="tel"
            value={c.phone ?? ""}
            onChange={(e) => dispatch({ type: "setContact", patch: { phone: e.target.value } })}
            className={inputClass}
            placeholder="(555) 555-1234"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={smsOptIn}
            onChange={(e) =>
              dispatch({ type: "setContact", patch: { smsOptIn: e.target.checked } })
            }
            className="h-4 w-4 rounded border-white/20 bg-white/5 accent-[#00E2E5]"
          />
          <span className="text-xs text-white/50">
            Send me a text confirmation &amp; check-in reminder
          </span>
        </label>
      </div>
    </div>
  );
};

export const ContactStep: StepDef = {
  id: "contact",
  title: "Your Info",
  Component: ContactStepComponent,
  // ALWAYS visible — so it stays in the breadcrumb and the customer can click
  // back to review/edit. The "don't re-ask" behavior (returning-racer pre-fill,
  // later cart items inheriting the session contact) is handled by BookingFlow
  // SKIPPING this step on FORWARD navigation when contactIsComplete. That skip
  // is nav-time, not render-time, so a customer typing into the form is never
  // auto-advanced when the last field becomes valid.
  isVisible: () => true,
  canAdvance: (_item, session) =>
    contactIsComplete(session.contact) ? true : { reason: "Enter your contact info to continue." },
};
