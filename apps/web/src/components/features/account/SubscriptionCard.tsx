"use client";

import Card from "~/components/ui/Card";
import Button from "~/components/ui/Button";
import { longDate, statusMeta, usd } from "~/features/account/format";
import type { AccountSubscription } from "~/features/account/types";

const CHANGEABLE = new Set(["ACTIVE", "PENDING", "PAUSED"]);

export default function SubscriptionCard({
  sub,
  onChangeCard,
}: {
  sub: AccountSubscription;
  onChangeCard: () => void;
}) {
  const st = statusMeta(sub.status);
  const canChange = CHANGEABLE.has(sub.status.toUpperCase());

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white">{sub.planName || sub.locationLabel}</h3>
          {sub.planName && <p className="text-xs text-white/40">{sub.locationLabel}</p>}
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${st.className}`}
        >
          {st.label}
        </span>
      </div>

      <dl className="mt-3 space-y-1 text-sm">
        {sub.amount != null && (
          <div className="flex justify-between">
            <dt className="text-white/40">Price</dt>
            <dd className="text-white/80">
              {usd(sub.amount)}
              {sub.cadence ? ` · ${sub.cadence}` : ""}
            </dd>
          </div>
        )}
        {sub.nextBillingDate && (
          <div className="flex justify-between">
            <dt className="text-white/40">Paid through</dt>
            <dd className="text-white/80">{longDate(sub.nextBillingDate)}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-white/40">Payment card</dt>
          <dd
            className="text-white/80"
            aria-label={
              sub.cardLast4 ? `${sub.cardBrand} card ending ${sub.cardLast4}` : "Billed by invoice"
            }
          >
            {sub.cardLast4 ? `${sub.cardBrand} •••• ${sub.cardLast4}` : "Billed by invoice"}
          </dd>
        </div>
      </dl>

      {canChange && (
        <div className="mt-4">
          <Button variant="secondary" onClick={onChangeCard} className="px-4 py-2 text-xs">
            Change card
          </Button>
        </div>
      )}
    </Card>
  );
}
