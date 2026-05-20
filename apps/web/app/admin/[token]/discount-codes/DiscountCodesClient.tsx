"use client";

import { useCallback, useEffect, useState } from "react";
import { modalBackdropProps } from "@/lib/a11y";
import type {
  DiscountCodeInput,
  DiscountCodeRow,
  DiscountMechanic,
  DiscountScopes,
} from "~/features/discount-codes";

interface ProductCatalog {
  bowling: Array<{ slug: string; label: string }>;
  racing: Array<{ slug: string; label: string }>;
  attractions: Array<{ slug: string; label: string }>;
}

const LOCATIONS: Array<{ id: string; label: string }> = [
  { id: "TXBSQN0FEKQ11", label: "HeadPinz Fort Myers" },
  { id: "PPTR5G2N0QXF7", label: "HeadPinz Naples" },
];

const WEEKDAYS = [
  { n: 0, label: "Sun" },
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
];

const DOMAINS: Array<{ key: keyof DiscountScopes; label: string; slugsKey: string }> = [
  { key: "bowling", label: "Bowling", slugsKey: "experienceSlugs" },
  { key: "racing", label: "Racing", slugsKey: "productSlugs" },
  { key: "attractions", label: "Attractions", slugsKey: "slugs" },
];

interface DraftForm {
  code: string;
  description: string;
  mechanic: DiscountMechanic;
  amountPct: string;
  amountCents: string;
  startsAt: string;
  expiresAt: string;
  allowedWeekdays: number[];
  allowedLocations: string[];
  // Per-domain: either null (= "all") via empty selection + checked OR list of slugs.
  enabledDomains: Set<keyof DiscountScopes>;
  domainSlugs: Record<string, string[]>;
  maxUses: string;
  active: boolean;
}

function emptyDraft(): DraftForm {
  const today = new Date();
  const isoDate = today.toISOString().slice(0, 10);
  const inOneMonth = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return {
    code: "",
    description: "",
    mechanic: "percent",
    // Default mirrors the current weekday promo (25% off Mon–Thu).
    // Bump this when the next campaign launches at a different rate.
    amountPct: "25",
    amountCents: "",
    startsAt: `${isoDate}T00:00`,
    expiresAt: `${inOneMonth}T23:59`,
    allowedWeekdays: [],
    allowedLocations: [],
    enabledDomains: new Set(["bowling"]),
    domainSlugs: {},
    maxUses: "",
    active: true,
  };
}

function rowToDraft(r: DiscountCodeRow): DraftForm {
  const domainSlugs: Record<string, string[]> = {};
  const enabled = new Set<keyof DiscountScopes>();
  if (r.scopes.bowling) {
    enabled.add("bowling");
    domainSlugs.bowling = r.scopes.bowling.experienceSlugs ?? [];
  }
  if (r.scopes.racing) {
    enabled.add("racing");
    domainSlugs.racing = r.scopes.racing.productSlugs ?? [];
  }
  if (r.scopes.attractions) {
    enabled.add("attractions");
    domainSlugs.attractions = r.scopes.attractions.slugs ?? [];
  }
  return {
    code: r.code,
    description: r.description ?? "",
    mechanic: r.mechanic,
    amountPct: r.amountPct?.toString() ?? "",
    amountCents: r.amountCents?.toString() ?? "",
    startsAt: r.startsAt.slice(0, 16),
    expiresAt: r.expiresAt.slice(0, 16),
    allowedWeekdays: r.allowedWeekdays ?? [],
    allowedLocations: r.allowedLocations ?? [],
    enabledDomains: enabled,
    domainSlugs,
    maxUses: r.maxUses?.toString() ?? "",
    active: r.active,
  };
}

function draftToInput(
  d: DraftForm,
): { ok: true; input: DiscountCodeInput } | { ok: false; error: string } {
  const code = d.code.trim().toUpperCase();
  if (!code) return { ok: false, error: "code is required" };

  const startsAt = new Date(d.startsAt);
  const expiresAt = new Date(d.expiresAt);
  if (isNaN(startsAt.getTime())) return { ok: false, error: "startsAt is invalid" };
  if (isNaN(expiresAt.getTime())) return { ok: false, error: "expiresAt is invalid" };
  if (expiresAt <= startsAt) return { ok: false, error: "expiresAt must be after startsAt" };

  if (d.enabledDomains.size === 0) {
    return { ok: false, error: "at least one domain must be enabled" };
  }

  const scopes: DiscountScopes = {};
  for (const dom of d.enabledDomains) {
    const slugs = d.domainSlugs[dom] ?? [];
    if (dom === "bowling") {
      scopes.bowling = { experienceSlugs: slugs.length ? slugs : null };
    } else if (dom === "racing") {
      scopes.racing = { productSlugs: slugs.length ? slugs : null };
    } else if (dom === "attractions") {
      scopes.attractions = { slugs: slugs.length ? slugs : null };
    }
  }

  return {
    ok: true,
    input: {
      code,
      description: d.description.trim() || undefined,
      mechanic: d.mechanic,
      amountPct: d.mechanic === "percent" ? Number(d.amountPct) : null,
      amountCents: d.mechanic === "fixed" ? Number(d.amountCents) : null,
      startsAt: startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      allowedWeekdays: d.allowedWeekdays.length ? d.allowedWeekdays.slice().sort() : null,
      allowedLocations: d.allowedLocations.length ? d.allowedLocations : null,
      scopes,
      maxUses: d.maxUses ? Number(d.maxUses) : null,
      active: d.active,
    },
  };
}

export default function DiscountCodesClient({ token }: { token: string }) {
  const [codes, setCodes] = useState<DiscountCodeRow[]>([]);
  const [catalog, setCatalog] = useState<ProductCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<DiscountCodeRow | null>(null);
  const [draft, setDraft] = useState<DraftForm | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [codesRes, catRes] = await Promise.all([
        fetch(`/api/admin/discount-codes?token=${token}`, { cache: "no-store" }),
        fetch(`/api/admin/discount-codes/product-catalog?token=${token}`, { cache: "no-store" }),
      ]);
      const codesData = await codesRes.json();
      const catData = await catRes.json();
      if (!codesRes.ok) throw new Error(codesData.error || "load failed");
      setCodes(codesData.codes);
      setCatalog(catData);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, [token]);

  // Initial load runs once on mount. `reload` is exposed as a separate
  // callback so post-save flows can refresh without triggering React 19's
  // set-state-in-effect rule via a changing dep. The setState inside reload
  // is the documented pattern for a data-fetching boundary; React's rule is
  // a heuristic, not a correctness gate, here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
    void reload();
  }, []);

  function startCreate() {
    setEditing(null);
    setDraft(emptyDraft());
  }

  function startEdit(row: DiscountCodeRow) {
    setEditing(row);
    setDraft(rowToDraft(row));
  }

  async function save() {
    if (!draft) return;
    const parsed = draftToInput(draft);
    if (!parsed.ok) {
      setErr(parsed.error);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const url = editing
        ? `/api/admin/discount-codes/${editing.id}?token=${token}`
        : `/api/admin/discount-codes?token=${token}`;
      const method = editing ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.input),
      });
      const data = await res.json();
      if (!res.ok && res.status !== 207) {
        throw new Error(data.error || "save failed");
      }
      if (res.status === 207) {
        setErr(`Saved with warning: ${data.warning || data.squareError}`);
      } else {
        setErr(null);
      }
      setEditing(null);
      setDraft(null);
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(row: DiscountCodeRow) {
    if (!confirm(`Deactivate ${row.code}? Customers cannot redeem it after this.`)) return;
    const res = await fetch(`/api/admin/discount-codes/${row.id}?token=${token}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setErr(data.error || "deactivate failed");
      return;
    }
    await reload();
  }

  async function retryProvision(row: DiscountCodeRow) {
    const res = await fetch(`/api/admin/discount-codes/${row.id}/provision-square?token=${token}`, {
      method: "POST",
    });
    const data = await res.json();
    if (!res.ok) setErr(data.error || "provision failed");
    else await reload();
  }

  return (
    <div style={{ padding: "1.5rem", color: "#e6e6e6", fontFamily: "system-ui, sans-serif" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "1.25rem",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", margin: 0, color: "#fff" }}>Discount Codes</h1>
        <button
          onClick={startCreate}
          style={{
            background: "#22c55e",
            color: "#0a1628",
            padding: "0.5rem 1rem",
            border: 0,
            borderRadius: 6,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          + New code
        </button>
      </header>

      {err && (
        <div
          style={{
            background: "rgba(239,68,68,0.15)",
            border: "1px solid rgba(239,68,68,0.4)",
            padding: "0.6rem 0.9rem",
            borderRadius: 6,
            marginBottom: "1rem",
            color: "#fca5a5",
          }}
        >
          {err}
        </div>
      )}

      {loading ? (
        <p style={{ color: "#94a3b8" }}>Loading…</p>
      ) : codes.length === 0 ? (
        <p style={{ color: "#94a3b8" }}>No codes yet. Click “New code” to create one.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #2a3a52" }}>
              <th style={th}>Code</th>
              <th style={th}>Discount</th>
              <th style={th}>Window</th>
              <th style={th}>Weekdays</th>
              <th style={th}>Domains</th>
              <th style={th}>Uses</th>
              <th style={th}>Square</th>
              <th style={th}>Status</th>
              <th style={th} aria-label="Row actions"></th>
            </tr>
          </thead>
          <tbody>
            {codes.map((c) => (
              <tr key={c.id} style={{ borderBottom: "1px solid #1a2a44" }}>
                <td style={td}>
                  <strong style={{ color: "#fff" }}>{c.code}</strong>
                  {c.description && (
                    <div style={{ color: "#94a3b8", fontSize: "0.75rem" }}>{c.description}</div>
                  )}
                </td>
                <td style={td}>
                  {c.mechanic === "percent"
                    ? `${c.amountPct}% off`
                    : c.mechanic === "fixed"
                      ? `$${((c.amountCents ?? 0) / 100).toFixed(2)} off`
                      : c.mechanic}
                </td>
                <td style={{ ...td, fontSize: "0.75rem" }}>
                  {fmtDate(c.startsAt)} → {fmtDate(c.expiresAt)}
                </td>
                <td style={td}>
                  {c.allowedWeekdays && c.allowedWeekdays.length > 0
                    ? c.allowedWeekdays.map((n) => WEEKDAYS[n].label).join(" ")
                    : "Any"}
                </td>
                <td style={td}>
                  {(["bowling", "racing", "attractions"] as const)
                    .filter((d) => c.scopes[d])
                    .map((d) => d[0].toUpperCase() + d.slice(1))
                    .join(", ") || "—"}
                </td>
                <td style={td}>
                  {c.usesCount}
                  {c.maxUses ? ` / ${c.maxUses}` : ""}
                </td>
                <td style={td}>
                  {c.scopes.bowling ? (
                    c.squareCatalogId ? (
                      <span style={{ color: "#22c55e" }}>✓</span>
                    ) : (
                      <button
                        onClick={() => retryProvision(c)}
                        style={{ ...btnSmall, background: "#f59e0b", color: "#0a1628" }}
                      >
                        Retry
                      </button>
                    )
                  ) : (
                    <span style={{ color: "#94a3b8" }}>—</span>
                  )}
                </td>
                <td style={td}>
                  {c.active ? (
                    <span style={{ color: "#22c55e" }}>Active</span>
                  ) : (
                    <span style={{ color: "#94a3b8" }}>Inactive</span>
                  )}
                </td>
                <td style={td}>
                  <button onClick={() => startEdit(c)} style={btnSmall}>
                    Edit
                  </button>
                  {c.active && (
                    <button
                      onClick={() => deactivate(c)}
                      style={{ ...btnSmall, background: "#ef4444", color: "#fff", marginLeft: 6 }}
                    >
                      Deactivate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {draft && (
        <DraftEditor
          draft={draft}
          setDraft={setDraft}
          catalog={catalog}
          editing={!!editing}
          onCancel={() => {
            setDraft(null);
            setEditing(null);
          }}
          onSave={save}
          saving={saving}
        />
      )}
    </div>
  );
}

function DraftEditor({
  draft,
  setDraft,
  catalog,
  editing,
  onCancel,
  onSave,
  saving,
}: {
  draft: DraftForm;
  setDraft: (d: DraftForm) => void;
  catalog: ProductCatalog | null;
  editing: boolean;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  function update<K extends keyof DraftForm>(k: K, v: DraftForm[K]) {
    setDraft({ ...draft, [k]: v });
  }
  function toggleWeekday(n: number) {
    const next = new Set(draft.allowedWeekdays);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    update("allowedWeekdays", Array.from(next));
  }
  function toggleLocation(id: string) {
    const set = new Set(draft.allowedLocations);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    update("allowedLocations", Array.from(set));
  }
  function toggleDomain(d: keyof DiscountScopes) {
    const next = new Set(draft.enabledDomains);
    if (next.has(d)) next.delete(d);
    else next.add(d);
    update("enabledDomains", next);
  }
  function toggleSlug(d: string, slug: string) {
    const list = new Set(draft.domainSlugs[d] ?? []);
    if (list.has(slug)) list.delete(slug);
    else list.add(slug);
    setDraft({ ...draft, domainSlugs: { ...draft.domainSlugs, [d]: Array.from(list) } });
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      {...modalBackdropProps(onCancel)}
    >
      {/* Inner panel does NOT need its own onClick — the backdrop only fires
          onCancel when target === currentTarget, so clicks inside this div
          never reach it. */}
      <div
        style={{
          background: "#0f1f3a",
          padding: "1.5rem",
          borderRadius: 8,
          width: "min(720px, 92vw)",
          maxHeight: "92vh",
          overflow: "auto",
          color: "#e6e6e6",
        }}
      >
        <h2 style={{ marginTop: 0, color: "#fff" }}>{editing ? "Edit" : "New"} discount code</h2>

        <Row label="Code">
          <input
            type="text"
            value={draft.code}
            onChange={(e) => update("code", e.target.value.toUpperCase())}
            placeholder="MAY20WEEKDAY"
            style={input}
          />
        </Row>
        <Row label="Description (internal)">
          <input
            type="text"
            value={draft.description}
            onChange={(e) => update("description", e.target.value)}
            placeholder="May weekday 20% off"
            style={input}
          />
        </Row>
        <Row label="Mechanic">
          <select
            value={draft.mechanic}
            onChange={(e) => update("mechanic", e.target.value as DiscountMechanic)}
            style={input}
          >
            <option value="percent">Percent off</option>
            <option value="fixed">Fixed amount off</option>
            <option value="bogo" disabled>
              BOGO (coming soon)
            </option>
            <option value="free_addon" disabled>
              Free add-on (coming soon)
            </option>
          </select>
        </Row>
        {draft.mechanic === "percent" && (
          <Row label="Percent">
            <input
              type="number"
              min={1}
              max={100}
              value={draft.amountPct}
              onChange={(e) => update("amountPct", e.target.value)}
              style={input}
            />
            <span style={{ marginLeft: 8, color: "#94a3b8" }}>%</span>
          </Row>
        )}
        {draft.mechanic === "fixed" && (
          <Row label="Amount off (cents)">
            <input
              type="number"
              min={1}
              value={draft.amountCents}
              onChange={(e) => update("amountCents", e.target.value)}
              style={input}
            />
          </Row>
        )}

        <Row label="Starts at">
          <input
            type="datetime-local"
            value={draft.startsAt}
            onChange={(e) => update("startsAt", e.target.value)}
            style={input}
          />
        </Row>
        <Row label="Expires at">
          <input
            type="datetime-local"
            value={draft.expiresAt}
            onChange={(e) => update("expiresAt", e.target.value)}
            style={input}
          />
        </Row>

        <Row label="Eligible weekdays">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {WEEKDAYS.map((wd) => {
              const on = draft.allowedWeekdays.includes(wd.n);
              return (
                <button
                  key={wd.n}
                  type="button"
                  onClick={() => toggleWeekday(wd.n)}
                  style={chip(on)}
                >
                  {wd.label}
                </button>
              );
            })}
          </div>
          <div style={{ color: "#94a3b8", fontSize: "0.75rem", marginTop: 4 }}>
            None selected = any weekday.
          </div>
        </Row>

        <Row label="Locations">
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {LOCATIONS.map((loc) => {
              const on = draft.allowedLocations.includes(loc.id);
              return (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => toggleLocation(loc.id)}
                  style={chip(on)}
                >
                  {loc.label}
                </button>
              );
            })}
          </div>
          <div style={{ color: "#94a3b8", fontSize: "0.75rem", marginTop: 4 }}>
            None selected = both centers.
          </div>
        </Row>

        <Row label="Where it applies">
          {DOMAINS.map((d) => {
            const on = draft.enabledDomains.has(d.key);
            const list = (catalog?.[d.key] ?? []) as Array<{ slug: string; label: string }>;
            return (
              <div
                key={d.key}
                style={{
                  border: "1px solid #2a3a52",
                  borderRadius: 6,
                  padding: 8,
                  marginBottom: 6,
                  background: on ? "rgba(34,197,94,0.05)" : undefined,
                }}
              >
                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={on} onChange={() => toggleDomain(d.key)} />
                  <strong>{d.label}</strong>
                </label>
                {on && (
                  <div style={{ marginTop: 6, paddingLeft: 22 }}>
                    <div style={{ color: "#94a3b8", fontSize: "0.75rem", marginBottom: 4 }}>
                      Eligible {d.label.toLowerCase()} products — none selected = all.
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {list.map((p) => {
                        const selected = (draft.domainSlugs[d.key] ?? []).includes(p.slug);
                        return (
                          <button
                            key={p.slug}
                            type="button"
                            onClick={() => toggleSlug(d.key, p.slug)}
                            style={chip(selected)}
                          >
                            {p.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </Row>

        <Row label="Max total uses">
          <input
            type="number"
            min={1}
            value={draft.maxUses}
            onChange={(e) => update("maxUses", e.target.value)}
            placeholder="Unlimited"
            style={input}
          />
        </Row>

        <Row label="Active">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => update("active", e.target.checked)}
          />
        </Row>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button onClick={onCancel} style={{ ...btn, background: "#334155" }}>
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving}
            style={{ ...btn, background: saving ? "#94a3b8" : "#22c55e", color: "#0a1628" }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label
        style={{
          display: "block",
          fontSize: "0.75rem",
          color: "#94a3b8",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          marginBottom: 4,
        }}
      >
        {label}
      </label>
      <div>{children}</div>
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.6rem",
  color: "#94a3b8",
  fontWeight: 600,
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const td: React.CSSProperties = {
  padding: "0.5rem 0.6rem",
  verticalAlign: "top",
};

const input: React.CSSProperties = {
  background: "#0a1628",
  border: "1px solid #2a3a52",
  color: "#fff",
  padding: "0.4rem 0.6rem",
  borderRadius: 4,
  width: "100%",
  maxWidth: 400,
};

const btn: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: 0,
  borderRadius: 4,
  fontWeight: 600,
  cursor: "pointer",
  color: "#fff",
};

const btnSmall: React.CSSProperties = {
  padding: "0.25rem 0.6rem",
  border: 0,
  borderRadius: 4,
  fontWeight: 600,
  fontSize: "0.75rem",
  background: "#3b82f6",
  color: "#fff",
  cursor: "pointer",
};

function chip(on: boolean): React.CSSProperties {
  return {
    padding: "0.3rem 0.7rem",
    borderRadius: 999,
    border: `1px solid ${on ? "#22c55e" : "#334155"}`,
    background: on ? "rgba(34,197,94,0.15)" : "transparent",
    color: on ? "#22c55e" : "#cbd5e1",
    cursor: "pointer",
    fontSize: "0.75rem",
    fontWeight: 600,
  };
}
