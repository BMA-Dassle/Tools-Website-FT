import type { ReactNode } from "react";

/** Standard dark surface used across the account area. */
export default function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-white/10 bg-white/[0.03] ${className}`}>
      {children}
    </div>
  );
}
