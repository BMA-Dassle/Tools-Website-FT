"use client";

import { IconChevronRight } from "@tabler/icons-react";
import Link from "next/link";
import { TEST_IDS } from "~/features/crm/core/contracts";
import { moreForRole } from "~/features/crm/core/nav";
import { ICON } from "../primitives/icon-props";
import { useCrmUser, useScreenHead } from "../lib/use-crm-user";
import { NavGlyph } from "./icons";
import { hrefFor } from "./nav-links";

/**
 * The phone's "More" overflow (`direction-b.html:121`).
 *
 * On a phone the sidebar is hidden and the bottom bar has room for five tabs,
 * so everything else — Events, Calls, Lead queue, History, Cold lists,
 * Collateral, Accountability, KPI, Goals, and the two admin screens — is
 * reachable ONLY from here. Until this screen existed those eleven screens had
 * no route on a phone at all (owner, 2026-09-13: "no evetns and other optios
 * on mobile").
 *
 * `moreForRole()` is the whole list: `core/nav.ts` owns which entries exist and
 * which a rep may see, exactly as it does for the sidebar and the tabs, so a
 * screen added there appears here with no edit to this file. Nothing is
 * hardcoded a second time and nothing is filtered on `ready` — every entry in
 * the list is ready, and were one not, it would render its own NotBuiltYet
 * rather than vanish from the only navigation a phone has.
 *
 * Like the prototype this list carries no badge counts and no sub-line; the
 * topbar's own sub is suppressed by naming the head "More" with none.
 */
export default function MoreScreen() {
  const { user } = useCrmUser();
  useScreenHead("More");
  return (
    <div className="card list more-list">
      {moreForRole(user.role).map((item) => (
        <Link
          key={item.id}
          className="row"
          href={hrefFor(item.id)}
          data-testid={TEST_IDS.navItem(item.id)}
        >
          <span className="more-ico">
            <NavGlyph name={item.icon} />
          </span>
          {/* A span, where the prototype has a div, and deliberately. The
              phone re-grids `.row` into date/main/right areas with
              `.row > div:not(.right):not(.dblock):not(.ring):not(.avatar)` —
              six classes deep, so no sane selector here outranks it, and a div
              label lands in the "main" area of a template this row does not
              use. Not being a div is what keeps it out of that rule; `.title`
              styles it identically either way. */}
          <span className="title">{item.label}</span>
          <IconChevronRight {...ICON} />
        </Link>
      ))}
    </div>
  );
}
