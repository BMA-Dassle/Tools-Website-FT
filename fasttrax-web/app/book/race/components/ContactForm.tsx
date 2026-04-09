"use client";

import { useState } from "react";

export interface ContactInfo {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  smsOptIn: boolean;
}

interface ContactFormProps {
  initial: ContactInfo | null;
  onSubmit: (info: ContactInfo) => void;
  onBack: () => void;
}

function Field({ label, value, onChange, type = "text", placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-white/50 mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="
          w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3
          text-white placeholder-white/20 text-sm
          focus:outline-none focus:border-[#00E2E5]/60 focus:bg-white/8
          transition-all
        "
      />
    </div>
  );
}

export default function ContactForm({ initial, onSubmit, onBack }: ContactFormProps) {
  const [firstName, setFirstName] = useState(initial?.firstName ?? "");
  const [lastName, setLastName] = useState(initial?.lastName ?? "");
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [smsOptIn, setSmsOptIn] = useState(initial?.smsOptIn ?? true);
  const [errors, setErrors] = useState<Partial<Record<keyof ContactInfo, string>>>({});

  function validate() {
    const e: typeof errors = {};
    if (!firstName.trim()) e.firstName = "Required";
    if (!lastName.trim()) e.lastName = "Required";
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = "Valid email required";
    if (!phone.trim() || phone.replace(/\D/g, "").length < 10) e.phone = "Valid phone required";
    return e;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    onSubmit({ firstName, lastName, email, phone, smsOptIn });
  }

  return (
    <div className="space-y-6 max-w-md mx-auto">
      <div className="text-center">
        <h2 className="text-2xl font-display text-white uppercase tracking-widest mb-2">Your Details</h2>
        <p className="text-white/50 text-sm">We'll send your confirmation and receipt here.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Field label="First Name" value={firstName} onChange={setFirstName} placeholder="Jane" />
            {errors.firstName && <p className="text-red-400 text-xs mt-1">{errors.firstName}</p>}
          </div>
          <div>
            <Field label="Last Name" value={lastName} onChange={setLastName} placeholder="Smith" />
            {errors.lastName && <p className="text-red-400 text-xs mt-1">{errors.lastName}</p>}
          </div>
        </div>

        <div>
          <Field label="Email Address" value={email} onChange={setEmail} type="email" placeholder="jane@example.com" />
          {errors.email && <p className="text-red-400 text-xs mt-1">{errors.email}</p>}
        </div>

        <div>
          <Field label="Phone Number" value={phone} onChange={setPhone} type="tel" placeholder="(239) 555-0100" />
          {errors.phone && <p className="text-red-400 text-xs mt-1">{errors.phone}</p>}
        </div>

        <label className="flex items-center gap-3 cursor-pointer group">
          <input
            type="checkbox"
            checked={smsOptIn}
            onChange={(e) => setSmsOptIn(e.target.checked)}
            className="w-4 h-4 rounded border-white/20 bg-white/5 text-[#00E2E5] focus:ring-[#00E2E5]/50 focus:ring-offset-0 cursor-pointer accent-[#00E2E5]"
          />
          <span className="text-sm text-white/50 group-hover:text-white/70 transition-colors">
            Send me a text confirmation
          </span>
        </label>

        <div className="rounded-xl border border-white/8 bg-white/3 p-4 text-xs text-white/40 leading-relaxed">
          Your contact info is used to create your FastTrax racer profile and attach your booking.
          Payment is handled securely by Square.
        </div>

        <div className="flex items-center justify-between gap-4 pt-2">
          <button type="button" onClick={onBack} className="text-sm text-white/40 hover:text-white/70 transition-colors">
            ← Back
          </button>
          <button
            type="submit"
            className="inline-flex items-center gap-2 px-8 py-3 rounded-xl font-bold text-sm bg-[#00E2E5] text-[#000418] hover:bg-white transition-colors shadow-lg shadow-[#00E2E5]/25"
          >
            Review Order →
          </button>
        </div>
      </form>
    </div>
  );
}
