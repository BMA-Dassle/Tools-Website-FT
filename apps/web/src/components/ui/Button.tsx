"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import Spinner from "./Spinner";

type Variant = "primary" | "secondary" | "ghost";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
}

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-full text-sm font-bold uppercase tracking-widest transition px-6 py-3 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--account-accent,#00e2e5)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-[color:var(--account-accent,#00e2e5)] text-[#06121a] hover:brightness-110",
  secondary: "border border-white/20 text-white/80 hover:border-white/40",
  ghost: "text-white/60 hover:text-white",
};

const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "primary", loading = false, disabled, type, children, className = "", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      className={`${BASE} ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {loading && <Spinner className="text-current" />}
      {children}
    </button>
  );
});

export default Button;
