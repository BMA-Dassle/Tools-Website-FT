"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LeadView } from "~/features/crm/leads/contracts";
import type { CallRow, CallsConnectivity } from "~/features/crm/calls/contracts";
import { callsKeys } from "~/features/crm/calls/queries";
import { useCrmFetch } from "../lib/use-crm-user";
import { LoadingState } from "../primitives/States";
import { DialSheet } from "./DialSheet";
import { DispositionSheet } from "./DispositionSheet";

/**
 * The deal rail's Call button (`crm-shared.js:253-257`), end to end in one
 * sheet: ring the guest, then log what happened.
 *
 * The prototype showed the outcome buttons immediately, because nothing was
 * really dialled. Here the dial has to happen first — it is what creates the
 * `crm_calls` row the disposition attaches to — so the sheet has two steps and
 * moves itself to the second one as soon as the call is placed. A rep who
 * dialled from their handset instead can still get there: "Log a call I already
 * made" places the same intent row without ringing anything.
 */
export default function DealCallSheet({ lead, onDone }: { lead: LeadView; onDone: () => void }) {
  const crmFetch = useCrmFetch();
  const [call, setCall] = useState<CallRow | null>(null);

  // The board query answers with `connectivity` too, so the sheet says the same
  // thing the Calls screen does about the extension and the kill switch.
  const board = useQuery({
    queryKey: callsKeys.list({ limit: "1" }),
    queryFn: () => crmFetch<{ ok: true; connectivity: CallsConnectivity }>("/calls?limit=1"),
    staleTime: 60_000,
  });

  if (board.isPending) return <LoadingState label="Checking 3CX…" />;

  const connectivity: CallsConnectivity = board.data?.connectivity ?? {
    apiConfigured: false,
    journalConfigured: false,
    clickToCallEnabled: false,
    myExtension: null,
  };

  if (call) return <DispositionSheet call={call} onDone={onDone} />;

  return (
    <DialSheet
      connectivity={connectivity}
      initialNumber={lead.guest.phone}
      initialLeadId={lead.publicId}
      onDialed={(placed) => setCall(placed)}
    />
  );
}
