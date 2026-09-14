"use client";

import { IconDeviceLandlinePhone } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { errorMessage } from "../lib/crm-fetch";
import { useCrmFetch, useCrmToast } from "../lib/use-crm-user";
import { ICON } from "../primitives/icon-props";
import { Table } from "../primitives/Table";
import { ErrorState, LoadingState } from "../primitives/States";

/**
 * "Calling & texting" — each rep's 3CX extension and Voxtelesys DID.
 *
 * Owner, 2026-09-14: "Need a spot to enter 3cx ext and did for sms that we will
 * use with voxtelesys. Guest services team will share a DID number if that
 * matters."
 *
 * IT MATTERS, AND THE SCREEN SAYS SO. A DID is the guest's side of a
 * conversation: inbound texts are threaded by `(DID, guest number)`, so two
 * people on one number land in one thread with no way to tell whose reply is
 * whose. The shared call-centre number therefore belongs on the GUEST SERVICES
 * row — a bucket every agent already acts as — and the route refuses to put the
 * same DID on a second rep rather than letting somebody discover that later.
 *
 * Sits beside the roster because this is the "who is on the team" screen, and
 * because an extension and a shift are the two things that decide whether a
 * call can reach somebody at all.
 *
 * SAVES ONE ROW AT A TIME, on blur or Enter — a Save-all button over a table of
 * phone numbers is a way to change four people's routing while meaning to
 * change one.
 */

interface ContactRow {
  id: string;
  slug: string;
  displayName: string;
  role: string;
  threecxExtension: string | null;
  voxDid: string | null;
}

export function ContactRoutingCard() {
  const crmFetch = useCrmFetch();
  const toast = useCrmToast();
  const qc = useQueryClient();
  const id = useId();
  const [draft, setDraft] = useState<Record<string, { ext?: string; did?: string }>>({});

  const q = useQuery({
    queryKey: ["crm", "reps", "contact"],
    queryFn: () => crmFetch<{ reps: ContactRow[] }>("/reps"),
  });

  const save = useMutation({
    mutationFn: (body: { repId: string; threecxExtension?: string; voxDid?: string }) =>
      crmFetch<{ reps: ContactRow[] }>("/reps", { method: "PATCH", body }),
    onSuccess: (r, sent) => {
      qc.setQueryData(["crm", "reps", "contact"], r);
      setDraft((d) => ({ ...d, [sent.repId]: {} }));
      toast("Saved");
    },
    // The server's own words: "Lori Lehman already texts from that number…"
    // says more than "conflict" ever could.
    onError: (err) => toast(errorMessage(err), "crit"),
  });

  const rows = q.data?.reps ?? [];

  const commit = (row: ContactRow, field: "ext" | "did", value: string) => {
    const current = field === "ext" ? (row.threecxExtension ?? "") : (row.voxDid ?? "");
    if (value.trim() === current) return; // nothing changed — do not write.
    save.mutate(
      field === "ext"
        ? { repId: row.id, threecxExtension: value.trim() }
        : { repId: row.id, voxDid: value.trim() },
    );
  };

  return (
    <div className="card">
      <div className="card-h">
        <h2>Calling &amp; texting</h2>
        <div className="right">
          <span className="xs muted">Director only</span>
        </div>
      </div>
      <div className="pad-x">
        {q.isPending ? <LoadingState label="Reading the roster…" /> : null}
        {q.isError ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : null}
        {q.data ? (
          <Table
            columns={[
              { key: "who", label: "Person" },
              { key: "ext", label: "3CX extension" },
              { key: "did", label: "Texting number (Voxtelesys)" },
            ]}
            caption="Each rep's calling extension and texting number"
          >
            {rows.map((row) => {
              const d = draft[row.id] ?? {};
              return (
                <tr key={row.id}>
                  <td>
                    <div className="stack" style={{ gap: 2 }}>
                      <span className="strong">{row.displayName}</span>
                      {row.role === "bucket" ? (
                        <span className="xs muted">
                          Shared — put the call-centre number here, not on each agent
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <label className="sr-only" htmlFor={`${id}-${row.id}-ext`}>
                      3CX extension for {row.displayName}
                    </label>
                    <input
                      id={`${id}-${row.id}-ext`}
                      className="input"
                      inputMode="numeric"
                      placeholder="1042"
                      style={{ maxWidth: 140 }}
                      value={d.ext ?? row.threecxExtension ?? ""}
                      disabled={save.isPending}
                      onChange={(e) =>
                        setDraft((s) => ({ ...s, [row.id]: { ...d, ext: e.target.value } }))
                      }
                      onBlur={(e) => commit(row, "ext", e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                    />
                  </td>
                  <td>
                    <label className="sr-only" htmlFor={`${id}-${row.id}-did`}>
                      Texting number for {row.displayName}
                    </label>
                    <input
                      id={`${id}-${row.id}-did`}
                      className="input"
                      inputMode="tel"
                      placeholder="+1 239 555 1234"
                      style={{ maxWidth: 200 }}
                      value={d.did ?? row.voxDid ?? ""}
                      disabled={save.isPending}
                      onChange={(e) =>
                        setDraft((s) => ({ ...s, [row.id]: { ...d, did: e.target.value } }))
                      }
                      onBlur={(e) => commit(row, "did", e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : null}
      </div>
      <div className="pad xs muted">
        <IconDeviceLandlinePhone {...ICON} /> An extension is what Click-to-call rings; a texting
        number is what a guest sees and replies to. Numbers are stored in international form, so
        anything recognisable is accepted here.
      </div>
    </div>
  );
}
