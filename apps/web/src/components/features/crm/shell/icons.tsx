"use client";

import {
  IconBolt,
  IconCalendar,
  IconChartLine,
  IconDots,
  IconFile,
  IconGridDots,
  IconHistory,
  IconHome,
  IconLayoutKanban,
  IconList,
  IconLogout,
  IconMessage,
  IconPhone,
  IconSettings,
  IconTarget,
  type IconProps,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import type { NavIcon } from "~/features/crm/core/nav";
import { ICON } from "../primitives/icon-props";

/**
 * `core/nav.ts` names icons semantically ("home", "kanban", …); this is the one
 * place those keys become `@tabler/icons-react` components (brief §1.5: tabler
 * only, 16px, aria-hidden — no emoji, no inline paths).
 */
const NAV_ICONS: Record<NavIcon, ComponentType<IconProps>> = {
  home: IconHome,
  kanban: IconLayoutKanban,
  bolt: IconBolt,
  file: IconFile,
  calendar: IconCalendar,
  message: IconMessage,
  phone: IconPhone,
  history: IconHistory,
  list: IconList,
  target: IconTarget,
  chart: IconChartLine,
  settings: IconSettings,
  grid: IconGridDots,
  dots: IconDots,
  logout: IconLogout,
};

export function NavGlyph({ name }: { name: NavIcon }) {
  const Cmp = NAV_ICONS[name] ?? IconDots;
  return <Cmp {...ICON} />;
}
