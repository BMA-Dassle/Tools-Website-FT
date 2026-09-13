"use client";

import { IconBolt } from "@tabler/icons-react";
import Link from "next/link";
import { TEST_IDS, type PublicCrmUser } from "~/features/crm/core/contracts";
import { navForRole } from "~/features/crm/core/nav";
import type { ScreenId } from "~/features/crm/core/types";
import { Avatar } from "../primitives/Avatar";
import type { CrmTheme } from "../lib/theme";
import { initialsOf } from "../lib/use-crm-user";
import { NavGlyph } from "./icons";
import { hrefFor, type BadgeCounts } from "./nav-links";
import { ThemeToggle } from "./ThemeToggle";

/**
 * The desktop sidebar (`standardShell`, crm-shared.js:150-155): logo, the nav
 * groups from `core/nav.ts` filtered for the role (reps never see the Admin
 * group — `navForRole` drops it), badge slots, and the footer with the
 * signed-in person and the theme toggle. Hidden under 769px by crm.css.
 */
export interface SidebarProps {
  user: PublicCrmUser;
  activeId: ScreenId | null;
  badges?: BadgeCounts;
  theme: CrmTheme;
  onTheme: (theme: CrmTheme) => void;
}

export function Sidebar({ user, activeId, badges = {}, theme, onTheme }: SidebarProps) {
  const groups = navForRole(user.role);
  const initials = user.rep?.initials ?? initialsOf(user.name || user.email);
  return (
    <aside className="side" data-testid={TEST_IDS.sidebar} aria-label="CRM navigation">
      <div className="logo">
        <span className="mark">
          <IconBolt size={16} aria-hidden className="icon" />
        </span>
        <span>
          Sales CRM
          <small>HeadPinz · FastTrax</small>
        </span>
      </div>
      <nav className="nav">
        {groups.map((group) => (
          <div key={group.id} className="nav-group" data-testid={TEST_IDS.navGroup(group.id)}>
            {group.label ? <div className="group">{group.label}</div> : null}
            {group.items.map((item) => {
              const badge = item.badge ? badges[item.badge] : undefined;
              const active = item.id === activeId;
              return (
                <Link
                  key={item.id}
                  href={hrefFor(item.id)}
                  className={active ? "active" : undefined}
                  aria-current={active ? "page" : undefined}
                  data-testid={TEST_IDS.navItem(item.id)}
                >
                  <NavGlyph name={item.icon} />
                  <span>{item.label}</span>
                  {badge && badge.n > 0 ? (
                    <span className={badge.soft ? "badge soft" : "badge"}>{badge.n}</span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="me">
        <Avatar initials={initials} repSlug={user.rep?.slug ?? null} name={user.name} sm />
        <div className="who">
          <b>{user.name || user.email}</b>
          <span>{user.role === "director" ? "Director" : "Sales"}</span>
        </div>
        <ThemeToggle theme={theme} onChange={onTheme} testId={TEST_IDS.themeToggle} />
      </div>
    </aside>
  );
}
