"use client";

import { IconArrowLeft } from "@tabler/icons-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { PublicCrmUser } from "~/features/crm/core/contracts";
import { Avatar } from "../primitives/Avatar";
import { ICON } from "../primitives/icon-props";
import type { CrmTheme } from "../lib/theme";
import { initialsOf } from "../lib/use-crm-user";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The topbar (`standardShell`, crm-shared.js:157): optional back link, the
 * screen title and sub-line, and an `.actions` slot a screen portals its
 * buttons into (`useTopbarSlot()`); the person chip + a theme toggle show only
 * when the sidebar is hidden (phone), so the desktop has ONE theme toggle —
 * the one in the sidebar footer that carries `TEST_IDS.themeToggle`.
 */
export interface TopbarProps {
  title: ReactNode;
  sub?: ReactNode;
  backHref?: string;
  user: PublicCrmUser;
  theme: CrmTheme;
  onTheme: (theme: CrmTheme) => void;
  /** Callback ref: the `.actions` element for `createPortal`. */
  actionsRef: (el: HTMLDivElement | null) => void;
}

export function Topbar({ title, sub, backHref, user, theme, onTheme, actionsRef }: TopbarProps) {
  const initials = user.rep?.initials ?? initialsOf(user.name || user.email);
  return (
    <header className="topbar">
      {backHref ? (
        <Link href={backHref} className="btn btn-ghost btn-icon" aria-label="Back">
          <IconArrowLeft {...ICON} />
        </Link>
      ) : null}
      {/* `topbar-head` is not decoration: the phone rules need to tell the
          title block apart from the person chip, and both are plain divs. */}
      <div className="topbar-head">
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      <div className="actions" ref={actionsRef} />
      <div className="who">
        <Avatar initials={initials} repSlug={user.rep?.slug ?? null} name={user.name} sm />
        <ThemeToggle theme={theme} onChange={onTheme} />
      </div>
    </header>
  );
}
