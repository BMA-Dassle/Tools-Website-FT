import type { ReactNode } from "react";
import type { CentreCode } from "~/features/crm/core/types";

/**
 * `.pill`, and `centreTag(id)` (crm-shared.js:206) when `centre` is given:
 * `<span class="pill c-HPFM">HP Fort Myers</span>`.
 */
export interface PillProps {
  centre?: CentreCode;
  title?: string;
  className?: string;
  children: ReactNode;
}

export function Pill({ centre, title, className, children }: PillProps) {
  const cls = ["pill", centre ? `c-${centre}` : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}
