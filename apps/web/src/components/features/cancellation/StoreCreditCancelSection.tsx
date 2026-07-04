"use client";

import { useState } from "react";
import { IconGiftCard, IconPhone } from "@tabler/icons-react";
import Modal from "~/components/ui/Modal";
import GiftCardIssuedPanel from "./GiftCardIssuedPanel";

/**
 * Guest self-serve "cancel & get a gift card" for the v2 confirmation page.
 * STORE CREDIT ONLY (owner policy 2026-07-03): the guest converts what they
 * paid into a new Square-GAN gift card (emailed + texted instantly) and
 * rebooks online — that IS the reschedule flow for racing/attractions, and it
 * makes price differences self-settling. Card refunds are staff-only, so the
 * copy points those guests at the phone.
 *
 * The whole BOOKING cancels together (one deposit funds every activity on the
 * bill), so the modal lists every part. The 1-hour cutoff mirrors the server
 * guard — shown client-side for a friendly message, ENFORCED server-side.
 */
export default function StoreCreditCancelSection({
  billId,
  sig,
  activities,
  amountCents,
  centerPhone,
  rebookHref,
}: {
  billId: string;
  sig: string;
  activities: Array<{ label: string; time: string | null }>;
  /** Display only — the server issues for the authoritative amount. */
  amountCents: number | null;
  centerPhone: string;
  rebookHref: string;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cutoffMsg, setCutoffMsg] = useState<string | null>(null);
  const [issued, setIssued] = useState<{
    gan: string;
    giftCardId: string | null;
    amountCents: number;
    sentToGuest: boolean;
  } | null>(null);

  // Client-side cutoff mirror: naked-ET wall-clock lexical compare (the same
  // trick the server guard uses). Checked at CLICK time (render must stay
  // pure); the server remains authoritative either way.
  function withinOneHourNow(): boolean {
    const times = activities.map((a) => a.time).filter((t): t is string => !!t);
    if (!times.length) return false;
    const earliest = times.reduce((a, b) => (a < b ? a : b)).replace(/Z$|[+-]\d{2}:\d{2}$/, "");
    const oneHourFromNowEt = new Date(Date.now() + 60 * 60 * 1000)
      .toLocaleString("sv-SE", { timeZone: "America/New_York" })
      .replace(" ", "T");
    return earliest < oneHourFromNowEt;
  }

  const amountLabel =
    amountCents && amountCents > 0
      ? `$${(amountCents / 100).toFixed(2)}`
      : "the full amount you paid";

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/booking/v2/self-cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ billId, sig }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        gan?: string | null;
        giftCardId?: string | null;
        amountCents?: number;
        notified?: { email: boolean; sms: boolean };
        error?: string;
        detail?: string;
      };
      if (!res.ok || !data.ok) {
        if (data.error === "within_1_hour") {
          setError(
            `Your booking starts in less than an hour, so online changes are closed. Call us at ${centerPhone} and we'll help right away.`,
          );
        } else if (data.error === "combo_call_center") {
          setError(`Ultimate VIP combos are handled by our team — call ${centerPhone}.`);
        } else if (data.error === "already_cancelled") {
          setError("This booking is already cancelled.");
        } else {
          setError(
            data.detail ||
              `Something went wrong and no changes were made. Please call ${centerPhone}.`,
          );
        }
        return;
      }
      if (!data.gan) {
        // Cancelled, but no card came back ($0 booking edge) — treat as done.
        setIssued(null);
        setModalOpen(false);
        setError(null);
        return;
      }
      setIssued({
        gan: data.gan,
        giftCardId: data.giftCardId ?? null,
        amountCents: data.amountCents ?? amountCents ?? 0,
        sentToGuest: !!(data.notified?.email || data.notified?.sms),
      });
      setModalOpen(false);
    } catch {
      setError(`Something went wrong and no changes were made. Please call ${centerPhone}.`);
    } finally {
      setBusy(false);
    }
  }

  if (issued) {
    return (
      <GiftCardIssuedPanel
        gan={issued.gan}
        giftCardId={issued.giftCardId}
        amountCents={issued.amountCents}
        rebookHref={rebookHref}
        sentToGuest={issued.sentToGuest}
      />
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-xl bg-white/[0.06] flex items-center justify-center shrink-0">
          <IconGiftCard className="w-6 h-6 text-white/60" />
        </div>
        <div className="min-w-0">
          <h2 className="font-display text-lg uppercase tracking-widest text-white">
            Can&apos;t make it?
          </h2>
          <p className="text-white/60 text-sm leading-relaxed mt-1">
            Cancel and we&apos;ll issue a HeadPinz FastTrax Gift Card for {amountLabel} — sent
            instantly by email and text. Use it to rebook any date online; if prices differ, the
            card simply covers its value toward your new booking.
          </p>
          <p className="text-white/40 text-xs leading-relaxed mt-2 flex items-center gap-1.5">
            <IconPhone className="w-3.5 h-3.5 shrink-0" />
            Prefer a refund to your card instead? Call us at {centerPhone}.
          </p>
        </div>
      </div>

      <div className="mt-4">
        {cutoffMsg ? (
          <p className="text-amber-400/90 text-sm">{cutoffMsg}</p>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (withinOneHourNow()) {
                setCutoffMsg(
                  `Your booking starts in less than an hour, so online changes are closed. Call us at ${centerPhone} and we'll help right away.`,
                );
                return;
              }
              setError(null);
              setModalOpen(true);
            }}
            className="rounded-xl border border-white/15 text-white/80 hover:text-white hover:border-white/30 font-semibold uppercase tracking-wider text-sm px-4 py-2.5"
          >
            Get a Gift Card &amp; Rebook
          </button>
        )}
      </div>

      {modalOpen && (
        <Modal title="Cancel & get a gift card" onClose={() => (busy ? null : setModalOpen(false))}>
          <div className="space-y-1.5 mb-4">
            {activities.map((a, i) => (
              <div key={i} className="flex justify-between gap-3 text-sm">
                <span className="text-white/80">{a.label}</span>
                {a.time && (
                  <span className="text-white/50">
                    {new Date(a.time.replace(/Z$|[+-]\d{2}:\d{2}$/, "")).toLocaleString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                )}
              </div>
            ))}
          </div>
          <p className="text-white/60 text-sm leading-relaxed">
            This cancels your entire booking. A HeadPinz FastTrax Gift Card for {amountLabel} will
            be emailed and texted to you right away — use it to rebook any date online.
          </p>
          {error && (
            <p className="mt-3 text-sm text-red-400 font-medium leading-relaxed">{error}</p>
          )}
          <div className="mt-5 flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={submit}
              className="flex-1 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-bold uppercase tracking-wider text-sm px-4 py-3"
            >
              {busy ? "Issuing your gift card..." : "Yes, cancel & issue my gift card"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setModalOpen(false)}
              className="flex-1 rounded-xl border border-white/15 text-white/80 hover:text-white disabled:opacity-50 font-semibold uppercase tracking-wider text-sm px-4 py-3"
            >
              Keep my booking
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
