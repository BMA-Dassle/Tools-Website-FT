"use client";

import { forwardRef, useId, type InputHTMLAttributes } from "react";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { label, error, hint, id, className = "", ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id || autoId;
  const errId = `${inputId}-err`;
  const hintId = `${inputId}-hint`;
  const describedBy = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(" ");

  return (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-white/70">
        {label}
      </label>
      <input
        id={inputId}
        ref={ref}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`w-full rounded-lg border bg-white/5 px-3 py-2.5 text-white placeholder-white/30 focus:outline-none focus:border-[color:var(--account-accent,#00e2e5)] ${
          error ? "border-red-500/60" : "border-white/15"
        } ${className}`}
        {...rest}
      />
      {hint && !error && (
        <p id={hintId} className="mt-1 text-xs text-white/40">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} role="alert" className="mt-1 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
});

export default Input;
