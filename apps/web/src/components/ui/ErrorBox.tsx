import type { ReactNode } from "react";

/** Inline error banner — matches the established `border-red-500/40` style. */
export default function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200"
    >
      {children}
    </div>
  );
}
