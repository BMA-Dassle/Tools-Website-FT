/**
 * Read-only probe for the 4h-off bowling times on the kiosk check-in browse
 * list (owner report 2026-08-19: "Mirlanda res is 9pm", board said 1:00 AM).
 *
 * Prints, per reservation the list would show, the OLD label (bookedAt handed
 * back verbatim, then zone-stripped by the renderer) beside the NEW one
 * (bookedAt run through toEtWallClock), so the shift is measured per row
 * rather than asserted.
 *
 *   npx tsx scripts/checkin-browse-time-check.mts [YYYY-MM-DD] [center-slug]
 *
 * Writes nothing. Reads Neon only — no BMI, no Pandora, no Square.
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const [dateArg, centerArg] = process.argv.slice(2);

const { listBowlingReservations } = await import("@/lib/bowling-db");
const { browseRowTime, browseRowIsOpen } = await import("~/features/kiosk/checkin/browse-row");
type BrowseLegLike = import("~/features/kiosk/checkin/browse-row").BrowseLegLike;
const { fmtTime12, timeKey, toEtWallClock } = await import("~/features/kiosk/checkin/itinerary");

/** The pre-fix fallback, kept verbatim so the diff is measured, not remembered. */
function oldTime(legs: BrowseLegLike[]): string {
  const heats = legs
    .map((l) => {
      const h = (l.bookingMetadata as { heats?: unknown } | undefined)?.heats;
      if (!Array.isArray(h)) return "";
      const s = h
        .map((x) =>
          x && typeof x === "object" ? String((x as { heatId?: unknown }).heatId ?? "") : "",
        )
        .filter((v) => v.length >= 16)
        .sort();
      return s[0] ?? "";
    })
    .filter(Boolean)
    .sort();
  if (heats.length > 0) return heats[0];
  const booked = legs
    .map((l) => String(l.bookedAt ?? ""))
    .filter(Boolean)
    .sort();
  return booked[0] ?? "";
}

const etToday = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const date = dateArg || etToday;
const center = centerArg || "fort-myers";

// Same codes listBrowseRows scopes to (server.ts CENTER_CODES_FOR_SLUG, which
// is module-private). One slug spans both buildings — the FastTrax track and
// the HeadPinz lanes share a check-in center.
const CENTER_CODES: Record<string, string[]> = {
  "fort-myers": ["TXBSQN0FEKQ11", "LAB52GY480CJF", "fort-myers", "fasttrax"],
  naples: ["PPTR5G2N0QXF7", "naples"],
};
const codes = CENTER_CODES[center];
if (!codes) {
  console.error(`unknown center "${center}". known: ${Object.keys(CENTER_CODES).join(", ")}`);
  process.exit(1);
}

const rows = await listBowlingReservations({
  startDate: date,
  endDate: date,
  centerCodes: codes,
});
console.log(`\n${center} · ${date} · ${rows.length} Neon leg(s)\n`);

const groupKeyOf = (r: (typeof rows)[number]) =>
  r.squareDepositOrderId ?? r.bmiBillId ?? `row:${r.id}`;
const legsByGroup = new Map<string, (typeof rows)[number][]>();
for (const r of rows) {
  const k = groupKeyOf(r);
  legsByGroup.set(k, [...(legsByGroup.get(k) ?? []), r]);
}

let shifted = 0;
const out: { name: string; kinds: string; old: string; now: string }[] = [];
for (const legs of legsByGroup.values()) {
  if (legs.every((l) => l.status === "cancelled" || l.status === "no_show")) continue;
  if (!browseRowIsOpen(legs as BrowseLegLike[])) continue;
  const before = oldTime(legs as BrowseLegLike[]);
  const after = browseRowTime(legs as BrowseLegLike[]).iso;
  if (!after) continue;
  const oldLabel = fmtTime12(before) || "—";
  const newLabel = fmtTime12(after) || "—";
  if (oldLabel !== newLabel) shifted++;
  out.push({
    name: legs.find((l) => l.guestName)?.guestName ?? "Guest",
    kinds: [...new Set(legs.map((l) => l.productKind))].join("+"),
    old: oldLabel,
    now: newLabel,
  });
}
out.sort((a, b) => timeKey(a.now).localeCompare(timeKey(b.now)));

for (const r of out) {
  const flag = r.old === r.now ? "  " : "→ ";
  console.log(
    `${flag}${r.name.slice(0, 22).padEnd(22)} ${r.kinds.padEnd(12)} was ${r.old.padStart(8)}   now ${r.now.padStart(8)}`,
  );
}
console.log(
  `\n${out.length} reservation(s); ${shifted} had the wrong time (marked →). ` +
    `Conversion check: 2026-08-19T01:00:00Z → ${toEtWallClock("2026-08-19T01:00:00.000Z")}\n`,
);
