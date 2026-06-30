"use client";

import { useMemo, useState } from "react";
import { useSubscriptions, type MeResponse } from "~/features/account/hooks";
import type { AccountSubscription } from "~/features/account/types";
import Button from "~/components/ui/Button";
import Card from "~/components/ui/Card";
import Spinner from "~/components/ui/Spinner";
import SubscriptionCard from "./SubscriptionCard";
import { ChangeCardModal } from "./CardModals";

interface Group {
  locationId: string;
  label: string;
  subs: AccountSubscription[];
}

function groupByLocation(subs: AccountSubscription[]): Group[] {
  const map = new Map<string, Group>();
  for (const s of subs) {
    const key = s.locationId || "other";
    const g = map.get(key) ?? { locationId: key, label: s.locationLabel, subs: [] };
    g.subs.push(s);
    map.set(key, g);
  }
  return [...map.values()];
}

/**
 * Payment / subscriptions tab — the original /account view (saved cards +
 * Have-A-Ball subscription card management), unchanged except that the page
 * header + log-out now live in DashboardTabs.
 */
export default function PaymentTab({ me }: { me: MeResponse }) {
  const subs = useSubscriptions(true);
  const [changeFor, setChangeFor] = useState<AccountSubscription | null>(null);

  const data = subs.data;
  const grouped = useMemo(() => groupByLocation(data?.subscriptions ?? []), [data]);
  const cards = data?.cards ?? [];
  const hasSubs = (data?.subscriptions.length ?? 0) > 0;

  if (subs.isLoading) {
    return (
      <div className="flex justify-center py-16 text-white/60">
        <Spinner label="Loading subscriptions" />
      </div>
    );
  }
  if (subs.isError) {
    return (
      <Card className="p-6">
        <p className="mb-3 text-white/70">We couldn&apos;t load your subscriptions.</p>
        <Button variant="secondary" onClick={() => subs.refetch()}>
          Try again
        </Button>
      </Card>
    );
  }
  if (!hasSubs) {
    return (
      <Card className="p-6">
        <p className="mb-2 text-white/80">No subscriptions found for {me.contactMasked}.</p>
        <p className="text-sm text-white/50">
          If you signed up with a different email or phone number, log out and sign in with that
          one.
        </p>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-8">
        {grouped.map((g) => (
          <section key={g.locationId} aria-labelledby={`grp-${g.locationId}`}>
            <h2
              id={`grp-${g.locationId}`}
              className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/40"
            >
              {g.label}
            </h2>
            <div className="space-y-3">
              {g.subs.map((s) => (
                <SubscriptionCard key={s.id} sub={s} onChangeCard={() => setChangeFor(s)} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {changeFor && (
        <ChangeCardModal sub={changeFor} cards={cards} onClose={() => setChangeFor(null)} />
      )}
    </>
  );
}
