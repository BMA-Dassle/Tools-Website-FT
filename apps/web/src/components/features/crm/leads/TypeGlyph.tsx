"use client";

import {
  IconBuilding,
  IconCalendar,
  IconFlag,
  IconGift,
  IconStar,
  IconUsers,
  type IconProps,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import { ICON } from "../primitives/icon-props";
import type { TypeIcon } from "./model";

const GLYPHS: Record<TypeIcon, ComponentType<IconProps>> = {
  building: IconBuilding,
  gift: IconGift,
  users: IconUsers,
  star: IconStar,
  flag: IconFlag,
  calendar: IconCalendar,
};

/** The event-type icon (`typeIcon`, crm-shared.js:209) as a tabler glyph. */
export function TypeGlyph({ name }: { name: TypeIcon }) {
  const Cmp = GLYPHS[name] ?? IconCalendar;
  return <Cmp {...ICON} />;
}
