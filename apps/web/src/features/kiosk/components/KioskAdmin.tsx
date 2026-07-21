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
import {
  kioskDeviceKey,
  resolveKioskConfig,
  venueSlug,
  type KioskConfig,
  type KioskVariant,
} from "../config";
import { KioskAdminCardReader } from "./KioskAdminCardReader";
import { KioskAdminMsr } from "./KioskAdminMsr";
import { KIOSK_VERSION } from "../version";

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
  // Which copy the form currently reflects. Edge kiosk mode and regular Edge are
  // different browser profiles with different localStorage, so "local" may be
  // stale — the chip tells staff whether they're editing this device's LOCAL
  // seed, a CLOUD copy they pulled, or unsaved EDITS.
  const [source, setSource] = useState<"local" | "cloud" | "edited">("local");

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

  // Pull the saved config from NEON when staff unlock the admin, so every field
  // (COM/port info, baud, reader id, toggles, cameras — everything) reflects the
  // cloud, the source of truth, not just this browser profile's localStorage
  // (Edge kiosk mode vs regular Edge are different profiles). Runs once per
  // unlock, keyed on the device's real saved identity; if the device has no
  // local identity yet, staff use the "Load from cloud" picker instead. Seeds
  // the FORM only (source→cloud); Save writes it back to this device.
  const pulledCloud = useRef(false);
  useEffect(() => {
    if (!authed || pulledCloud.current || !config?.center) return;
    pulledCloud.current = true;
    const id = kioskDeviceKey(config);
    void (async () => {
      const { ok, data } = await adminFetch(
        pin,
        `/api/kiosk/admin?action=config&kioskId=${encodeURIComponent(id)}`,
      );
      const cloudCfg = ok ? (data?.device?.config as Partial<KioskConfig> | undefined) : undefined;
      const resolved = cloudCfg ? resolveKioskConfig(cloudCfg) : null;
      if (!resolved) return;
      seeded.current = true; // stop the local-seed effect from clobbering the pull
      setDraft(resolved);
      setSource("cloud");
      setMsg(`Loaded saved setup from cloud — ${id}.`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  const patch = (p: Partial<KioskConfig>) => {
    seeded.current = true; // staff touched a field — stop auto-reseeding
    setSource("edited");
    setDraft((d) => ({ ...d, ...p }));
  };

  /** CloudSetups "Load & apply" wrapper: same as persist, but marks the form as
   *  reflecting the CLOUD copy so the source chip is truthful (staff pulled it
   *  from Neon, not this device's local seed). */
  const applyCloud = (extra: Partial<KioskConfig> = {}) => {
    setSource("cloud");
    return persist(extra);
  };

  /** Persist the draft (+ optional change) to BOTH localStorage and Neon in one
   *  step — so selecting a reader (or any change) actually saves, no separate
   *  "go to Device tab and Save" trap (owner: settings didn't seem to save).
   *  Returns whether the CLOUD save succeeded (local always happens). */
  const persist = async (extra: Partial<KioskConfig> = {}): Promise<boolean> => {
    const merged = { ...draft, ...extra };
    setDraft(merged);
    const resolved = resolveKioskConfig(merged);
    if (!resolved) {
      setMsg("Pick a location on the Device tab first.");
      return false;
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
        ? `Saved — kiosk ${kioskDeviceKey(resolved)} (this device + cloud).`
        : "Saved on this device; cloud save failed (check DB).",
    );
    // A save clears the "unsaved edits" state (now it IS the saved local setup);
    // a cloud-sourced form stays "cloud".
    if (ok) setSource((s) => (s === "edited" ? "local" : s));
    return ok;
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
          <div className="flex items-baseline gap-3">
            <div className="font-heading text-3xl font-extrabold italic">Kiosk admin</div>
            <span className="text-xs font-semibold text-white/40">v{KIOSK_VERSION}</span>
          </div>
          <a
            href="/kiosk"
            // Flag the attract screen to re-run the device boot-check on return,
            // so staff can confirm the reader/bridge/cameras right after editing.
            onClick={() => {
              try {
                sessionStorage.setItem("kioskBootCheck", "1");
              } catch {
                /* sessionStorage unavailable — ignore */
              }
            }}
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

        {/* One status bar: what identity you're editing + where it came from
            (Local seed / Cloud pull / Unsaved edits). Replaces the old stacked
            "saved on this device" + source-chip pair. */}
        {draft.center ? (
          <div
            className={`space-y-1 rounded-xl border px-4 py-2.5 text-xs ${
              source === "cloud"
                ? "border-[#46d68c]/40 bg-[#46d68c]/10"
                : source === "edited"
                  ? "border-amber-400/40 bg-amber-400/10"
                  : "border-white/10 bg-white/[0.02]"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-white/70">
                Editing{" "}
                <span className="font-semibold text-white/90">
                  {draft.center === "naples"
                    ? "HeadPinz — Naples"
                    : draft.brand === "headpinz"
                      ? "HeadPinz — Fort Myers"
                      : "FastTrax — Fort Myers"}{" "}
                  #{draft.kioskNumber ?? 1}
                </span>
                <span className="ml-2 font-mono text-white/35">
                  {kioskDeviceKey({
                    center: draft.center,
                    brand: draft.brand ?? "fasttrax",
                    kioskNumber: draft.kioskNumber ?? 1,
                  })}
                </span>
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${
                  source === "cloud"
                    ? "bg-[#46d68c]/20 text-[#46d68c]"
                    : source === "edited"
                      ? "bg-amber-400/20 text-amber-200"
                      : "bg-white/10 text-white/50"
                }`}
              >
                {source === "cloud" ? "Cloud" : source === "edited" ? "Unsaved" : "Local"}
              </span>
            </div>
            <div className="text-white/45">
              {source === "cloud"
                ? "Loaded from the cloud — Save to keep it on this device."
                : source === "edited"
                  ? "Unsaved changes — Save to write them to this device + cloud."
                  : "This device's local setup. Load from cloud below if it looks wrong."}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-2.5 text-xs text-white/55">
            Nothing set up on this device yet — pick a location below, or Load from cloud.
          </div>
        )}

        {msg && (
          <div className="rounded-xl border border-[#00e2e5]/40 bg-[#00e2e5]/10 px-4 py-3 text-sm">
            {msg}
          </div>
        )}

        {tab === "device" && (
          <DeviceTab
            draft={draft}
            patch={patch}
            persist={persist}
            cloudPersist={applyCloud}
            pin={pin}
            setMsg={setMsg}
          />
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

/** Section divider inside a settings card — groups a long flat form into
 *  scannable blocks (first one has no top margin). */
function SectionLabel({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <div
      className={`border-b border-white/10 pb-1.5 text-xs font-bold uppercase tracking-widest text-[#00e2e5]/70 ${
        first ? "" : "pt-2"
      }`}
    >
      {children}
    </div>
  );
}

const selectClass =
  // color-scheme:dark makes the NATIVE dropdown popup render dark too — otherwise
  // the open <option> list is white-on-white and unreadable (owner 2026-07-19).
  "w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-white [color-scheme:dark] focus:border-[#00E2E5] focus:outline-none";

function DeviceTab({
  draft,
  patch,
  persist,
  cloudPersist,
  pin,
  setMsg,
}: {
  draft: Partial<KioskConfig>;
  patch: (p: Partial<KioskConfig>) => void;
  persist: (extra?: Partial<KioskConfig>) => void | Promise<unknown>;
  cloudPersist: (extra?: Partial<KioskConfig>) => void | Promise<unknown>;
  pin: string;
  setMsg: (m: string) => void;
}) {
  const venueValue = VENUES.findIndex((v) => v.center === draft.center && v.brand === draft.brand);
  const currentId = kioskDeviceKey({
    center: draft.center ?? "fort-myers",
    brand: draft.brand ?? "fasttrax",
    kioskNumber: draft.kioskNumber ?? 1,
  });

  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const save = async () => {
    setSaveState("saving");
    const ok = await persist();
    setSaveState(ok ? "saved" : "failed");
    setTimeout(() => setSaveState("idle"), 4000);
  };

  // The URL to pin as the kiosk's launch shortcut (Edge kiosk mode AND any
  // regular shortcut). Identity in the URL → every browser profile on this PC
  // resolves to the same Neon setup, ending the localStorage mismatch between
  // kiosk mode and regular Edge. Lazy init (not an effect) — DeviceTab only
  // mounts client-side after auth, so window is defined.
  const [origin] = useState(() => (typeof window !== "undefined" ? window.location.origin : ""));
  const slug = draft.center
    ? venueSlug({ center: draft.center, brand: draft.brand ?? "fasttrax" })
    : null;
  const launchUrl = slug ? `${origin}/kiosk?center=${slug}&kiosk=${draft.kioskNumber ?? 1}` : null;
  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
      <SectionLabel first>Identity</SectionLabel>
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
      <SectionLabel>Payment</SectionLabel>
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
      <SectionLabel>Hardware — scanners &amp; Game Zone</SectionLabel>
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
      {draft.msrEnabled && <KioskAdminMsr draft={draft} persist={persist} />}
      <p className="text-xs text-white/40">
        {draft.dispenserId
          ? "Dispenser present → full Game Zone (buy + reload); MSR setting ignored."
          : draft.msrEnabled
            ? "No dispenser → Game Zone is RELOAD ONLY on this kiosk."
            : "No dispenser and no MSR → Game Zone cards are UNAVAILABLE on this kiosk."}
      </p>
      <SectionLabel>Cameras</SectionLabel>
      <CameraPickers draft={draft} patch={patch} />
      <SectionLabel>Cloud &amp; launch</SectionLabel>
      <CloudSetups pin={pin} persist={cloudPersist} setMsg={setMsg} currentId={currentId} />
      {launchUrl && (
        <div className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-4">
          <div className="text-xs font-semibold uppercase tracking-widest text-white/40">
            Launch URL for this kiosk
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-black/30 px-3 py-2 font-mono text-xs text-[#00e2e5]">
              {launchUrl}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(launchUrl)
                  .then(() => setMsg("Launch URL copied."))
                  .catch(() => setMsg("Couldn't copy — select and copy it manually."));
              }}
              className="shrink-0 rounded-lg border border-white/15 px-4 py-2 text-xs font-bold text-white/70"
            >
              Copy
            </button>
          </div>
          <p className="text-xs text-white/40">
            Pin this as the shortcut for BOTH Edge kiosk mode and any normal launch on this PC.
            Because the kiosk (<span className="font-mono">{slug}</span> #{draft.kioskNumber ?? 1})
            is in the URL, every browser profile loads the same cloud setup — no more mismatched
            config.
          </p>
        </div>
      )}
      <button
        type="button"
        disabled={saveState === "saving"}
        onClick={() => void save()}
        className={`w-full rounded-xl px-5 py-3.5 font-bold text-[#04252b] disabled:opacity-60 ${
          saveState === "saved"
            ? "bg-[#46d68c]"
            : saveState === "failed"
              ? "bg-amber-400"
              : "bg-[#00e2e5]"
        }`}
      >
        {saveState === "saving"
          ? "Saving…"
          : saveState === "saved"
            ? "✓ Saved (this device + cloud)"
            : saveState === "failed"
              ? "Saved locally — cloud save failed, tap to retry"
              : "Save setup (local + cloud)"}
      </button>
      {saveState === "saved" && (
        <p className="text-center text-xs text-[#46d68c]">
          Saved to this device and the cloud. Reopen admin any time to reload it.
        </p>
      )}
    </div>
  );
}

/**
 * Saved kiosk setups in Neon (kiosk_devices) — every Save writes there, and a
 * reimaged/blank device pulls its setup back at boot ONLY via the provisioning
 * URL. This block is the manual path: list every provisioned kiosk, tap Load
 * to APPLY the cloud copy to this device (persist → localStorage + cloud), so
 * the kiosk boots with it next time — no re-typing, no URL params.
 */
function CloudSetups({
  pin,
  persist,
  setMsg,
  currentId,
}: {
  pin: string;
  persist: (extra?: Partial<KioskConfig>) => void | Promise<unknown>;
  setMsg: (m: string) => void;
  currentId: string;
}) {
  const [devices, setDevices] = useState<Array<{
    kioskId: string;
    brand: string;
    config: Partial<KioskConfig>;
    updatedAt: string;
  }> | null>(null);
  const [loading, setLoading] = useState(false);

  const loadList = async () => {
    setLoading(true);
    const { ok, data } = await adminFetch(pin, "/api/kiosk/admin?action=devices");
    setLoading(false);
    if (!ok) {
      setMsg("Couldn't reach the cloud registry (check DB).");
      return;
    }
    const list = (data as { devices?: CloudDevice[] }).devices ?? [];
    setDevices(list);
    if (list.length === 0) setMsg("No kiosk setups saved in the cloud yet.");
  };

  const summarize = (c: Partial<KioskConfig>) =>
    [
      c.variant ?? "podium",
      c.readerId ? "Square reader" : (c.cardInputMethod ?? "manual"),
      c.dispenserId ? "dispenser" : c.msrEnabled ? "MSR" : null,
      c.scannerEnabled ? "scanner" : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">Saved setups (cloud)</div>
        <button
          type="button"
          onClick={() => void loadList()}
          disabled={loading}
          className="rounded-xl border border-white/15 px-4 py-2 text-sm font-bold text-white/70 disabled:opacity-40"
        >
          {loading ? "Loading…" : devices ? "Refresh" : "Load from cloud"}
        </button>
      </div>
      {devices?.length ? (
        <div className="space-y-2">
          {devices.map((d) => (
            <div
              key={d.kioskId}
              className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  {d.brand}/{d.kioskId}
                  {d.kioskId === currentId && (
                    <span className="ml-2 rounded-full bg-[#00e2e5]/15 px-2 py-0.5 text-[11px] font-bold text-[#00e2e5]">
                      THIS KIOSK
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-white/45">{summarize(d.config)}</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  // persist = fill the form AND save to localStorage + cloud in
                  // one tap, so the kiosk opens with this setup on next boot.
                  void persist(d.config);
                }}
                className="shrink-0 rounded-xl bg-[#00e2e5] px-4 py-2 text-sm font-bold text-[#04252b]"
              >
                Load &amp; apply
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-white/40">
          Every Save also writes this kiosk&rsquo;s setup to the cloud. Load &amp; apply pulls a
          saved kiosk&rsquo;s settings onto THIS device (saved locally — it boots with them next
          time).
        </p>
      )}
    </div>
  );
}

type CloudDevice = {
  kioskId: string;
  brand: string;
  config: Partial<KioskConfig>;
  updatedAt: string;
};

/**
 * Guest-photo camera pickers (owner 2026-07-18: waiver-time photo, some kiosks
 * have an UPPER + LOWER camera). "Detect cameras" asks for the one-time camera
 * permission (labels are blank until granted), then lists videoinputs for each
 * slot. Single-camera kiosks set Upper only; clearing both disables capture
 * (the waiver flow falls back to a photo-at-check-in marker).
 */
function CameraPickers({
  draft,
  patch,
}: {
  draft: Partial<KioskConfig>;
  patch: (p: Partial<KioskConfig>) => void;
}) {
  const [cams, setCams] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const [previewOn, setPreviewOn] = useState(false);

  /**
   * Fire the browser's permission POPUP directly (owner 2026-07-18: a button
   * that makes Edge prompt Allow) and PROVE the camera with a 5s live preview.
   * If Edge was previously set to Block, getUserMedia rejects WITHOUT
   * prompting — the failure message spells out where to unblock. Also reports
   * the Web-Serial (card reader) grant status; that one is a device PICKER,
   * paired deliberately on the Card Reader tab.
   */
  const requestPermissions = async () => {
    setDetectMsg("Asking the browser for camera permission…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      setPreviewOn(true);
      // Live proof for 5s, then release the camera.
      requestAnimationFrame(() => {
        if (previewRef.current) {
          previewRef.current.srcObject = stream;
          void previewRef.current.play().catch(() => {});
        }
      });
      setTimeout(() => {
        stream.getTracks().forEach((t) => t.stop());
        setPreviewOn(false);
      }, 5000);
      // Labels populate after a grant — refresh the pickers too.
      const devices = await navigator.mediaDevices.enumerateDevices();
      const vids = devices
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
      setCams(vids);
      let serialNote = "";
      try {
        const nav = navigator as Navigator & { serial?: { getPorts(): Promise<unknown[]> } };
        if (nav.serial) {
          const ports = await nav.serial.getPorts();
          serialNote =
            ports.length > 0
              ? " Card-reader serial: already granted."
              : " Card-reader serial: pair it on the Card Reader tab.";
        }
      } catch {
        /* serial status is informational only */
      }
      setDetectMsg(
        `Camera permission GRANTED — ${vids.length} camera(s) available. Assign them below.${serialNote}`,
      );
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      setDetectMsg(
        name === "NotAllowedError"
          ? "Blocked without prompting — Edge has this site set to Block. Click the camera icon in the address bar (or edge://settings/content/camera) and set Allow, AND check Windows Settings → Privacy & security → Camera → 'Let desktop apps access your camera'. Then tap this again."
          : name === "NotFoundError"
            ? "No camera detected on this PC — check the USB connection."
            : name === "NotReadableError"
              ? "Another app is holding the camera (close Teams/Zoom/Camera) and try again."
              : `Permission request failed${err instanceof Error && err.message ? `: ${err.message}` : ""}`,
      );
    }
  };

  const detect = async () => {
    setDetectMsg("Detecting…");
    try {
      // Grant once so enumerateDevices returns real labels; stop immediately.
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const vids = devices
        .filter((d) => d.kind === "videoinput")
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
      setCams(vids);
      setDetectMsg(vids.length === 0 ? "No cameras found." : `${vids.length} camera(s) found.`);
    } catch (err) {
      // Name the failure precisely — "NotAllowedError" with the SITE permission
      // set to Allow almost always means the WINDOWS privacy toggle: Settings →
      // Privacy & security → Camera → "Let desktop apps access your camera".
      const name = err instanceof DOMException ? err.name : "";
      const hint =
        name === "NotAllowedError"
          ? " — if Chrome's site permission is Allow, check Windows Settings → Privacy & security → Camera → 'Let desktop apps access your camera'."
          : name === "NotFoundError"
            ? " — no camera detected on this PC (check the USB connection)."
            : name === "NotReadableError"
              ? " — another app is using the camera (close Teams/Zoom/Camera)."
              : "";
      setDetectMsg(
        `Camera check failed${name ? ` (${name})` : ""}${
          err instanceof Error && err.message ? `: ${err.message}` : ""
        }${hint}`,
      );
    }
  };

  const camSelect = (
    label: string,
    value: string | null | undefined,
    onPick: (id: string | null) => void,
  ) => (
    <Field label={label}>
      <select
        className={selectClass}
        value={value ?? ""}
        onChange={(e) => onPick(e.target.value || null)}
      >
        <option value="">None</option>
        {/* Keep a saved id selectable even before Detect runs. */}
        {value && !cams.some((c) => c.deviceId === value) && (
          <option value={value}>Saved camera ({value.slice(0, 8)}…)</option>
        )}
        {cams.map((c) => (
          <option key={c.deviceId} value={c.deviceId}>
            {c.label}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-white/70">
          Guest photo cameras (waiver capture)
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void requestPermissions()}
            className="rounded-lg bg-[#00e2e5] px-3 py-1.5 text-xs font-bold text-[#04252b]"
          >
            Prompt for permissions
          </button>
          <button
            type="button"
            onClick={() => void detect()}
            className="rounded-lg border border-[#00e2e5]/40 px-3 py-1.5 text-xs font-bold text-[#00e2e5]"
          >
            Detect cameras
          </button>
        </div>
      </div>
      {detectMsg && <p className="text-xs text-white/45">{detectMsg}</p>}
      {previewOn && (
        // Live 5-second proof the grant + camera actually work.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          ref={previewRef}
          autoPlay
          playsInline
          muted
          className="w-full rounded-lg border border-white/15"
          style={{ transform: "scaleX(-1)", maxHeight: 220, objectFit: "cover" }}
        />
      )}
      {camSelect("Camera — upper (adults)", draft.cameraUpperId, (id) =>
        patch({ cameraUpperId: id }),
      )}
      {camSelect("Camera — lower (kids / wheelchair)", draft.cameraLowerId, (id) =>
        patch({ cameraLowerId: id }),
      )}
      <p className="text-xs text-white/40">
        Photo is required for adults and optional for minors at waiver signing. No camera set →
        capture is skipped and the front desk takes the photo at check-in.
      </p>
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
      <ReaderTestRow
        readerId={draft.readerId ?? null}
        pin={pin}
        onPing={pingReader}
        setMsg={setMsg}
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

/**
 * Square reader diagnostics: Ping checks Square's API says it's PAIRED; "Send
 * test" pushes a live $1 checkout so the PHYSICAL reader lights up (the real
 * proof it's reachable + awake), then staff tap "Cancel test" to dismiss it.
 * The test checkout is autocomplete:false server-side — an accidental card tap
 * before cancel is only an uncaptured auth the cancel voids, so no money moves.
 */
function ReaderTestRow({
  readerId,
  pin,
  onPing,
  setMsg,
}: {
  readerId: string | null;
  pin: string;
  onPing: () => void;
  setMsg: (m: string) => void;
}) {
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"send" | "cancel" | null>(null);

  const sendTest = async () => {
    if (!readerId) return setMsg("No reader selected — pick one on the Readers tab.");
    setBusy("send");
    const { ok, data } = await adminFetch(pin, "/api/kiosk/admin", {
      method: "POST",
      body: JSON.stringify({ action: "reader-test", deviceId: readerId }),
    });
    setBusy(null);
    if (ok && data.checkoutId) {
      setCheckoutId(data.checkoutId);
      setMsg("Test sent — the reader should light up now. Tap “Cancel test” to dismiss it.");
    } else {
      setMsg(`Couldn't send test: ${data.error ?? "error"}`);
    }
  };

  const cancelTest = async () => {
    if (!checkoutId) return;
    setBusy("cancel");
    const { ok, data } = await adminFetch(pin, "/api/kiosk/admin", {
      method: "POST",
      body: JSON.stringify({ action: "reader-test-cancel", checkoutId }),
    });
    setBusy(null);
    setCheckoutId(null);
    setMsg(
      ok && data.ok
        ? "Test cancelled — reader cleared."
        : "Cancel failed — dismiss it on the reader.",
    );
  };

  return (
    <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
      <div>
        <div className="font-semibold">Square reader</div>
        <div className="text-xs text-white/40">
          {readerId ?? "none"}
          {checkoutId && <span className="text-amber-300"> · test armed — cancel it</span>}
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onPing}
          className="rounded-lg border border-white/15 px-4 py-2 text-sm font-bold text-white/70"
        >
          Ping
        </button>
        {checkoutId ? (
          <button
            type="button"
            disabled={busy === "cancel"}
            onClick={() => void cancelTest()}
            className="rounded-lg border border-red-400/50 bg-red-400/10 px-4 py-2 text-sm font-bold text-red-200 disabled:opacity-40"
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel test"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy === "send" || !readerId}
            onClick={() => void sendTest()}
            className="rounded-lg bg-[#00e2e5] px-4 py-2 text-sm font-bold text-[#04252b] disabled:opacity-40"
          >
            {busy === "send" ? "Sending…" : "Send test"}
          </button>
        )}
      </div>
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
