"use client";

import { IconFile, IconSend } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EVENTS_COPY, EVENT_TEST_IDS, type EventDetailView } from "~/features/crm/events/contracts";
import { eventsKeys } from "~/features/crm/events/queries";
import { CENTRES } from "~/features/crm/core/centres";
import { fDateY, fTime } from "~/features/crm/core/dates";
import { moneyExact, pct } from "~/features/crm/core/format";
import { EVENT_TYPE_LABEL } from "~/features/crm/leads/contracts";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { Chip } from "../primitives/Chip";
import { ICON } from "../primitives/icon-props";
import { Kv } from "../primitives/Kv";
import { Meter } from "../primitives/Meter";
import { Pill } from "../primitives/Pill";
import { Table } from "../primitives/Table";
import { EmptyState, ErrorState, LoadingState } from "../primitives/States";
import { fetchLeadEvent, sendWaiverLinks } from "../events/queries";
import type { DealTabProps } from "./tabs";

/**
 * `eventPanel(l)` (crm-events.js:187-198) — the BMI project behind the deal:
 * the project facts, the schedule, the products, the waiver registration, the
 * people and the day-of line. Read-only except the waiver send, which goes
 * through the EXISTING reminder rail.
 */
export default function EventTab({ detail }: DealTabProps) {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const publicId = detail.lead.publicId;

  const q = useQuery({
    queryKey: eventsKeys.leadEvent(publicId),
    queryFn: () => fetchLeadEvent(crmFetch, publicId),
    enabled: !!detail.lead.bmi.projectId,
  });

  const waivers = useMutation({
    mutationFn: () => sendWaiverLinks(crmFetch, publicId),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: eventsKeys.leadEvent(publicId) });
      if (r.sent) toast("Waiver link sent to the host");
      else if (r.reason === "no_contract")
        toast("No contract on this event yet — the links are ready to copy", "warn");
      else if (r.reason === "no_waiver_products")
        toast("Nothing on this event needs a waiver", "warn");
      else toast("Could not build a waiver link for this event", "warn");
    },
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  if (!detail.lead.bmi.projectId) {
    return (
      <div className="card" data-testid={EVENT_TEST_IDS.eventTab}>
        <div className="pad">
          <EmptyState>
            No BMI project yet. Create it from the deal header and the schedule, products and people
            will appear here.
          </EmptyState>
        </div>
      </div>
    );
  }

  if (q.isPending) return <LoadingState label="Reading the BMI project…" />;
  if (q.isError)
    return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;

  const event = q.data!.event;
  const registered = event.registered ?? 0;
  const registeredPct = pct(registered, event.persons);

  return (
    <div className="deal-grid" data-testid={EVENT_TEST_IDS.eventTab}>
      <div className="stack" style={{ gap: 16 }}>
        <ProjectCard event={event} lead={detail.lead} />

        <div className="card">
          <div className="card-h">
            <h2>Schedule</h2>
          </div>
          {event.schedules.length ? (
            <Table
              caption="Schedule"
              columns={[
                { key: "start", label: "Start" },
                { key: "stop", label: "Stop" },
                { key: "resource", label: "Resource" },
                { key: "products", label: "Products" },
                { key: "persons", label: "Persons", num: true },
              ]}
            >
              {event.schedules.map((s) => (
                <tr key={s.id}>
                  <td>{s.start ? fTime(s.start) : "—"}</td>
                  <td>{s.stop ? fTime(s.stop) : "—"}</td>
                  <td>{s.resource}</td>
                  <td>{s.products}</td>
                  <td className="num">{s.persons}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <div className="pad">
              <EmptyState>Nothing scheduled on this project yet.</EmptyState>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-h">
            <h2>Products</h2>
          </div>
          {event.products.length ? (
            <Table
              caption="Products"
              columns={[
                { key: "name", label: "Product" },
                { key: "qty", label: "Qty", num: true },
                { key: "total", label: "Total", num: true },
              ]}
            >
              {event.products.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.nameOverride || p.name}
                    {p.nameOverride ? <span className="xs muted"> · {p.name}</span> : null}
                  </td>
                  <td className="num">{p.quantity}</td>
                  <td className="num">{moneyExact(p.totalPriceCents)}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <div className="pad">
              <EmptyState>No products on this project yet.</EmptyState>
            </div>
          )}
        </div>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        <div className="card">
          <div className="card-h">
            <h2>Waivers</h2>
          </div>
          <div className="pad stack">
            {event.waiversRequired ? (
              <>
                <div className="hstack between">
                  <b>
                    {registered} of {event.persons}
                  </b>
                  <Chip kind={registeredPct >= 70 ? "won" : registeredPct >= 30 ? "warn" : "lost"}>
                    {registeredPct >= 70 ? "Good" : registeredPct >= 30 ? "Moderate" : "Low"}{" "}
                    registration
                  </Chip>
                </div>
                <Meter
                  pct={registeredPct}
                  tone={registeredPct >= 70 ? "good" : registeredPct >= 30 ? "warn" : "crit"}
                  label={`${registered} of ${event.persons} registered`}
                />
                <div className="hstack">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={waivers.isPending}
                    onClick={() => waivers.mutate()}
                  >
                    <IconSend {...ICON} /> {waivers.isPending ? "Sending…" : "Send waiver link"}
                  </button>
                </div>
                {waivers.data?.organizerUrl ? (
                  <div className="xs muted" style={{ overflowWrap: "anywhere" }}>
                    Organizer link: {waivers.data.organizerUrl}
                    <br />
                    Share link: {waivers.data.signUrl}
                  </div>
                ) : null}
                <div className="xs muted">{EVENTS_COPY.waiverHelp}</div>
              </>
            ) : (
              <div className="muted small">No waiver activities on this event.</div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h2>Contact &amp; attendees</h2>
          </div>
          <div className="list">
            {event.contact ? <PersonRow person={event.contact} /> : null}
            {event.people
              .filter((p) => p.id !== event.contact?.id)
              .map((p) => (
                <PersonRow key={p.id} person={p} />
              ))}
            {!event.contact && event.people.length === 0 ? (
              <EmptyState>No people on this project yet.</EmptyState>
            ) : null}
          </div>
          <div className="pad xs muted" style={{ paddingTop: 8 }}>
            {EVENTS_COPY.attendeesFoot}
          </div>
        </div>

        <div className="card">
          <div className="card-h">
            <h2>Day of</h2>
          </div>
          <div className="pad stack small">
            <div className="hstack between">
              <span className="muted">Food out</span>
              <b>{event.foodOut.time ?? "—"}</b>
            </div>
            <div className="hstack between">
              <span className="muted">Square day-of order</span>
              <span>
                {event.contract?.dayofOrderId ? `OPEN · ${event.contract.dayofOrderId}` : "—"}
              </span>
            </div>
            <div className="hstack between">
              <span className="muted">Gift card</span>
              <span>{event.contract?.giftCardGan ?? "—"}</span>
            </div>
            <div className="hstack between">
              <span className="muted">BMI balance</span>
              <span className="mono">{moneyExact(event.balanceCents)}</span>
            </div>
            <div className="hstack">
              <span className="xs muted">
                <IconFile {...ICON} /> Printing the full details is the contract page&apos;s job.
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectCard({
  event,
  lead,
}: {
  event: EventDetailView;
  lead: DealTabProps["detail"]["lead"];
}) {
  return (
    <div className="card">
      <div className="card-h">
        <h2>BMI project {event.number || "—"}</h2>
        <div className="right">
          <Chip bmi title="BMI state">
            {event.stateName || "unknown state"}
          </Chip>
        </div>
      </div>
      <div className="pad">
        <Kv
          rows={[
            {
              label: "When",
              value: event.when
                ? `${fDateY(event.when)} · ${fTime(event.when)}`
                : fDateY(lead.eventDate),
            },
            {
              label: "Persons",
              value: `${event.persons} · ${event.registered ?? 0} registered (waivers)`,
            },
            { label: "Responsible", value: event.responsible || "—" },
            {
              label: "Type",
              value: `${event.kindName || "—"} · ${EVENT_TYPE_LABEL[lead.type]}`,
            },
            { label: "Centre", value: CENTRES[event.centre].name },
            { label: "Created", value: event.createdAt ? fDateY(event.createdAt) : "—" },
            {
              label: "Contract",
              value: event.contract ? (
                <Pill>{event.contract.shortId ?? event.contract.status}</Pill>
              ) : (
                "none"
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}

function PersonRow({ person }: { person: EventDetailView["people"][number] }) {
  const initials = person.name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="row" style={{ gridTemplateColumns: "auto 1fr", cursor: "default" }}>
      <span className="avatar">{initials || "?"}</span>
      <div>
        <div className="title">
          {person.name || "Unnamed"} <Pill>{person.role}</Pill>
        </div>
        <div className="meta">
          {person.email ? <span>{person.email}</span> : null}
          {person.phone ? <span>{person.phone}</span> : null}
        </div>
      </div>
    </div>
  );
}
