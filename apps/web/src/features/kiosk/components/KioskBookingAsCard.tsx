"use client";

/**
 * "Booking as" card for the kiosk merged checkout (owner 2026-07-21) —
 * kiosk-native at canvas px. The contact is normally already complete (every
 * player gives name/phone/email at add time and the main person seeds
 * session.contact), so this renders as a slim summary with a Change action;
 * the inline 4-field editor opens automatically only when something is
 * missing (e.g. a walk-up path that skipped email). Typing rides the global
 * OnScreenKeyboardHost — no per-field wiring needed.
 */

import { useState } from "react";
import type { Dispatch } from "react";
import type { Action } from "~/features/booking/state/machine";
import type { BookingSession } from "~/features/booking";
import { contactIsComplete } from "~/components/features/booking/steps/ContactStep";
import { useT } from "../i18n";

const FIELD_CLS =
  "w-full rounded-2xl border border-white/12 bg-white/5 px-[24px] py-[18px] text-[28px] text-white placeholder-white/25 outline-none transition-colors focus:border-[#00e2e5]/60";

export function KioskBookingAsCard({
  session,
  dispatch,
}: {
  session: BookingSession;
  dispatch: Dispatch<Action>;
}) {
  const t = useT();
  const c = session.contact;
  const [editing, setEditing] = useState(() => !contactIsComplete(c));
  const [firstName, setFirstName] = useState(c.firstName ?? "");
  const [lastName, setLastName] = useState(c.lastName ?? "");
  const [email, setEmail] = useState(c.email ?? "");
  const [phone, setPhone] = useState(c.phone ?? "");
  const [smsOptIn, setSmsOptIn] = useState(c.smsOptIn ?? true);

  const draftValid = contactIsComplete({ firstName, lastName, email, phone });

  const save = () => {
    if (!draftValid) return;
    dispatch({
      type: "setContact",
      patch: {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email,
        phone,
        smsOptIn,
        // A manually edited phone is no longer OTP-proven — rewards must
        // re-verify before redeeming against the new number.
        ...(phone !== (c.phone ?? "") ? { phoneVerified: false } : {}),
      },
    });
    setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="k-glass k-tap flex w-full items-center justify-between gap-[24px] p-[32px] text-left"
      >
        <div className="min-w-0">
          <p className="k-eyebrow">{t("bookingAs.label")}</p>
          <p className="mt-[6px] truncate text-[34px] font-bold text-white">
            {c.firstName} {c.lastName}
          </p>
          <p className="truncate text-[24px] text-white/50">
            {[c.email, c.phone].filter(Boolean).join(" · ")}
          </p>
          {(c.smsOptIn ?? true) && (
            <p className="mt-[4px] text-[22px] text-[#46d68c]">{t("bookingAs.textOn")}</p>
          )}
        </div>
        <span className="shrink-0 text-[26px] font-bold uppercase tracking-wider text-[#00e2e5]">
          {t("bookingAs.change")}
        </span>
      </button>
    );
  }

  return (
    <div className="k-glass w-full space-y-[20px] p-[32px]">
      <p className="k-eyebrow">{t("bookingAs.label")}</p>
      <div className="grid grid-cols-2 gap-[16px]">
        <label className="block">
          <span className="mb-[6px] block text-[22px] font-semibold text-white/50">
            {t("bookingAs.firstName")}
          </span>
          <input
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className={FIELD_CLS}
            placeholder={t("bookingAs.firstName")}
          />
        </label>
        <label className="block">
          <span className="mb-[6px] block text-[22px] font-semibold text-white/50">
            {t("bookingAs.lastName")}
          </span>
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className={FIELD_CLS}
            placeholder={t("bookingAs.lastName")}
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-[6px] block text-[22px] font-semibold text-white/50">
          {t("bookingAs.email")}
        </span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={FIELD_CLS}
          placeholder="email@example.com"
        />
      </label>
      <label className="block">
        <span className="mb-[6px] block text-[22px] font-semibold text-white/50">
          {t("bookingAs.mobilePhone")}
        </span>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className={FIELD_CLS}
          placeholder="(555) 555-1234"
        />
      </label>
      <label className="flex cursor-pointer items-center gap-[16px]">
        <input
          type="checkbox"
          checked={smsOptIn}
          onChange={(e) => setSmsOptIn(e.target.checked)}
          className="h-[36px] w-[36px] rounded border-white/20 bg-white/5 accent-[#00e2e5]"
        />
        <span className="text-[24px] text-white/60">{t("bookingAs.smsOptIn")}</span>
      </label>
      <button
        type="button"
        onClick={save}
        disabled={!draftValid}
        className="k-tap h-[84px] w-full rounded-full bg-[#00e2e5] text-[28px] font-extrabold uppercase tracking-wider text-[#04252b] disabled:opacity-40"
      >
        {t("bookingAs.done")}
      </button>
    </div>
  );
}
