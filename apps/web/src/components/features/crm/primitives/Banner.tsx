import type { ReactNode } from "react";

/**
 * `.banner.{info|warn|crit|good}` (crm-core.css:258-262): an icon, the text in
 * a `.bt` span that wraps on the phone, and optional buttons on the right.
 */
export type BannerTone = "info" | "warn" | "crit" | "good";

export interface BannerProps {
  tone: BannerTone;
  icon?: ReactNode;
  actions?: ReactNode;
  /** `role="alert"` for crit, `status` otherwise; override when needed. */
  role?: "alert" | "status" | "none";
  className?: string;
  testId?: string;
  children: ReactNode;
}

export function Banner({ tone, icon, actions, role, className, testId, children }: BannerProps) {
  const r = role ?? (tone === "crit" ? "alert" : "status");
  return (
    <div
      className={["banner", tone, className ?? ""].filter(Boolean).join(" ")}
      role={r === "none" ? undefined : r}
      data-testid={testId}
    >
      {icon ?? null}
      <span className="bt">{children}</span>
      {actions ?? null}
    </div>
  );
}
