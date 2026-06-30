"use client";

import { IconWheel, IconDeviceMobile } from "@tabler/icons-react";
import Card from "~/components/ui/Card";
import type { DashRaceAccount, DashRacerAccount } from "~/features/account/dashboard-types";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function RacerCard({ racer }: { racer: DashRacerAccount }) {
  return (
    <Card className="p-6">
      <div className="flex items-center gap-3">
        <IconWheel size={22} style={{ color: "var(--account-accent)" }} />
        <h2 className="text-lg font-semibold text-white">{racer.fullName || "Racer"}</h2>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-white/40">Lifetime races</p>
          <p className="text-white/80">{racer.races}</p>
        </div>
        <div>
          <p className="text-white/40">Last race</p>
          <p className="text-white/80">{formatDate(racer.lastSeen)}</p>
        </div>
      </div>

      {racer.memberships.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-white/40">
            Memberships
          </p>
          <div className="flex flex-wrap gap-1.5">
            {racer.memberships.map((m) => (
              <span
                key={m}
                className="rounded-full px-2 py-0.5 text-xs text-white/80"
                style={{ background: "color-mix(in srgb, var(--account-accent) 20%, transparent)" }}
              >
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {racer.credits.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-white/40">
            Race credits
          </p>
          <ul className="space-y-1.5 text-sm">
            {racer.credits.map((c, i) => (
              <li key={i} className="flex justify-between text-white/80">
                <span>{c.kind}</span>
                <span className="font-medium">{c.balance}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export default function RaceAccountTab({ race }: { race: DashRaceAccount }) {
  if (race.status === "not_applicable") {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <IconDeviceMobile size={32} className="text-white/30" />
        <p className="text-white/70">Sign in with your phone number to see your race account.</p>
        <p className="text-sm text-white/45">
          Your FastTrax race account is matched by phone number. Log out and sign in with your
          mobile number to view it.
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

  if (race.accounts.length === 0) {
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

  return (
    <div className="space-y-4">
      {race.accounts.length > 1 && (
        <p className="text-sm text-white/50">
          {race.accounts.length} racers are linked to your phone number.
        </p>
      )}
      {race.accounts.map((racer) => (
        <RacerCard key={racer.personId} racer={racer} />
      ))}
    </div>
  );
}
