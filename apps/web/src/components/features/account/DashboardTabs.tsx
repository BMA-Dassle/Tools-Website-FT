"use client";

import { useState } from "react";
import { IconCalendarEvent, IconStar, IconWheel, IconCreditCard } from "@tabler/icons-react";
import { useDashboard, useLogout, type MeResponse } from "~/features/account/hooks";
import Button from "~/components/ui/Button";
import Spinner from "~/components/ui/Spinner";
import Card from "~/components/ui/Card";
import VisitsTab from "./VisitsTab";
import RewardsTab from "./RewardsTab";
import RaceAccountTab from "./RaceAccountTab";
import PaymentTab from "./PaymentTab";

type TabKey = "visits" | "rewards" | "race" | "payment";

const TABS: { key: TabKey; label: string; Icon: typeof IconCalendarEvent }[] = [
  { key: "visits", label: "My Visits", Icon: IconCalendarEvent },
  { key: "rewards", label: "Rewards", Icon: IconStar },
  { key: "race", label: "Race Account", Icon: IconWheel },
  { key: "payment", label: "Payment", Icon: IconCreditCard },
];

export default function DashboardTabs({ me }: { me: MeResponse }) {
  const [tab, setTab] = useState<TabKey>("visits");
  const logout = useLogout();
  // Dashboard data backs Visits/Rewards/Race; Payment loads its own subscriptions.
  const dash = useDashboard(tab !== "payment");

  return (
    <div className="mt-10">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-white">Your account</h1>
          {me.contactMasked && (
            <p className="text-sm text-white/50">Signed in as {me.contactMasked}</p>
          )}
        </div>
        <Button variant="ghost" onClick={() => logout.mutate()} loading={logout.isPending}>
          Log out
        </Button>
      </div>

      <div
        role="tablist"
        aria-label="Account sections"
        className="mb-6 flex gap-1 overflow-x-auto border-b border-white/10"
      >
        {TABS.map(({ key, label, Icon }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(key)}
              className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                active ? "text-white" : "border-transparent text-white/50 hover:text-white/80"
              }`}
              style={active ? { borderColor: "var(--account-accent)" } : undefined}
            >
              <Icon size={16} />
              {label}
            </button>
          );
        })}
      </div>

      {tab === "payment" ? (
        <PaymentTab me={me} />
      ) : dash.isLoading ? (
        <div className="flex justify-center py-16 text-white/60">
          <Spinner label="Loading your account" />
        </div>
      ) : dash.isError || !dash.data ? (
        <Card className="p-6">
          <p className="mb-3 text-white/70">We couldn&apos;t load your account right now.</p>
          <Button variant="secondary" onClick={() => dash.refetch()}>
            Try again
          </Button>
        </Card>
      ) : tab === "visits" ? (
        <VisitsTab data={dash.data} />
      ) : tab === "rewards" ? (
        <RewardsTab rewards={dash.data.rewards} />
      ) : (
        <RaceAccountTab race={dash.data.raceAccount} />
      )}
    </div>
  );
}
