"use client";

import Link from "next/link";
import { TEST_IDS, type PublicCrmUser } from "~/features/crm/core/contracts";
import { tabsForRole } from "~/features/crm/core/nav";
import type { ScreenId } from "~/features/crm/core/types";
import { NavGlyph } from "./icons";
import { hrefFor, type BadgeCounts } from "./nav-links";

/**
 * The phone's bottom tabs (`direction-b.html:57`): My Day · Pipeline ·
 * Contracts · Messages · More. Always in the DOM; crm.css shows it only under
 * 769px, so there is no device toggle and no layout flash.
 */
export interface BottomTabsProps {
  user: PublicCrmUser;
  activeId: ScreenId | null;
  badges?: BadgeCounts;
}

export function BottomTabs({ user, activeId, badges = {} }: BottomTabsProps) {
  return (
    <nav className="tabs-bottom" data-testid={TEST_IDS.bottomTabs} aria-label="Quick tabs">
      {tabsForRole(user.role).map((tab) => {
        const badge = tab.badge ? badges[tab.badge] : undefined;
        const active = tab.id === activeId;
        return (
          <Link
            key={tab.id}
            href={hrefFor(tab.id)}
            className={active ? "active" : undefined}
            aria-current={active ? "page" : undefined}
          >
            <NavGlyph name={tab.icon} />
            <span>{tab.label}</span>
            {badge && badge.n > 0 ? <span className="badge">{badge.n}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
