"use client";

import { useState } from "react";

interface Props {
  shortId: string;
  eventName: string;
  eventDate: string;
  centerName: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string | null;
  guestCount: number | null;
  plannerName: string | null;
  plannerEmail: string | null;
  plannerPhone: string | null;
  totalCents: number;
  taxCents: number;
  lineItems: Array<{ name: string; price: number; qty: number; total: number }>;
  notes: string | null;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  deniedBy: string | null;
  denialReason: string | null;
}

const fmtDollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export default function ApproveClient(props: Props) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDeny, setShowDeny] = useState(false);

  const alreadyDecided = props.status !== "pending_approval";

  async function handleAction(action: "approve" | "deny") {
    if (!email) { setError("Enter your email address"); return; }
    if (action === "deny" && !reason) { setError("Enter a reason for denial"); return; }
    setProcessing(true);
    setError(null);
    try {
      const res = await fetch("/api/group-function/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shortId: props.shortId, action, email, reason: action === "deny" ? reason : undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Failed"); return; }
      setResult(data.action);
    } catch {
      setError("Request failed. Please try again.");
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-extrabold">Post-Paid Approval</h1>
        <p className="mt-2 text-gray-400">{props.centerName}</p>
      </div>

      {/* Already decided */}
      {alreadyDecided && !result && (
        <div className={`mb-6 rounded-2xl border p-6 text-center ${
          props.status === "denied"
            ? "border-red-500/20 bg-red-500/5"
            : "border-emerald-500/20 bg-emerald-500/5"
        }`}>
          {props.status === "denied" ? (
            <>
              <p className="text-lg font-bold text-red-400">Denied</p>
              <p className="mt-1 text-sm text-gray-400">by {props.deniedBy}</p>
              {props.denialReason && <p className="mt-2 text-sm text-gray-300">{props.denialReason}</p>}
            </>
          ) : (
            <>
              <p className="text-lg font-bold text-emerald-400">
                {props.approvedAt ? "Approved" : `Status: ${props.status}`}
              </p>
              {props.approvedBy && <p className="mt-1 text-sm text-gray-400">by {props.approvedBy}</p>}
            </>
          )}
        </div>
      )}

      {/* Success result */}
      {result && (
        <div className={`mb-6 rounded-2xl border p-6 text-center ${
          result === "approved"
            ? "border-emerald-500/20 bg-emerald-500/5"
            : "border-red-500/20 bg-red-500/5"
        }`}>
          <p className="text-2xl font-bold">
            {result === "approved" ? "✓ Approved" : "✗ Denied"}
          </p>
          <p className="mt-2 text-sm text-gray-400">
            {result === "approved"
              ? "The contract has been sent to the customer."
              : "The planner has been notified of the denial."}
          </p>
        </div>
      )}

      {/* Event Details Card */}
      <div className="mb-6 overflow-hidden rounded-2xl border border-white/10 bg-[#071027]">
        <div className="border-b border-white/10 bg-white/5 px-6 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-cyan-400">Event Details</h2>
        </div>
        <div className="p-6">
          <h3 className="mb-4 text-2xl font-bold">{props.eventName}</h3>
          <div className="mb-4 grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500">Date</p>
              <p className="font-semibold">{props.eventDate}</p>
            </div>
            {props.guestCount && (
              <div>
                <p className="text-xs text-gray-500">Guests</p>
                <p className="font-semibold">{props.guestCount}</p>
              </div>
            )}
          </div>

          {/* Products */}
          <div className="mb-4 space-y-1.5 border-t border-white/10 pt-3">
            {props.lineItems.map((item, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-gray-400">{item.name} <span className="text-gray-600">x{item.qty}</span></span>
                <span className="font-medium">{fmtDollars(Math.round(item.total * 100))}</span>
              </div>
            ))}
            {props.taxCents > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Tax</span>
                <span>{fmtDollars(props.taxCents)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-white/10 pt-2 text-sm font-bold">
              <span>Total</span>
              <span className="text-cyan-400">{fmtDollars(props.totalCents)}</span>
            </div>
          </div>

          {/* Customer + Planner */}
          <div className="grid grid-cols-2 gap-4 border-t border-white/10 pt-4">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-gray-500">Customer</p>
              <p className="font-semibold">{props.guestName}</p>
              <p className="text-sm text-gray-400">{props.guestEmail}</p>
              {props.guestPhone && <p className="text-sm text-gray-400">{props.guestPhone}</p>}
            </div>
            {props.plannerName && (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-gray-500">Planner</p>
                <p className="font-semibold">{props.plannerName}</p>
                {props.plannerEmail && <p className="text-sm text-gray-400">{props.plannerEmail}</p>}
                {props.plannerPhone && <p className="text-sm text-gray-400">{props.plannerPhone}</p>}
              </div>
            )}
          </div>

          {/* Notes */}
          {props.notes && (
            <div className="mt-4 rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-4">
              <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-cyan-400">Planner Notes</p>
              <p className="whitespace-pre-line text-sm text-gray-300">{props.notes}</p>
            </div>
          )}
        </div>
      </div>

      {/* Post-Paid Warning */}
      <div className="mb-6 rounded-2xl border border-amber-400/20 bg-amber-400/5 p-5">
        <p className="font-semibold text-amber-400">Post-Paid Account</p>
        <p className="mt-1 text-sm text-gray-400">
          This event uses a post-paid account. No deposit will be collected upfront.
          The customer will sign the contract acknowledging the terms. Payment will be collected after the event.
        </p>
      </div>

      {/* Action Section */}
      {!alreadyDecided && !result && (
        <div className="rounded-2xl border border-white/10 bg-[#071027] p-6">
          <div className="mb-4">
            <label htmlFor="approver-email" className="mb-1 block text-xs font-semibold uppercase tracking-widest text-gray-400">
              Your Email
            </label>
            <input
              id="approver-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="eric@headpinz.com"
              className="w-full rounded-lg border border-white/20 bg-white/5 px-4 py-2.5 text-sm outline-none focus:border-cyan-400"
            />
          </div>

          {error && (
            <div className="mb-4 rounded-lg bg-red-500/10 px-4 py-2 text-sm text-red-400">{error}</div>
          )}

          {!showDeny ? (
            <div className="flex gap-3">
              <button
                onClick={() => handleAction("approve")}
                disabled={processing}
                className="flex-1 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-600 py-3 text-lg font-bold shadow-lg shadow-emerald-500/20 disabled:opacity-40"
              >
                {processing ? "Processing..." : "Approve"}
              </button>
              <button
                onClick={() => setShowDeny(true)}
                className="rounded-xl border border-red-500/30 px-6 py-3 font-semibold text-red-400 hover:bg-red-500/10"
              >
                Deny
              </button>
            </div>
          ) : (
            <div>
              <label htmlFor="deny-reason" className="mb-1 block text-xs font-semibold uppercase tracking-widest text-gray-400">
                Reason for Denial
              </label>
              <textarea
                id="deny-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Explain why this post-paid account is being denied..."
                className="mb-4 w-full rounded-lg border border-white/20 bg-white/5 px-4 py-2.5 text-sm outline-none focus:border-red-400"
              />
              <div className="flex gap-3">
                <button
                  onClick={() => setShowDeny(false)}
                  className="rounded-xl border border-white/20 px-6 py-3 font-semibold hover:bg-white/5"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleAction("deny")}
                  disabled={processing}
                  className="flex-1 rounded-xl bg-red-600 py-3 font-bold text-white disabled:opacity-40"
                >
                  {processing ? "Processing..." : "Deny Post-Paid Account"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
