import type { ReactNode } from "react";

/**
 * `repAvatar(id, sm)` from crm-shared.js:205: initials in a circle, tinted per
 * rep slug (`.avatar.rep-kelsea` …); no rep → "?" titled "Unassigned". Pass
 * `icon` for the prototype's grey icon avatars (`.avatar` with an svg inside).
 */
export interface AvatarProps {
  initials?: string;
  /** crm_reps.slug — picks the per-rep tint. */
  repSlug?: string | null;
  /** Full name for the tooltip. */
  name?: string;
  sm?: boolean;
  icon?: ReactNode;
  className?: string;
}

export function Avatar({ initials, repSlug, name, sm = false, icon, className }: AvatarProps) {
  const cls = ["avatar", sm ? "sm" : "", repSlug ? `rep-${repSlug}` : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const title = name ?? (initials ? undefined : "Unassigned");
  return (
    <span className={cls} title={title}>
      {icon ?? initials ?? "?"}
    </span>
  );
}
