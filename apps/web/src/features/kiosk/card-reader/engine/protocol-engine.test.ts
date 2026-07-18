import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACK, CM, EOT, NAK } from "../protocol/constants";
import { CrtCancelledError, CrtError, CrtLinkError, CrtTimeoutError } from "../protocol/errors";
import { buildNegativeResponse, buildPositiveResponse } from "../protocol/testing";
import { FakeTransport } from "./fake-transport";
import { CrtProtocolEngine, type PositiveFrame } from "./protocol-engine";

const statusResponse = buildPositiveResponse({ cm: CM.STATUS, pm: 0x30, st: [0x30, 0x32, 0x30] });
const moveResponse = buildPositiveResponse({ cm: CM.MOVE, pm: 0x39, st: [0x31, 0x32, 0x30] });

/** Let queued microtasks run under fake timers. */
const tick = () => vi.advanceTimersByTimeAsync(0);

let transport: FakeTransport;
let engine: CrtProtocolEngine;

beforeEach(() => {
  vi.useFakeTimers();
  transport = new FakeTransport();
  engine = new CrtProtocolEngine(transport);
});

afterEach(() => {
  engine.dispose();
  vi.useRealTimers();
});

function lastWrite(): number[] {
  return Array.from(transport.writes[transport.writes.length - 1]);
}

describe("CrtProtocolEngine — happy path", () => {
  it("sends, gets ACK + response, ACKs it, resolves with the positive frame", async () => {
    const promise = engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" });
    await tick();
    expect(transport.writes).toHaveLength(1); // the command frame
    expect(transport.writes[0][0]).toBe(0xf2);

    transport.receive([ACK]);
    transport.receive(statusResponse);
    await tick();

    const frame = await promise;
    expect(frame.kind).toBe("positive");
    expect(frame.cm).toBe(CM.STATUS);
    expect(lastWrite()).toEqual([ACK]); // we ACKed the response
  });

  it("handles ACK and response merged into one chunk, split at odd boundaries", async () => {
    const promise = engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" });
    await tick();
    const merged = Uint8Array.from([ACK, ...statusResponse]);
    transport.receive(merged.slice(0, 3));
    transport.receive(merged.slice(3, 7));
    transport.receive(merged.slice(7));
    await tick();
    await expect(promise).resolves.toMatchObject({ kind: "positive" });
  });
});

describe("CrtProtocolEngine — link failures", () => {
  it("resends on NAK and succeeds", async () => {
    const promise = engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" });
    await tick();
    transport.receive([NAK]);
    await tick();
    expect(transport.writes).toHaveLength(2); // original + resend
    transport.receive([ACK]);
    transport.receive(statusResponse);
    await tick();
    await expect(promise).resolves.toBeTruthy();
  });

  it("gives up after the NAK retry limit", async () => {
    const promise = engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" });
    const expectation = expect(promise).rejects.toSatisfy(
      (e: unknown) => e instanceof CrtLinkError && e.failure === "nakRetriesExhausted",
    );
    await tick();
    for (let i = 0; i < 4; i++) {
      transport.receive([NAK]);
      await tick();
    }
    await expectation;
    expect(transport.writes.length).toBe(4); // original + 3 resends
  });

  it("resends on ACK silence, then fails with ackTimeout", async () => {
    const promise = engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" });
    const expectation = expect(promise).rejects.toSatisfy(
      (e: unknown) => e instanceof CrtLinkError && e.failure === "ackTimeout",
    );
    await tick();
    await vi.advanceTimersByTimeAsync(301); // silence #1 → resend
    await vi.advanceTimersByTimeAsync(301); // #2
    await vi.advanceTimersByTimeAsync(301); // #3
    await vi.advanceTimersByTimeAsync(301); // limit hit
    await expectation;
    expect(transport.writes.length).toBe(4);
  });

  it("NAKs a corrupted response and accepts the device's resend", async () => {
    const promise = engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" });
    await tick();
    transport.receive([ACK]);
    const corrupt = Uint8Array.from(statusResponse);
    corrupt[corrupt.length - 1] ^= 0xff;
    transport.receive(corrupt);
    await tick();
    expect(lastWrite()).toEqual([NAK]);
    transport.receive(statusResponse);
    await tick();
    await expect(promise).resolves.toMatchObject({ kind: "positive" });
  });

  it("gives up after repeated corrupted responses", async () => {
    const promise = engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" });
    const expectation = expect(promise).rejects.toSatisfy(
      (e: unknown) => e instanceof CrtLinkError && e.failure === "badResponseRetriesExhausted",
    );
    await tick();
    transport.receive([ACK]);
    const corrupt = Uint8Array.from(statusResponse);
    corrupt[corrupt.length - 1] ^= 0xff;
    for (let i = 0; i < 3; i++) {
      transport.receive(corrupt);
      await tick();
    }
    await expectation;
  });

  it("rejects everything when the port dies mid-command", async () => {
    const promise = engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" });
    const expectation = expect(promise).rejects.toSatisfy(
      (e: unknown) => e instanceof CrtLinkError && e.failure === "portClosed",
    );
    await tick();
    transport.die("USB unplugged");
    await expectation;
    await expect(
      engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" }),
    ).rejects.toBeInstanceOf(CrtLinkError);
  });
});

describe("CrtProtocolEngine — negative responses", () => {
  it("ACKs a negative response and rejects with decoded CrtError", async () => {
    const promise = engine.send({ cm: CM.MOVE, pm: 0x31 }, { commandClass: "move" });
    const expectation = expect(promise).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof CrtError && e.info.code === "A0" && e.info.category === "attention",
    );
    await tick();
    transport.receive([ACK]);
    transport.receive(buildNegativeResponse({ cm: CM.MOVE, pm: 0x31, code: "A0" }));
    await tick();
    await expectation;
    expect(lastWrite()).toEqual([ACK]);
  });
});

describe("CrtProtocolEngine — serialization", () => {
  it("holds the second command until the first completes", async () => {
    const p1 = engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" });
    const p2 = engine.send({ cm: CM.STATUS, pm: 0x31 }, { commandClass: "quick" });
    await tick();
    expect(transport.writes).toHaveLength(1);

    transport.receive([ACK]);
    transport.receive(statusResponse);
    await tick();
    await p1;
    // ACK for response #1, then command #2.
    expect(transport.writes).toHaveLength(3);
    expect(transport.writes[2][0]).toBe(0xf2);

    transport.receive([ACK]);
    transport.receive(buildPositiveResponse({ cm: CM.STATUS, pm: 0x31, data: [0x30, 0x30] }));
    await tick();
    await p2;
  });
});

describe("CrtProtocolEngine — execution timeout & cancel", () => {
  it("times out a silent move, clears the line, rejects CrtTimeoutError", async () => {
    const promise = engine.send({ cm: CM.MOVE, pm: 0x39 }, { commandClass: "move" });
    const expectation = expect(promise).rejects.toBeInstanceOf(CrtTimeoutError);
    await tick();
    transport.receive([ACK]);
    await vi.advanceTimersByTimeAsync(15_001);
    // Engine sent EOT to clear the line.
    expect(lastWrite()).toEqual([EOT]);
    transport.receive([EOT]);
    await tick();
    await expectation;
  });

  it("cancel() runs the EOT exchange and rejects the in-flight command", async () => {
    const promise = engine.send({ cm: CM.MOVE, pm: 0x39 }, { commandClass: "move" });
    const expectation = expect(promise).rejects.toBeInstanceOf(CrtCancelledError);
    await tick();
    transport.receive([ACK]);
    const cancelled = engine.cancel();
    await tick();
    expect(lastWrite()).toEqual([EOT]);
    transport.receive([EOT]);
    await tick();
    await cancelled;
    await expectation;
  });

  it("Case 7 — a response crossing our EOT resolves the command", async () => {
    const promise = engine.send({ cm: CM.MOVE, pm: 0x39 }, { commandClass: "move" });
    await tick();
    transport.receive([ACK]);
    const cancelled = engine.cancel();
    await tick();
    transport.receive(moveResponse); // execution had already finished
    await tick();
    await cancelled;
    const frame = await promise;
    expect(frame.kind).toBe("positive");
    expect(lastWrite()).toEqual([ACK]);
  });

  it("lineClear resends EOT once on silence, then treats the line as clear", async () => {
    const cleared = engine.lineClear();
    await tick();
    expect(transport.writes.filter((w) => w.length === 1 && w[0] === EOT)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(301);
    expect(transport.writes.filter((w) => w.length === 1 && w[0] === EOT)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(301);
    await cleared; // resolved despite total silence
  });
});

describe("CrtProtocolEngine — Case 4 quick resend", () => {
  it("resends a quick command whose response goes missing after ACK", async () => {
    const promise = engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" });
    await tick();
    transport.receive([ACK]);
    await vi.advanceTimersByTimeAsync(201);
    expect(transport.writes).toHaveLength(2); // resend happened
    transport.receive([ACK]);
    transport.receive(statusResponse);
    await tick();
    await expect(promise).resolves.toBeTruthy();
  });

  it("never resends a motion command after ACK", async () => {
    const promise = engine.send({ cm: CM.MOVE, pm: 0x31 }, { commandClass: "move" });
    await tick();
    transport.receive([ACK]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(transport.writes).toHaveLength(1); // no resend
    transport.receive(moveResponse);
    await tick();
    await expect(promise).resolves.toBeTruthy();
  });
});

describe("CrtProtocolEngine — address & unsolicited traffic", () => {
  it("rejects a response with the wrong ADDR and accepts the corrected resend", async () => {
    const promise = engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" });
    await tick();
    transport.receive([ACK]);
    transport.receive(buildPositiveResponse({ cm: CM.STATUS, pm: 0x30, addr: 0x03 }));
    await tick();
    expect(lastWrite()).toEqual([NAK]);
    transport.receive(statusResponse);
    await tick();
    await expect(promise).resolves.toMatchObject({ addr: 0x00 });
  });

  it("ACKs an unsolicited frame and surfaces it via onUnsolicited", async () => {
    const seen: PositiveFrame[] = [];
    engine.onUnsolicited((f) => {
      if (f.kind === "positive") seen.push(f);
    });
    transport.receive(statusResponse);
    await tick();
    expect(seen).toHaveLength(1);
    expect(lastWrite()).toEqual([ACK]);
  });

  it("streams TX/RX log events with decoded meanings", async () => {
    const decoded: string[] = [];
    engine.onLog((e) => decoded.push(`${e.dir}:${e.decoded}`));
    const promise = engine.send({ cm: CM.STATUS, pm: 0x30 }, { commandClass: "quick" });
    await tick();
    transport.receive([ACK]);
    transport.receive(statusResponse);
    await tick();
    await promise;
    expect(decoded[0]).toMatch(/^tx:CMD STATUS 31\/30/);
    expect(decoded).toContain("rx:ACK");
    expect(decoded.some((d) => d.startsWith("rx:P STATUS"))).toBe(true);
    expect(decoded[decoded.length - 1]).toBe("tx:ACK");
  });
});
