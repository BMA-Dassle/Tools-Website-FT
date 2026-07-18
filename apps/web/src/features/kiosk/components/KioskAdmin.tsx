"use client";

/**
 * Kiosk admin — staff device provisioning + comps. Reached via a hidden
 * gesture on the attract screen (5 taps in the top-left corner) → PIN. The
 * PIN is verified server-side on every call (KIOSK_ADMIN_PIN); nothing here
 * is guest-reachable.
 *
 * Tabs:
 *  - Device: location (venue → center+brand), kiosk #, design variant,
 *    card input method, dispenser/scanner/swipe toggles. Saves to BOTH
 *    localStorage (fast boot) and Neon (durable — pulled back after reimage).
 *  - Readers: live list of paired Square Terminals for the location (pick one
 *    with no code needed) OR pair a new one (device code the operator types
 *    into the Terminal) OR enter a device id directly.
 *  - Card reader: the CRT-591 dispenser/reader test panel (Web Serial) —
 *    connect, init, motion, dispense, RF/Mifare read-write, raw commands,
 *    TX/RX log. See docs/crt-591/README.md.
 *  - Diagnostics: reader ping, scanner test-read; the dispenser row opens the
 *    Card reader tab.
 *  - Comps: add race-credit comps to a signed-in person by BMI personId.
 */
import { useEffect, useRef, useState } from "react";
import { useKioskConfig } from "../KioskConfigContext";
import { kioskId, resolveKioskConfig, type KioskConfig, type KioskVariant } from "../config";
import { KioskAdminCardReader } from "./KioskAdminCardReader";

type Tab = "device" | "readers" | "cardreader" | "diag" | "comps";

const TAB_LABELS: Record<Tab, string> = {
  device: "Device",
  readers: "Readers",
  cardreader: "Card reader",
  diag: "Diagnostics",
  comps: "Comps",
};
type Reader = { deviceId: string; name: string; code: string; status: string };

async function adminFetch(pin: string, url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      "x-kiosk-admin-pin": pin,
      "content-type": "application/json",
    },
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

const VENUES: Array<{ label: string; center: KioskConfig["center"]; brand: KioskConfig["brand"] }> =
  [
    { label: "FastTrax — Fort Myers", center: "fort-myers", brand: "fasttrax" },
    { label: "HeadPinz — Fort Myers", center: "fort-myers", brand: "headpinz" },
    { label: "HeadPinz — Naples", center: "naples", brand: "headpinz" },
  ];

export function KioskAdmin() {
  const { config, setConfig } = useKioskConfig();
  const [pin, setPin] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("device");
  const [msg, setMsg] = useState<string | null>(null);

  // Draft config — seeded from the live device config.
  const [draft, setDraft] = useState<Partial<KioskConfig>>(
    () => config ?? { center: "fort-myers", brand: "fasttrax" },
  );

  // The config store returns the null SSR snapshot on the hydration render, so
  // the useState initializer above captures null and the fields would show
  // defaults, not the saved setup. Re-seed the draft the moment the real config
  // hydrates (or changes) — but only until the staff start editing, so a save
  // (which updates config) never clobbers an in-progress edit. (Owner 2026-07-19:
  // "the admin should load all current settings in all the fields".)
  const seeded = useRef(false);
  useEffect(() => {
    if (config && !seeded.current) {
      seeded.current = true;
      setDraft(config);
    }
  }, [config]);

  const patch = (p: Partial<KioskConfig>) => {
    seeded.current = true; // staff touched a field — stop auto-reseeding
    setDraft((d) => ({ ...d, ...p }));
  };

  /** Persist the draft (+ optional change) to BOTH localStorage and Neon in one
   *  step — so selecting a reader (or any change) actually saves, no separate
   *  "go to Device tab and Save" trap (owner: settings didn't seem to save). */
  const persist = async (extra: Partial<KioskConfig> = {}) => {
    const merged = { ...draft, ...extra };
    setDraft(merged);
    const resolved = resolveKioskConfig(merged);
    if (!resolved) {
      setMsg("Pick a location on the Device tab first.");
      return;
    }
    setConfig(resolved); // localStorage (fast boot) + notifies the store
    const { ok } = await adminFetch(pin, "/api/kiosk/admin", {
      method: "POST",
      body: JSON.stringify({
        action: "save-config",
        center: resolved.center,
        brand: resolved.brand,
        kioskNumber: resolved.kioskNumber,
        config: resolved,
      }),
    });
    setMsg(
      ok
        ? `Saved — kiosk ${kioskId(resolved)} (this device + cloud).`
        : "Saved on this device; cloud save failed (check DB).",
    );
  };

  const tryAuth = async () => {
    setAuthError(null);
    // "devices" is a cheap authed GET — use it to validate the PIN.
    const { ok, status } = await adminFetch(pin, "/api/kiosk/admin?action=devices");
    if (ok) setAuthed(true);
    else setAuthError(status === 401 ? "Wrong PIN" : "Couldn't reach admin API");
  };

  if (!authed) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-[#000418] px-8">
        <div className="w-full max-w-sm space-y-5 rounded-3xl border border-white/10 bg-[#0d1a36] p-8 text-center">
          <div className="font-heading text-3xl font-extrabold italic">Kiosk admin</div>
          <p className="text-sm text-white/55">Staff PIN required.</p>
          <input
            type="password"
            inputMode="numeric"
            data-osk-layout="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && tryAuth()}
            placeholder="PIN"
            className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3.5 text-center text-2xl tracking-[0.4em] text-white focus:border-[#00E2E5] focus:outline-none"
          />
          {authError && <p className="text-sm text-red-300">{authError}</p>}
          <button
            type="button"
            onClick={tryAuth}
            className="w-full rounded-xl bg-[#00e2e5] px-5 py-3 font-bold text-[#04252b]"
          >
            Unlock
          </button>
          <a href="/kiosk" className="block text-xs text-white/40">
            Back to kiosk
          </a>
        </div>
      </div>
    );
  }

  return (
    // absolute inset-0 + scroll: the admin lives inside the fixed 1080×1920
    // canvas (overflow-hidden), so it needs its OWN scroll or long lists (the
    // reader picker) get clipped — the "can't scroll down" bug.
    <div className="absolute inset-0 overflow-y-auto bg-[#000418] px-6 py-8 text-white">
      <div className="mx-auto max-w-2xl space-y-6 pb-16">
        <div className="flex items-center justify-between">
          <div className="font-heading text-3xl font-extrabold italic">Kiosk admin</div>
          <a
            href="/kiosk"
            className="rounded-full border border-white/15 px-5 py-2 text-sm text-white/60"
          >
            Exit to kiosk
          </a>
        </div>

        <div className="flex gap-2">
          {(["device", "readers", "cardreader", "diag", "comps"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-full px-5 py-2 text-sm font-bold ${
                tab === t ? "bg-[#00e2e5] text-[#04252b]" : "border border-white/15 text-white/60"
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2 text-xs text-white/55">
          {config ? (
            <>
              Currently saved on this device:{" "}
              <span className="font-semibold text-white/80">
                {config.brand}/{config.center} #{config.kioskNumber ?? 1}
              </span>{" "}
              · {config.readerId ? `reader ${config.readerId}` : "no reader"} ·{" "}
              {config.cardInputMethod ?? "manual"} · {config.variant}
            </>
          ) : (
            "Nothing saved on this device yet — pick a location on the Device tab and Save."
          )}
        </div>

        {msg && (
          <div className="rounded-xl border border-[#00e2e5]/40 bg-[#00e2e5]/10 px-4 py-3 text-sm">
            {msg}
          </div>
        )}

        {tab === "device" && (
          <DeviceTab draft={draft} patch={patch} onSave={() => void persist()} />
        )}

        {tab === "readers" && (
          <ReadersTab
            center={draft.center ?? "fort-myers"}
            brand={draft.brand ?? "fasttrax"}
            selected={draft.readerId ?? null}
            pin={pin}
            onSelect={(id) => void persist({ readerId: id, cardInputMethod: "reader" })}
            setMsg={setMsg}
          />
        )}

        {tab === "cardreader" && (
          <KioskAdminCardReader draft={draft} persist={persist} setMsg={setMsg} />
        )}

        {tab === "diag" && (
          <DiagTab
            draft={draft}
            pin={pin}
            setMsg={setMsg}
            onOpenCardReader={() => setTab("cardreader")}
          />
        )}

        {tab === "comps" && <CompsTab pin={pin} setMsg={setMsg} />}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-widest text-white/40">
        {label}
      </span>
      {children}
    </label>
  );
}

const selectClass =
  // color-scheme:dark makes the NATIVE dropdown popup render dark too — otherwise
  // the open <option> list is white-on-white and unreadable (owner 2026-07-19).
  "w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-white [color-scheme:dark] focus:border-[#00E2E5] focus:outline-none";

function DeviceTab({
  draft,
  patch,
  onSave,
}: {
  draft: Partial<KioskConfig>;
  patch: (p: Partial<KioskConfig>) => void;
  onSave: () => void;
}) {
  const venueValue = VENUES.findIndex((v) => v.center === draft.center && v.brand === draft.brand);
  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <Field label="Location">
        <select
          className={selectClass}
          value={venueValue < 0 ? "" : venueValue}
          onChange={(e) => {
            const v = VENUES[Number(e.target.value)];
            if (v) patch({ center: v.center, brand: v.brand });
          }}
        >
          <option value="" disabled>
            Choose a venue…
          </option>
          {VENUES.map((v, i) => (
            <option key={v.label} value={i}>
              {v.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Kiosk number">
        <input
          type="number"
          min={1}
          data-osk="off"
          value={draft.kioskNumber ?? 1}
          onChange={(e) => patch({ kioskNumber: Number(e.target.value) || 1 })}
          className={selectClass}
        />
      </Field>
      <Field label="Theme / design">
        <select
          className={selectClass}
          value={draft.variant ?? "podium"}
          onChange={(e) => patch({ variant: e.target.value as KioskVariant })}
        >
          <option value="podium">Version A — Podium (cinematic)</option>
          <option value="pitcrew">Version C — Pit Crew (one question at a time)</option>
        </select>
      </Field>
      <Field label="Card input method">
        <select
          className={selectClass}
          value={draft.cardInputMethod ?? "manual"}
          onChange={(e) =>
            patch({ cardInputMethod: e.target.value as KioskConfig["cardInputMethod"] })
          }
        >
          <option value="manual">Type in card (Square iframe)</option>
          <option value="reader">Square reader (card-present)</option>
          <option value="swipe">USB card swipe</option>
        </select>
        {draft.cardInputMethod === "reader" && !draft.readerId && (
          <p className="mt-2 text-xs text-amber-300">
            Pick a reader on the Readers tab — that also sets this to “Square reader”.
          </p>
        )}
        {draft.cardInputMethod === "reader" && draft.readerId && (
          <p className="mt-2 text-xs text-white/40">Reader: {draft.readerId}</p>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Toggle
          label="QR / barcode scanner"
          on={!!draft.scannerEnabled}
          onToggle={(v) => patch({ scannerEnabled: v })}
        />
        <Toggle
          label="USB card swipe attached"
          on={!!draft.swipeEnabled}
          onToggle={(v) => patch({ swipeEnabled: v })}
        />
        <Toggle
          label="CRT-591 card reader (COM)"
          on={!!draft.cardReaderEnabled}
          onToggle={(v) => patch({ cardReaderEnabled: v })}
        />
      </div>
      <Field label="Game Zone card dispenser device id (optional)">
        <input
          type="text"
          data-osk="off"
          value={draft.dispenserId ?? ""}
          onChange={(e) => patch({ dispenserId: e.target.value || null })}
          placeholder="e.g. USB dispenser serial"
          className={selectClass}
        />
        <p className="mt-1.5 text-xs text-white/40">
          A dispenser reads &amp; writes cards → this kiosk can BUY new + RELOAD Game Zone cards.
        </p>
      </Field>
      <Toggle
        label="Game Zone card reader (MSR) — reload only"
        on={!!draft.msrEnabled}
        onToggle={(v) => patch({ msrEnabled: v })}
      />
      <p className="-mt-2 text-xs text-white/40">
        {draft.dispenserId
          ? "Dispenser present → full Game Zone (buy + reload); MSR setting ignored."
          : draft.msrEnabled
            ? "No dispenser → Game Zone is RELOAD ONLY on this kiosk."
            : "No dispenser and no MSR → Game Zone cards are UNAVAILABLE on this kiosk."}
      </p>
      <button
        type="button"
        onClick={onSave}
        className="w-full rounded-xl bg-[#00e2e5] px-5 py-3.5 font-bold text-[#04252b]"
      >
        Save setup (local + cloud)
      </button>
    </div>
  );
}

function Toggle({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!on)}
      className={`flex items-center justify-between rounded-xl border px-4 py-3 text-left text-sm ${
        on ? "border-[#00e2e5]/50 bg-[#00e2e5]/10" : "border-white/10 bg-white/[0.02] text-white/55"
      }`}
    >
      <span>{label}</span>
      <span
        className={`ml-3 shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${on ? "bg-[#00e2e5] text-[#04252b]" : "bg-white/10 text-white/50"}`}
      >
        {on ? "ON" : "OFF"}
      </span>
    </button>
  );
}

function ReadersTab({
  center,
  brand,
  selected,
  pin,
  onSelect,
  setMsg,
}: {
  center: string;
  brand: string;
  selected: string | null;
  pin: string;
  onSelect: (id: string) => void;
  setMsg: (m: string) => void;
}) {
  const [readers, setReaders] = useState<Reader[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [manualId, setManualId] = useState("");

  const load = async () => {
    setLoading(true);
    const { ok, data } = await adminFetch(
      pin,
      `/api/kiosk/admin?action=readers&center=${center}&brand=${brand}`,
    );
    setReaders(ok ? (data.readers ?? []) : []);
    setLoading(false);
    if (!ok) setMsg("Couldn't load readers (check SQUARE_ACCESS_TOKEN).");
  };

  const pair = async () => {
    const { ok, data } = await adminFetch(pin, "/api/kiosk/admin", {
      method: "POST",
      body: JSON.stringify({ action: "pair-reader", center, brand, name: `Kiosk ${center}` }),
    });
    if (ok && data.pairing?.code) {
      setMsg(
        `On the Square Terminal: Settings → Sign in → enter pairing code ${data.pairing.code}. Then reload this list.`,
      );
    } else {
      setMsg("Pairing failed.");
    }
  };

  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={load}
          className="rounded-xl bg-[#00e2e5] px-5 py-2.5 text-sm font-bold text-[#04252b]"
        >
          {loading ? "Loading…" : "Load paired readers"}
        </button>
        <button
          type="button"
          onClick={pair}
          className="rounded-xl border border-white/15 px-5 py-2.5 text-sm font-bold text-white/70"
        >
          Pair a new reader
        </button>
      </div>

      {readers && readers.length === 0 && (
        <p className="text-sm text-white/50">
          No paired readers at this location yet — pair one above.
        </p>
      )}
      <div className="space-y-2">
        {readers?.map((r) => (
          <button
            key={r.deviceId}
            type="button"
            onClick={() => onSelect(r.deviceId)}
            className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left ${
              selected === r.deviceId
                ? "border-[#00e2e5] bg-[#00e2e5]/10"
                : "border-white/10 bg-white/[0.02]"
            }`}
          >
            <div>
              <div className="font-semibold">{r.name}</div>
              <div className="text-xs text-white/40">{r.deviceId}</div>
            </div>
            <span
              className={`text-xs font-bold ${r.status === "PAIRED" ? "text-[#46d68c]" : "text-white/40"}`}
            >
              {r.status}
            </span>
          </button>
        ))}
      </div>

      <Field label="…or enter a known device id (no pairing code needed)">
        <div className="flex gap-2">
          <input
            type="text"
            data-osk="off"
            value={manualId}
            onChange={(e) => setManualId(e.target.value)}
            placeholder="Square device id"
            className={selectClass}
          />
          <button
            type="button"
            onClick={() => manualId.trim() && onSelect(manualId.trim())}
            className="rounded-xl border border-white/15 px-5 py-2.5 text-sm font-bold text-white/70"
          >
            Use
          </button>
        </div>
      </Field>
    </div>
  );
}

function DiagTab({
  draft,
  pin,
  setMsg,
  onOpenCardReader,
}: {
  draft: Partial<KioskConfig>;
  pin: string;
  setMsg: (m: string) => void;
  onOpenCardReader: () => void;
}) {
  const pingReader = async () => {
    if (!draft.readerId) return setMsg("No reader selected.");
    const { ok, data } = await adminFetch(
      pin,
      `/api/kiosk/admin?action=readers&center=${draft.center}&brand=${draft.brand}`,
    );
    const found =
      ok &&
      (data.readers ?? []).some(
        (r: Reader) => r.deviceId === draft.readerId && r.status === "PAIRED",
      );
    setMsg(found ? "Reader is paired and reachable." : "Reader NOT found paired at this location.");
  };
  return (
    <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <DiagRow
        label="Square reader"
        detail={draft.readerId ?? "none"}
        action="Ping"
        onRun={pingReader}
      />
      <DiagRow
        label="QR / barcode scanner"
        detail={draft.scannerEnabled ? "enabled — focus a field and scan" : "disabled"}
        action="Test"
        onRun={() =>
          setMsg("Scan a code into any text field on the flow — it types like a keyboard.")
        }
      />
      <DiagRow
        label="USB card swipe"
        detail={draft.swipeEnabled ? "enabled" : "disabled"}
        action="Test"
        onRun={() => setMsg("Swipe test wires up with the reader/swipe payment build.")}
      />
      <DiagRow
        label="Card reader / dispenser (CRT-591)"
        detail={
          draft.cardReaderEnabled
            ? `enabled — ${draft.dispenserId ?? "serial pending"} @ ${draft.cardReaderBaud ?? "auto"} baud`
            : "not set up"
        }
        action="Open panel"
        onRun={onOpenCardReader}
      />
    </div>
  );
}

function DiagRow({
  label,
  detail,
  action,
  onRun,
}: {
  label: string;
  detail: string;
  action: string;
  onRun: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
      <div>
        <div className="font-semibold">{label}</div>
        <div className="text-xs text-white/40">{detail}</div>
      </div>
      <button
        type="button"
        onClick={onRun}
        className="rounded-lg border border-white/15 px-4 py-2 text-sm font-bold text-white/70"
      >
        {action}
      </button>
    </div>
  );
}

function CompsTab({ pin, setMsg }: { pin: string; setMsg: (m: string) => void }) {
  const [personId, setPersonId] = useState("");
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!personId.trim() || !Number(amount))
      return setMsg("Enter a personId and a non-zero amount.");
    setBusy(true);
    const { ok, data } = await adminFetch(pin, "/api/kiosk/admin", {
      method: "POST",
      body: JSON.stringify({ action: "comp", personId: personId.trim(), amount: Number(amount) }),
    });
    setBusy(false);
    setMsg(
      ok ? `Comp added — deposit ${data.depositId}.` : `Comp failed: ${data.error ?? "error"}`,
    );
  };
  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <p className="text-sm text-white/55">
        Add comp race credits to a racer by BMI personId (from their signed-in account). Uses the
        same deposit rail as booking credits — game-token comps route through the Game Zone bridge
        once it lands.
      </p>
      <Field label="BMI personId">
        <input
          type="text"
          data-osk="off"
          value={personId}
          onChange={(e) => setPersonId(e.target.value)}
          className={selectClass}
        />
      </Field>
      <Field label="Comp credits (amount)">
        <input
          type="number"
          data-osk="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className={selectClass}
        />
      </Field>
      <button
        type="button"
        disabled={busy}
        onClick={submit}
        className="w-full rounded-xl bg-[#00e2e5] px-5 py-3.5 font-bold text-[#04252b] disabled:opacity-40"
      >
        {busy ? "Adding…" : "Add comp"}
      </button>
    </div>
  );
}
