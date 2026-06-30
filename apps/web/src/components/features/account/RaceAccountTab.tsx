"use client";

import {
  IconWheel,
  IconDeviceMobile,
  IconAlertTriangle,
  IconCircleCheck,
} from "@tabler/icons-react";
import Card from "~/components/ui/Card";
import type { DashRaceAccount } from "~/features/account/dashboard-types";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function RaceAccountTab({ race }: { race: DashRaceAccount }) {
  if (race.status === "not_applicable") {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <IconDeviceMobile size={32} className="text-white/30" />
        <p className="text-white/70">Sign in with your phone number to see your race account.</p>
        <p className="text-sm text-white/45">
          Your FastTrax race account (waiver and credits) is matched by phone number. Log out and
          sign in with your mobile number to view it.
        </p>
      </Card>
    );
  }

  if (race.status === "unavailable") {
    return (
      <Card className="p-6">
        <p className="text-white/70">We couldn&apos;t load your race account right now.</p>
      </Card>
    );
  }

  if (race.ambiguous && race.candidates?.length) {
    return (
      <Card className="p-6">
        <p className="mb-1 text-white/80">We found more than one racer on this phone number.</p>
        <p className="mb-4 text-sm text-white/45">
          A few people share this number. Contact Guest Services and we&apos;ll link the right racer
          profile to your account.
        </p>
        <ul className="space-y-1 text-sm text-white/70">
          {race.candidates.map((c) => (
            <li key={c.personId}>
              {c.firstName} {c.lastName}
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  if (!race.person) {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <IconWheel size={32} className="text-white/30" />
        <p className="text-white/70">No FastTrax race account found.</p>
        <p className="text-sm text-white/45">
          Race with us and we&apos;ll create your profile. Races you book on this site show up under
          My Visits.
        </p>
      </Card>
    );
  }

  const { person, credits } = race;
  return (
    <div className="space-y-4">
      <Card className="p-6">
        <div className="flex items-center gap-3">
          <IconWheel size={24} style={{ color: "var(--account-accent)" }} />
          <h2 className="text-lg font-semibold text-white">
            {person.firstName} {person.lastName}
          </h2>
        </div>

        <div className="mt-5 flex items-center gap-2 text-sm">
          {person.waiverValid ? (
            <>
              <IconCircleCheck size={18} className="text-emerald-400" />
              <span className="text-white/80">
                Waiver valid
                {person.waiverExpiry ? ` through ${formatDate(person.waiverExpiry)}` : ""}
              </span>
            </>
          ) : (
            <>
              <IconAlertTriangle size={18} className="text-amber-400" />
              <span className="text-white/80">
                {person.waiverExpiry
                  ? `Waiver expired ${formatDate(person.waiverExpiry)} — renew before your next race`
                  : "No active waiver — sign one before your next race"}
              </span>
            </>
          )}
        </div>

        {person.lastVisit && (
          <p className="mt-3 text-sm text-white/45">Last visit {formatDate(person.lastVisit)}</p>
        )}
      </Card>

      {credits && (
        <Card className="p-6">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-white/40">
            Race credits
          </h3>
          <ul className="mt-3 space-y-1.5 text-sm">
            {credits.items.map((c, i) => (
              <li key={i} className="flex justify-between text-white/80">
                <span>{c.kind}</span>
                <span className="font-medium">{c.balance}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
