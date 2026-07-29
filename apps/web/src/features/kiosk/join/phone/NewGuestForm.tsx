"use client";

/**
 * New adult guest form — mirrors the kiosk's submitNew validation (name, DOB
 * MM/DD/YYYY, mobile required) minus the minor/guardian branches: this page
 * is adults-only, so under-18 routes to the blocked-minor screen instead.
 * Email is optional — a phone joiner is never the booking's main contact.
 */
import { useState } from "react";
import { ageFromDob, formatDobInput, formatPhoneInput, toIsoDob } from "./join-helpers";
import { useT } from "../../i18n";

export interface NewGuestFields {
  firstName: string;
  lastName: string;
  dobIso: string;
  phone: string;
  email?: string;
}

interface Props {
  busy: boolean;
  onSubmit: (fields: NewGuestFields) => void;
  onMinor: (firstName: string) => void;
  onBack: () => void;
}

const inputClass =
  "w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-base text-white placeholder-white/30 outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]";
const labelClass = "mb-1 block text-sm font-semibold text-white/70";

export function NewGuestForm({ busy, onSubmit, onMinor, onBack }: Props) {
  const t = useT();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (busy) return;
    if (!firstName.trim() || !lastName.trim()) {
      setError(t("join.err.name"));
      return;
    }
    const age = ageFromDob(dob);
    if (age === null) {
      setError(t("join.err.dob"));
      return;
    }
    if (age < 18) {
      onMinor(firstName.trim());
      return;
    }
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) {
      setError(t("join.err.phone"));
      return;
    }
    if (email.trim() && !email.includes("@")) {
      setError(t("join.err.email"));
      return;
    }
    setError(null);
    onSubmit({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      dobIso: toIsoDob(dob),
      phone: phone.trim(),
      email: email.trim() || undefined,
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-4"
      noValidate
    >
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="join-first" className={labelClass}>
            {t("join.firstName")}
          </label>
          <input
            id="join-first"
            className={inputClass}
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoComplete="given-name"
            autoCapitalize="words"
            required
          />
        </div>
        <div>
          <label htmlFor="join-last" className={labelClass}>
            {t("join.lastName")}
          </label>
          <input
            id="join-last"
            className={inputClass}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
            autoCapitalize="words"
            required
          />
        </div>
      </div>
      <div>
        <label htmlFor="join-dob" className={labelClass}>
          {t("join.birthday")}
        </label>
        <input
          id="join-dob"
          className={inputClass}
          value={dob}
          onChange={(e) => setDob(formatDobInput(e.target.value))}
          placeholder="MM/DD/YYYY"
          inputMode="numeric"
          autoComplete="bday"
          required
        />
      </div>
      <div>
        <label htmlFor="join-phone" className={labelClass}>
          {t("join.mobilePhone")}
        </label>
        <input
          id="join-phone"
          className={inputClass}
          value={phone}
          onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
          placeholder="(239) 555-1234"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
        />
      </div>
      <div>
        <label htmlFor="join-email" className={labelClass}>
          {t("join.email")} <span className="font-normal text-white/40">{t("join.optional")}</span>
        </label>
        <input
          id="join-email"
          className={inputClass}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          inputMode="email"
          autoComplete="email"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm font-semibold text-amber-300">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-xl bg-[var(--accent)] px-4 py-3 text-base font-bold text-[#04252b] disabled:opacity-50"
      >
        {busy ? t("join.settingUp") : t("join.continueToWaiver")}
      </button>
      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="w-full py-2 text-center text-sm text-white/40"
      >
        ← {t("join.back")}
      </button>
    </form>
  );
}
