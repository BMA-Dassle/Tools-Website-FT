import { beforeEach, describe, expect, it } from "vitest";
import { KIOSK_ENTRY_SCAN_KEY, clearEntryScan, consumeEntryScan, stashEntryScan } from "./handoff";

/** Minimal in-memory sessionStorage — these tests run in the node environment. */
function installStorage(): Storage {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
  globalThis.sessionStorage = storage;
  return storage;
}

describe("entry-scan handoff", () => {
  beforeEach(() => {
    installStorage();
  });

  it("round-trips a stashed scan", () => {
    stashEntryScan({ target: "checkin", raw: "W56444", value: "W56444" });
    expect(consumeEntryScan()).toEqual({ target: "checkin", raw: "W56444", value: "W56444" });
  });

  it("is READ-ONCE — a second consume returns null", () => {
    stashEntryScan({ target: "code-entry", raw: "HPWZ96RZ4SX", value: "HPWZ96RZ4SX" });
    expect(consumeEntryScan()).not.toBeNull();
    // A back-navigation or StrictMode double-mount must not replay the scan.
    expect(consumeEntryScan()).toBeNull();
  });

  it("only hands the payload to the destination it was meant for", () => {
    stashEntryScan({ target: "game-card", raw: "1063464", value: "1063464" });
    // KioskFlow can have both destinations in one tree — the wrong one must
    // not swallow it, and must LEAVE it for the right one.
    expect(consumeEntryScan("code-entry")).toBeNull();
    expect(consumeEntryScan("game-card")).toMatchObject({ target: "game-card" });
  });

  it("returns null when nothing is stashed", () => {
    expect(consumeEntryScan()).toBeNull();
  });

  it("ignores an empty payload rather than stashing it", () => {
    stashEntryScan({ target: "checkin", raw: "", value: "" });
    expect(consumeEntryScan()).toBeNull();
  });

  it("clears — and does not return — an unparseable or malformed entry", () => {
    sessionStorage.setItem(KIOSK_ENTRY_SCAN_KEY, "{not json");
    expect(consumeEntryScan()).toBeNull();
    expect(sessionStorage.getItem(KIOSK_ENTRY_SCAN_KEY)).toBeNull();

    sessionStorage.setItem(KIOSK_ENTRY_SCAN_KEY, JSON.stringify({ target: "nowhere", raw: "x" }));
    expect(consumeEntryScan()).toBeNull();
  });

  it("defaults value to raw when the stored entry omits it", () => {
    sessionStorage.setItem(KIOSK_ENTRY_SCAN_KEY, JSON.stringify({ target: "checkin", raw: "W1" }));
    expect(consumeEntryScan()).toMatchObject({ value: "W1" });
  });

  it("clearEntryScan drops a pending scan", () => {
    stashEntryScan({ target: "checkin", raw: "W56444", value: "W56444" });
    clearEntryScan();
    expect(consumeEntryScan()).toBeNull();
  });
});
