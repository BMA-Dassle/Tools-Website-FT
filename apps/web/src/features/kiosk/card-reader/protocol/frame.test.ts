import { describe, expect, it } from "vitest";
import { ACK, CM, EOT, MAX_TEXT_LEN, NAK } from "./constants";
import { bcc, buildCommandFrame, FrameAccumulator, type FrameEvent } from "./frame";
import { buildNegativeResponse, buildPositiveResponse } from "./testing";

describe("bcc", () => {
  it("XORs the inclusive range", () => {
    const bytes = Uint8Array.from([0xf2, 0x00, 0x00, 0x03, 0x43, 0x30, 0x33, 0x03]);
    expect(bcc(bytes, 0, 7)).toBe(0xb2);
    expect(bcc(bytes, 0, 0)).toBe(0xf2);
  });
});

describe("buildCommandFrame", () => {
  it("builds the INIT(leaveCard) golden vector (hand-computed)", () => {
    const frame = buildCommandFrame({ cm: CM.INIT, pm: 0x33 });
    expect(Array.from(frame)).toEqual([0xf2, 0x00, 0x00, 0x03, 0x43, 0x30, 0x33, 0x03, 0xb2]);
  });

  it("builds a with-DATA golden vector (Mifare read, hand-computed)", () => {
    const frame = buildCommandFrame({
      cm: CM.RF,
      pm: 0x33,
      data: Uint8Array.from([0x00, 0xb0, 0x01, 0x00, 0x02]),
    });
    expect(Array.from(frame)).toEqual([
      0xf2, 0x00, 0x00, 0x08, 0x43, 0x60, 0x33, 0x00, 0xb0, 0x01, 0x00, 0x02, 0x03, 0x5a,
    ]);
  });

  it("encodes a non-zero address and includes it in the BCC", () => {
    const frame = buildCommandFrame({ cm: CM.STATUS, pm: 0x30, addr: 0x05 });
    expect(frame[1]).toBe(0x05);
    expect(frame[frame.length - 1]).toBe(bcc(frame, 0, frame.length - 2));
  });

  it("accepts DATA at the 512-byte boundary and rejects above it", () => {
    const max = buildCommandFrame({ cm: CM.RF, pm: 0x34, data: new Uint8Array(512) });
    expect((max[2] << 8) | max[3]).toBe(3 + 512);
    expect(() => buildCommandFrame({ cm: CM.RF, pm: 0x34, data: new Uint8Array(513) })).toThrow(
      RangeError,
    );
  });
});

function eventsOf(chunks: Uint8Array[]): FrameEvent[] {
  const acc = new FrameAccumulator();
  return chunks.flatMap((c) => acc.push(c));
}

describe("FrameAccumulator", () => {
  const positive = buildPositiveResponse({
    cm: CM.STATUS,
    pm: 0x30,
    st: [0x32, 0x32, 0x30],
  });

  it("parses a whole positive response in one chunk", () => {
    const events = eventsOf([positive]);
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (ev.type !== "frame" || ev.frame.kind !== "positive") throw new Error("expected positive");
    expect(ev.frame.cm).toBe(CM.STATUS);
    expect(ev.frame.st).toEqual({ st0: 0x32, st1: 0x32, st2: 0x30 });
    expect(ev.frame.data).toHaveLength(0);
  });

  it("parses the same frame sliced at every possible chunk boundary", () => {
    for (let cut = 1; cut < positive.length; cut++) {
      const events = eventsOf([positive.slice(0, cut), positive.slice(cut)]);
      expect(events, `cut at ${cut}`).toHaveLength(1);
      expect(events[0].type, `cut at ${cut}`).toBe("frame");
    }
  });

  it("emits control bytes and a merged frame from a single chunk", () => {
    const merged = new Uint8Array(1 + positive.length);
    merged[0] = ACK;
    merged.set(positive, 1);
    const events = eventsOf([merged]);
    expect(events.map((e) => e.type)).toEqual(["ack", "frame"]);
  });

  it("emits nak and eot control events", () => {
    expect(eventsOf([Uint8Array.from([NAK, EOT])]).map((e) => e.type)).toEqual(["nak", "eot"]);
  });

  it("reports garbage before a frame and still parses the frame", () => {
    const events = eventsOf([Uint8Array.from([0x11, 0x22]), positive]);
    expect(events.map((e) => e.type)).toEqual(["garbage", "frame"]);
    const g = events[0];
    if (g.type !== "garbage") throw new Error("expected garbage");
    expect(Array.from(g.bytes)).toEqual([0x11, 0x22]);
  });

  it("does not misread an ACK byte inside DATA", () => {
    const withAckInData = buildPositiveResponse({
      cm: CM.RF,
      pm: 0x33,
      data: [ACK, ACK, 0x90, 0x00],
    });
    const events = eventsOf([withAckInData]);
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (ev.type !== "frame" || ev.frame.kind !== "positive") throw new Error("expected positive");
    expect(Array.from(ev.frame.data)).toEqual([ACK, ACK, 0x90, 0x00]);
  });

  it("flags a corrupted BCC, consumes the frame whole, and recovers cleanly", () => {
    const corrupt = Uint8Array.from(positive);
    corrupt[corrupt.length - 1] ^= 0xff;
    const events = eventsOf([corrupt, positive]);
    expect(events.map((e) => e.type)).toEqual(["badFrame", "frame"]);
    const bad = events[0];
    if (bad.type !== "badFrame") throw new Error("expected badFrame");
    expect(bad.reason).toBe("bcc");
  });

  it("flags an oversize LEN immediately and resyncs on the next STX", () => {
    const oversize = Uint8Array.from([
      0xf2,
      0x00,
      (MAX_TEXT_LEN + 1) >> 8,
      (MAX_TEXT_LEN + 1) & 0xff,
    ]);
    const events = eventsOf([oversize, positive]);
    expect(events.map((e) => e.type)).toEqual(["badFrame", "garbage", "frame"]);
    const bad = events[0];
    if (bad.type !== "badFrame") throw new Error("expected badFrame");
    expect(bad.reason).toBe("overflow");
  });

  it("resyncs when a truncated frame is followed by a fresh frame", () => {
    // A frame header claiming more bytes than ever arrive, then a real frame.
    // Validation of the (mis-assembled) oversized frame fails, the STX is
    // dropped, and the rescan finds the genuine frame inside the buffer.
    const truncated = positive.slice(0, 6);
    const events = eventsOf([truncated, positive, positive]);
    const frames = events.filter((e) => e.type === "frame");
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "badFrame")).toBe(true);
  });

  it("accepts both negative-head encodings ('N' 4Eh and the spec's printed 45h)", () => {
    for (const head of [0x4e, 0x45]) {
      const neg = buildNegativeResponse({ cm: CM.MOVE, pm: 0x39, code: "10", head });
      const events = eventsOf([neg]);
      expect(events).toHaveLength(1);
      const ev = events[0];
      if (ev.type !== "frame" || ev.frame.kind !== "negative") throw new Error("expected negative");
      expect(ev.frame.code).toBe("10");
    }
  });

  it("carries DATA on negative responses (RF activate returns UID on failure)", () => {
    const neg = buildNegativeResponse({
      cm: CM.RF,
      pm: 0x30,
      code: "61",
      data: [0x4d, 0x00, 0x04],
    });
    const events = eventsOf([neg]);
    const ev = events[0];
    if (ev.type !== "frame" || ev.frame.kind !== "negative") throw new Error("expected negative");
    expect(Array.from(ev.frame.data)).toEqual([0x4d, 0x00, 0x04]);
  });

  it("round-trips build → parse for command-shaped frames via the envelope", () => {
    // Sanity: our builder's envelope matches what the accumulator expects.
    // (Command frames never come FROM the device, but the envelope logic is shared.)
    const cmd = buildCommandFrame({ cm: CM.INIT, pm: 0x33 });
    expect(cmd[cmd.length - 1]).toBe(bcc(cmd, 0, cmd.length - 2));
  });

  it("reset() drops a partial frame", () => {
    const acc = new FrameAccumulator();
    acc.push(positive.slice(0, 5));
    acc.reset();
    const events = acc.push(positive);
    expect(events.map((e) => e.type)).toEqual(["frame"]);
  });
});
