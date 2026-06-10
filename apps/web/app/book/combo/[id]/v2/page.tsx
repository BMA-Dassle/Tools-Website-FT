import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { BookingFlow } from "~/components/features/booking";
import type { Brand, EntryContext } from "~/features/booking";
import { parseEntryContextFromSearchParams } from "~/features/booking/state/parse-entry-context";
import { getComboSpecial } from "~/features/combos";

/**
 * Combo-special v2 booking entry — `/book/combo/[id]/v2` (e.g. race-bowl).
 *
 * Thin server shell: resolve the ComboSpecial from the registry (unknown or
 * disabled → 404), then mount BookingFlow with `comboSpecialId`. The flow
 * seeds a fresh session at the combo's center with BOTH components (one race
 * item + one bowling item preset to the combo's duration) and stamps
 * `session.comboSpecialId`; checkout charges the flat per-person combo price
 * when the strict gate passes (features/combos/combo-pricing.ts).
 *
 * `activity="race"` is the nominal entry activity — the combo seeding path
 * in BookingFlow bypasses single-activity seeding entirely.
 */

async function readEntryBrand(): Promise<Brand> {
  const hdrs = await headers();
  return hdrs.get("x-brand") === "headpinz" ? "headpinz" : "fasttrax";
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const combo = getComboSpecial(id);
  if (!combo || !combo.enabled) return { title: "Not found" };
  return {
    title: `Book the ${combo.name}`,
    description: combo.shortDescription,
  };
}

export default async function BookComboV2Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const combo = getComboSpecial(id);
  if (!combo || !combo.enabled) notFound();

  const sp = await searchParams;
  const entryBrand = await readEntryBrand();
  const initialContext: EntryContext = parseEntryContextFromSearchParams(sp);

  return (
    <BookingFlow
      activity="race"
      entryBrand={entryBrand}
      initialContext={initialContext}
      comboSpecialId={combo.id}
      initialCheckout={sp.checkout === "1"}
    />
  );
}
