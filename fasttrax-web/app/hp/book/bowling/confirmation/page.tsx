"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

const API = "/api/qamf";
const coral = "#fd5b56";
const gold = "#FFD700";
const cyan = "#00E2E5";

async function qamfCall(path: string, options?: RequestInit) {
  const token = sessionStorage.getItem("qamf_session_token") || "";
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(options?.headers as Record<string, string> || {}) };
  if (token) headers["x-sessiontoken"] = token;
  const res = await fetch(`${API}/${path}`, { ...options, headers });
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function parseBmiLocal(iso: string): Date {
  const clean = iso.replace(/Z$/, "");
  const [datePart, timePart] = clean.split("T");
  if (!timePart) return new Date(clean);
  const [y, m, d] = datePart.split("-").map(Number);
  const [h, min, s] = timePart.split(":").map(Number);
  return new Date(y, m - 1, d, h, min, s || 0);
}

function formatBmiTime(iso: string): string {
  return parseBmiLocal(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatTimeStr(t: string): string {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}

interface ReservationData {
  key?: string; centerId?: string; centerName?: string; operationId?: string;
  offer?: string; date?: string; time?: string; players?: number;
  tariffPrice?: number; shoes?: boolean; shoePrice?: number;
  addons?: { name: string; qty: number; price: number; time?: string }[];
  guestName?: string; guestEmail?: string;
}

interface ShoeCategory { DisplayName: string; Active: boolean; Id: number; ShoesSize: { Id: number; Name: string; CategoryId: number }[] }
interface PlayerEntry { name: string; shoeSize: string; shoeSizeObj: { Id: number; Name: string; CategoryId: number } | null; wantBumpers: boolean }

export default function BowlingConfirmationPage() {
  const params = useSearchParams();

  const [confirmData] = useState(() => {
    const urlKey = params.get("key");
    const urlCenter = params.get("center");
    const urlTx = params.get("transactionId") || params.get("orderId");
    if (urlKey && typeof window !== "undefined") {
      const data = { key: urlKey, center: urlCenter || "", transactionId: urlTx || "" };
      sessionStorage.setItem("qamf_confirm_data", JSON.stringify(data));
      window.history.replaceState({}, "", window.location.pathname);
      return data;
    }
    if (typeof window !== "undefined") {
      const stored = sessionStorage.getItem("qamf_confirm_data");
      if (stored) return JSON.parse(stored);
    }
    return { key: null, center: null, transactionId: null };
  });

  const key = confirmData.key;
  const centerId = confirmData.center;
  const transactionId = confirmData.transactionId;

  const [status, setStatus] = useState<"loading" | "confirmed" | "failed">("loading");
  const [reservation, setReservation] = useState<ReservationData | null>(null);
  const [bmiStatus, setBmiStatus] = useState<"" | "booking" | "done" | "error">("");

  // Player form state
  const [shoeCategories, setShoeCategories] = useState<ShoeCategory[]>([]);
  const [players, setPlayers] = useState<PlayerEntry[]>([]);
  const [playersSaved, setPlayersSaved] = useState(false);
  const [savingPlayers, setSavingPlayers] = useState(false);

  // Create BMI bill for add-ons (silent, internal only)
  async function createBmiBill() {
    const stored = sessionStorage.getItem("qamf_bmi_addons");
    if (!stored) return;
    setBmiStatus("booking");
    try {
      const { addons, guest } = JSON.parse(stored);
      if (!addons || addons.length === 0) return;
      let orderId: string | null = null;
      for (const addon of addons) {
        if (!addon.proposal || !addon.block) continue;
        const bookBody = {
          productId: addon.productId, quantity: addon.quantity,
          resourceId: Number(addon.block.resourceId) || -1,
          proposal: { blocks: addon.proposal.blocks.map((b: { productLineIds: number[]; block: { resourceId: number } }) => ({ productLineIds: b.productLineIds || [], block: { ...b.block, resourceId: Number(b.block.resourceId) || -1 } })), productLineId: addon.proposal.productLineId ?? null },
        };
        let bodyJson = JSON.stringify(bookBody);
        if (orderId) bodyJson = `{"orderId":${orderId},` + bodyJson.slice(1);
        const res = await fetch("/api/bmi?endpoint=booking%2Fbook", { method: "POST", headers: { "content-type": "application/json" }, body: bodyJson });
        if (res.ok) { const raw = await res.text(); if (!orderId) { const m = raw.match(/"orderId"\s*:\s*(\d+)/); if (m) orderId = m[1]; } }
      }
      if (!orderId) { setBmiStatus("error"); return; }
      const regBody = { firstName: guest.name.split(" ")[0] || guest.name, lastName: guest.name.split(" ").slice(1).join(" ") || "", email: guest.email, phone: guest.phone };
      await fetch("/api/bmi?endpoint=person%2FregisterContactPerson", { method: "POST", headers: { "content-type": "application/json" }, body: `{"orderId":${orderId},` + JSON.stringify(regBody).slice(1) });
      await fetch("/api/bmi?endpoint=payment%2Fconfirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), paymentTime: new Date().toISOString(), amount: 0, orderId: Number(orderId), depositKind: 0 }) });
      sessionStorage.removeItem("qamf_bmi_addons");
      setBmiStatus("done");
    } catch { setBmiStatus("error"); }
  }

  // Save player names, shoe sizes, bumpers
  async function savePlayers() {
    if (!key || !centerId) return;
    setSavingPlayers(true);
    try {
      await qamfCall(`centers/${centerId}/reservations/${key}/players`, {
        method: "PATCH",
        body: JSON.stringify({
          Players: players.map(p => ({
            Name: p.name || null,
            ShoeSize: p.shoeSize || null,
            WantBumpers: p.wantBumpers,
            Size: p.shoeSizeObj,
          })),
        }),
      });
      setPlayersSaved(true);
    } catch { /* ok */ }
    finally { setSavingPlayers(false); }
  }

  useEffect(() => {
    if (!key || !centerId) { setStatus("failed"); return; }
    let pollInterval: NodeJS.Timeout | null = null;

    async function confirm() {
      try {
        const stored = sessionStorage.getItem("qamf_reservation");
        if (stored) {
          const data = JSON.parse(stored);
          setReservation(data);
          // Init player entries
          const count = data.players || 1;
          setPlayers(Array.from({ length: count }, (_, i) => ({
            name: i === 0 ? (data.guestName || "") : "",
            shoeSize: "", shoeSizeObj: null, wantBumpers: false,
          })));
        }
        const opId = stored ? JSON.parse(stored).operationId : null;

        if (transactionId) {
          try { await qamfCall(`centers/${centerId}/reservations/${key}/payment-confirm`, { method: "PUT", body: JSON.stringify({ QueryParams: { transactionId, orderId: transactionId } }) }); } catch {}
        }

        // Fetch shoe sizes
        try {
          const sizes = await qamfCall(`centers/${centerId}/ShoesSize`);
          if (sizes?.CategoriesShoesSizes) setShoeCategories(sizes.CategoriesShoesSizes.filter((c: ShoeCategory) => c.Active));
        } catch {}

        let attempts = 0;
        pollInterval = setInterval(async () => {
          attempts++;
          try {
            if (opId) {
              const statusData = await qamfCall(`centers/${centerId}/reservations/${key}/status/${opId}`);
              if (statusData?.PaymentStatus === "COMPLETED" || statusData?.ReservationStatus === "CONFIRMED") {
                if (pollInterval) clearInterval(pollInterval);
                try { await qamfCall(`centers/${centerId}/reservations/${key}/SetEndFlow`, { method: "PATCH" }); } catch {}
                createBmiBill();
                setStatus("confirmed");
                sessionStorage.removeItem("qamf_session_token");
                sessionStorage.removeItem("qamf_confirm_data");
                return;
              }
            } else {
              const statusData = await qamfCall(`centers/${centerId}/reservations/${key}/status`);
              if (statusData === "Confirmed" || statusData === "CONFIRMED") {
                if (pollInterval) clearInterval(pollInterval);
                createBmiBill();
                setStatus("confirmed");
                sessionStorage.removeItem("qamf_session_token");
                sessionStorage.removeItem("qamf_confirm_data");
                return;
              }
            }
          } catch {}
          if (attempts >= 15) {
            if (pollInterval) clearInterval(pollInterval);
            createBmiBill();
            setStatus("confirmed");
            sessionStorage.removeItem("qamf_session_token");
          }
        }, 2000);
      } catch {
        if (transactionId) setStatus("confirmed");
        else setStatus("failed");
      }
    }
    confirm();
    return () => { if (pollInterval) clearInterval(pollInterval); };
  }, [key, centerId, transactionId]);

  const dateFormatted = reservation?.date
    ? new Date(reservation.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    : "";

  return (
    <div className="min-h-screen bg-[#0a1628] flex items-center justify-center px-4 py-12">
      <div className="max-w-md w-full">
        {status === "loading" && (
          <div className="text-center">
            <div className="inline-block w-12 h-12 border-2 border-white/20 border-t-[#fd5b56] rounded-full animate-spin mb-6" />
            <h1 className="font-[var(--font-hp-hero)] font-black uppercase text-white" style={{ fontSize: "clamp(24px, 5vw, 36px)", textShadow: `0 0 30px ${coral}30` }}>
              Confirming...
            </h1>
            <p className="font-[var(--font-hp-body)] text-white/50 text-sm mt-2">Processing your payment. Please don&apos;t close this page.</p>
          </div>
        )}

        {status === "confirmed" && (
          <div>
            {/* Header */}
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full mb-4" style={{ backgroundColor: `${gold}20`, border: `2px solid ${gold}` }}>
                <svg className="w-8 h-8" style={{ color: gold }} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <h1 className="font-[var(--font-hp-hero)] font-black uppercase text-white" style={{ fontSize: "clamp(24px, 5vw, 36px)", textShadow: `0 0 30px ${gold}30` }}>
                You&apos;re Booked!
              </h1>
            </div>

            {/* Booking Details */}
            {reservation && (
              <div className="rounded-lg p-5 mb-6" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${gold}30` }}>
                <h3 className="font-[var(--font-hp-body)] text-white font-bold text-sm mb-1">{reservation.offer}</h3>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm">{reservation.centerName}</p>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm">
                  {dateFormatted} {reservation.time ? `at ${formatTimeStr(reservation.time)}` : ""}
                </p>
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm">{reservation.players} bowlers</p>

                {/* Line items */}
                <div className="mt-3 pt-3 border-t border-white/10 space-y-1">
                  {reservation.tariffPrice && (
                    <div className="flex justify-between">
                      <span className="font-[var(--font-hp-body)] text-white/50 text-xs">{reservation.offer}</span>
                      <span className="font-[var(--font-hp-body)] text-white/50 text-xs">${reservation.tariffPrice.toFixed(2)}</span>
                    </div>
                  )}
                  {reservation.shoes && reservation.shoePrice && (
                    <div className="flex justify-between">
                      <span className="font-[var(--font-hp-body)] text-white/50 text-xs">Bowling Shoes x{reservation.players}</span>
                      <span className="font-[var(--font-hp-body)] text-white/50 text-xs">${((reservation.shoePrice || 0) * (reservation.players || 1)).toFixed(2)}</span>
                    </div>
                  )}
                  {reservation.addons?.map((a, i) => (
                    <div key={i} className="flex justify-between">
                      <span className="font-[var(--font-hp-body)] text-white/50 text-xs">
                        {a.name} {a.time ? `at ${formatBmiTime(a.time)}` : ""} {a.qty > 1 ? `x${a.qty}` : ""}
                      </span>
                      <span className="font-[var(--font-hp-body)] text-white/50 text-xs">${(a.price * a.qty).toFixed(2)}</span>
                    </div>
                  ))}
                </div>

                <p className="font-[var(--font-hp-body)] text-white/30 text-xs mt-3">Confirmation: {key}</p>
              </div>
            )}

            {/* Add-on booking status */}
            {reservation?.addons && reservation.addons.length > 0 && bmiStatus === "booking" && (
              <div className="rounded-lg p-4 mb-6 flex items-center gap-3" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1px solid ${cyan}30` }}>
                <div className="w-4 h-4 border-2 border-white/20 border-t-[#00E2E5] rounded-full animate-spin shrink-0" />
                <p className="font-[var(--font-hp-body)] text-white/60 text-sm">Reserving your add-on activities...</p>
              </div>
            )}
            {reservation?.addons && reservation.addons.length > 0 && bmiStatus === "done" && (
              <div className="rounded-lg p-4 mb-6" style={{ backgroundColor: `${cyan}10`, border: `1px solid ${cyan}30` }}>
                <p className="font-[var(--font-hp-body)] text-sm font-bold" style={{ color: cyan }}>Add-on activities confirmed!</p>
              </div>
            )}
            {reservation?.addons && reservation.addons.length > 0 && bmiStatus === "error" && (
              <div className="rounded-lg p-4 mb-6" style={{ backgroundColor: "rgba(253,91,86,0.1)", border: `1px solid rgba(253,91,86,0.3)` }}>
                <p className="font-[var(--font-hp-body)] text-white text-sm font-bold mb-1">No worries!</p>
                <p className="font-[var(--font-hp-body)] text-white/60 text-xs">We&apos;ll take care of your add-on activities at guest services when you arrive. Just mention your confirmation number.</p>
              </div>
            )}

            {/* Player Details Form */}
            {!playersSaved && players.length > 0 && (
              <div className="rounded-lg p-5 mb-6" style={{ backgroundColor: "rgba(7,16,39,0.5)", border: `1.78px dashed ${cyan}30` }}>
                <h3 className="font-[var(--font-hp-display)] uppercase text-white text-sm tracking-wider mb-1">Bowler Details</h3>
                <p className="font-[var(--font-hp-body)] text-white/40 text-xs mb-4">Enter names and shoe sizes for your party</p>

                <div className="space-y-4">
                  {players.map((p, i) => (
                    <div key={i} className="space-y-2">
                      <p className="font-[var(--font-hp-body)] text-white/50 text-xs font-bold">Bowler {i + 1}</p>
                      <input
                        type="text"
                        placeholder="Name"
                        value={p.name}
                        onChange={e => {
                          const next = [...players];
                          next[i] = { ...next[i], name: e.target.value };
                          setPlayers(next);
                        }}
                        className="w-full bg-[#0a1628] border border-white/20 rounded-lg px-3 py-2.5 text-white text-sm font-[var(--font-hp-body)] placeholder:text-white/20 focus:outline-none focus:border-[#00E2E5]/50"
                      />
                      <div className="flex gap-2">
                        <select
                          value={p.shoeSize}
                          onChange={e => {
                            const next = [...players];
                            const val = e.target.value;
                            let sizeObj = null;
                            for (const cat of shoeCategories) {
                              const found = cat.ShoesSize.find(s => s.Name === val);
                              if (found) { sizeObj = found; break; }
                            }
                            next[i] = { ...next[i], shoeSize: val, shoeSizeObj: sizeObj };
                            setPlayers(next);
                          }}
                          className="flex-1 bg-[#0a1628] border border-white/20 rounded-lg px-3 py-2.5 text-white text-sm font-[var(--font-hp-body)] focus:outline-none focus:border-[#00E2E5]/50 appearance-none"
                        >
                          <option value="">Shoe Size</option>
                          {shoeCategories.map(cat => (
                            <optgroup key={cat.Id} label={cat.DisplayName}>
                              {cat.ShoesSize.map(s => (
                                <option key={s.Id} value={s.Name}>{s.Name}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                        <button
                          onClick={() => {
                            const next = [...players];
                            next[i] = { ...next[i], wantBumpers: !next[i].wantBumpers };
                            setPlayers(next);
                          }}
                          className="px-3 py-2.5 rounded-lg text-xs font-bold font-[var(--font-hp-body)] transition-all cursor-pointer"
                          style={{
                            backgroundColor: p.wantBumpers ? `${cyan}20` : "transparent",
                            color: p.wantBumpers ? cyan : "rgba(255,255,255,0.4)",
                            border: `1px solid ${p.wantBumpers ? cyan + "50" : "rgba(255,255,255,0.2)"}`,
                          }}
                        >
                          Bumpers
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <button
                  onClick={savePlayers}
                  disabled={savingPlayers}
                  className="w-full mt-4 py-3 rounded-full font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider cursor-pointer transition-all hover:scale-[1.02] disabled:opacity-50"
                  style={{ backgroundColor: cyan, color: "#0a1628", boxShadow: `0 0 16px ${cyan}30` }}
                >
                  {savingPlayers ? "Saving..." : "Save Bowler Details"}
                </button>
              </div>
            )}

            {playersSaved && (
              <div className="rounded-lg p-4 mb-6 text-center" style={{ backgroundColor: `${cyan}10`, border: `1px solid ${cyan}30` }}>
                <p className="font-[var(--font-hp-body)] text-sm font-bold" style={{ color: cyan }}>Bowler details saved!</p>
              </div>
            )}

            <p className="font-[var(--font-hp-body)] text-white/50 text-sm mb-6 text-center">
              A confirmation email has been sent. Please arrive 15 minutes before your reservation time.
            </p>

            <div className="text-center">
              <Link href="/hp/fort-myers" className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105" style={{ boxShadow: `0 0 16px ${coral}30` }}>
                Back to HeadPinz
              </Link>
            </div>
          </div>
        )}

        {status === "failed" && (
          <div className="text-center">
            <h1 className="font-[var(--font-hp-hero)] font-black uppercase text-white" style={{ fontSize: "clamp(24px, 5vw, 36px)", textShadow: `0 0 30px ${coral}30` }}>
              Something Went Wrong
            </h1>
            <p className="font-[var(--font-hp-body)] text-white/50 text-sm mt-2 mb-6">
              {transactionId ? "Your payment was received but we couldn't confirm the reservation. Please contact us." : "We couldn't confirm your booking. Please contact us directly."}
            </p>
            {key && <p className="font-[var(--font-hp-body)] text-white/30 text-xs mb-4">Reference: {key}</p>}
            <a href="tel:+12393022155" className="inline-flex items-center bg-[#fd5b56] hover:bg-[#ff7a77] text-white font-[var(--font-hp-body)] font-bold text-sm uppercase tracking-wider px-8 py-3.5 rounded-full transition-all hover:scale-105">
              Call (239) 302-2155
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
