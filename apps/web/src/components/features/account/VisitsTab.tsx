"use client";

import { IconExternalLink, IconCalendarEvent } from "@tabler/icons-react";
import Card from "~/components/ui/Card";
import type {
  AccountDashboardResponse,
  DashGroupEvent,
  DashReservation,
} from "~/features/account/dashboard-types";

const KIND_LABEL: Record<DashReservation["productKind"], string> = {
  kbf: "Kids Bowl Free",
  open: "Bowling",
  race: "Racing",
  attraction: "Attraction",
};

const BRAND_LABEL: Record<DashReservation["brand"], string> = {
  fasttrax: "FastTrax",
  headpinz: "HeadPinz",
};

/** Format a naive ET wall-clock ISO ("2026-06-15T13:30:00") without shifting tz. */
function formatEventAt(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, hh, mm] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm));
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A single card may be one reservation or two combo legs sharing a comboGroupId. */
interface VisitCard {
  key: string;
  title: string;
  brands: DashReservation["brand"][];
  eventAt: string;
  status: string;
  cancelled: boolean;
  playerCount: number | null;
  lineSummary: string[];
  confirmationUrl: string | null;
}

function groupVisits(list: DashReservation[]): VisitCard[] {
  const combos = new Map<string, DashReservation[]>();
  const singles: DashReservation[] = [];
  for (const r of list) {
    if (r.comboGroupId) {
      const arr = combos.get(r.comboGroupId) ?? [];
      arr.push(r);
      combos.set(r.comboGroupId, arr);
    } else {
      singles.push(r);
    }
  }

  const cards: VisitCard[] = [];
  for (const [groupId, legs] of combos) {
    const sorted = [...legs].sort((a, b) => a.eventAt.localeCompare(b.eventAt));
    cards.push({
      key: `combo-${groupId}`,
      title: "Ultimate VIP Experience",
      brands: [...new Set(legs.map((l) => l.brand))],
      eventAt: sorted[0].eventAt,
      status: sorted[0].status,
      cancelled: legs.every((l) => l.cancelled),
      playerCount: sorted[0].playerCount,
      lineSummary: legs.flatMap((l) => [
        `${KIND_LABEL[l.productKind]}: ${formatEventAt(l.eventAt)}`,
        ...l.lineSummary,
      ]),
      confirmationUrl: legs.find((l) => l.confirmationUrl)?.confirmationUrl ?? null,
    });
  }
  for (const r of singles) {
    cards.push({
      key: `res-${r.id}`,
      title: KIND_LABEL[r.productKind],
      brands: [r.brand],
      eventAt: r.eventAt,
      status: r.status,
      cancelled: r.cancelled,
      playerCount: r.playerCount,
      lineSummary: r.lineSummary,
      confirmationUrl: r.confirmationUrl,
    });
  }
  return cards;
}

function StatusBadge({ status, cancelled }: { status: string; cancelled: boolean }) {
  const label = cancelled ? "Cancelled" : status.replace(/_/g, " ");
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
        cancelled ? "bg-red-500/15 text-red-300" : "bg-white/10 text-white/60"
      }`}
    >
      {label}
    </span>
  );
}

function VisitCardView({ card }: { card: VisitCard }) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-white">{card.title}</h3>
            {card.brands.map((b) => (
              <span
                key={b}
                className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/70"
                style={{ background: "color-mix(in srgb, var(--account-accent) 22%, transparent)" }}
              >
                {BRAND_LABEL[b]}
              </span>
            ))}
          </div>
          <p className="mt-1 text-sm text-white/70">{formatEventAt(card.eventAt)}</p>
          {card.playerCount ? (
            <p className="text-sm text-white/50">
              {card.playerCount} {card.playerCount === 1 ? "guest" : "guests"}
            </p>
          ) : null}
          {card.lineSummary.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-sm text-white/50">
              {card.lineSummary.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
        </div>
        <StatusBadge status={card.status} cancelled={card.cancelled} />
      </div>
      {card.confirmationUrl && !card.cancelled && (
        <a
          href={card.confirmationUrl}
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium"
          style={{ color: "var(--account-accent)" }}
        >
          View confirmation
          <IconExternalLink size={15} />
        </a>
      )}
    </Card>
  );
}

function GroupEventCard({ ev }: { ev: DashGroupEvent }) {
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white">{ev.eventName || "Group event"}</h3>
          <p className="mt-1 text-sm text-white/70">
            {new Date(ev.eventDate).toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </p>
          <p className="text-sm text-white/50">{ev.centerName}</p>
          <p className="mt-2 text-sm text-white/60">
            {dollars(ev.collectedCents)} paid
            {ev.balanceCents > 0 && (
              <span className="text-white/40"> · {dollars(ev.balanceCents)} balance due</span>
            )}
          </p>
        </div>
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs capitalize text-white/60">
          {ev.status.replace(/_/g, " ")}
        </span>
      </div>
      {ev.contractUrl && (
        <a
          href={ev.contractUrl}
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium"
          style={{ color: "var(--account-accent)" }}
        >
          View event details
          <IconExternalLink size={15} />
        </a>
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-white/40">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export default function VisitsTab({ data }: { data: AccountDashboardResponse }) {
  const { reservations, groupEvents } = data;
  const upcoming = groupVisits(reservations.upcoming);
  const past = groupVisits(reservations.past);
  const groups = groupEvents.items;

  const unavailable = reservations.status === "unavailable" && groupEvents.status === "unavailable";
  const isEmpty = upcoming.length === 0 && past.length === 0 && groups.length === 0 && !unavailable;

  if (unavailable) {
    return (
      <Card className="p-6">
        <p className="text-white/70">We couldn&apos;t load your reservations right now.</p>
      </Card>
    );
  }

  if (isEmpty) {
    return (
      <Card className="flex flex-col items-center gap-3 p-10 text-center">
        <IconCalendarEvent size={32} className="text-white/30" />
        <p className="text-white/70">No reservations found for {data.contactMasked}.</p>
        <p className="text-sm text-white/45">
          Reservations you book on this site will show up here. If you booked with a different phone
          or email, log out and sign in with that one.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {upcoming.length > 0 && (
        <Section title="Upcoming">
          {upcoming.map((c) => (
            <VisitCardView key={c.key} card={c} />
          ))}
        </Section>
      )}
      {groups.length > 0 && (
        <Section title="Group events">
          {groups.map((ev) => (
            <GroupEventCard key={ev.id} ev={ev} />
          ))}
        </Section>
      )}
      {past.length > 0 && (
        <Section title="Past">
          {past.map((c) => (
            <VisitCardView key={c.key} card={c} />
          ))}
        </Section>
      )}
    </div>
  );
}
