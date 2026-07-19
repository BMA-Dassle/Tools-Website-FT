import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTransport } from "./engine/fake-transport";
import { CrtReaderClient, type TransportFactory } from "./client";
import { CM, EOT, STX } from "./protocol/constants";
import { CrtError, CrtLinkError, CrtReadError } from "./protocol/errors";
import { buildNegativeResponse, buildPositiveResponse } from "./protocol/testing";

const ACK = 0x06;
const A = (s: string) => [...s].map((c) => c.charCodeAt(0));

interface SeenCommand {
  cm: number;
  pm: number;
  data: Uint8Array;
}

type Script = (cmd: SeenCommand, device: ScriptedDevice) => Array<Uint8Array | number[]> | "silent";

/** Wire-accurate fake device: ACKs commands, answers per script, echoes EOT. */
class ScriptedDevice {
  readonly transport = new FakeTransport();
  readonly commands: SeenCommand[] = [];
  initCount = 0;

  constructor(script: Script) {
    this.transport.onWrite = (bytes) => {
      if (bytes.length === 1 && bytes[0] === EOT) {
        this.transport.receive([EOT]);
        return;
      }
      if (bytes[0] !== STX) return; // host ACK/NAK — not ours to answer
      const len = (bytes[2] << 8) | bytes[3];
      const cmd: SeenCommand = { cm: bytes[5], pm: bytes[6], data: bytes.slice(7, 4 + len) };
      this.commands.push(cmd);
      if (cmd.cm === CM.INIT) this.initCount++;
      const replies = script(cmd, this);
      if (replies === "silent") return;
      for (const r of replies) this.transport.receive(r);
    };
  }
}

const ok = (
  cmd: SeenCommand,
  data: number[] = [],
  st: [number, number, number] = [0x30, 0x32, 0x30],
) => [[ACK], buildPositiveResponse({ cm: cmd.cm, pm: cmd.pm, st, data })];

/** The standard identity-aware script for a healthy doc'd unit. */
const healthyScript: Script = (cmd) => {
  switch (cmd.cm) {
    case CM.INIT:
      return ok(cmd, A("CRT-591-M001"));
    case CM.READ_VERSION:
      return ok(cmd, A("CRT-591-M001 V2.3"));
    case CM.READ_CONFIG:
      return ok(cmd, [0x01, 0x02, 0xab]);
    case CM.SERIAL_NUMBER:
      return ok(cmd, [4, ...A("SN42")]);
    case CM.STATUS:
      return ok(cmd);
    default:
      return ok(cmd);
  }
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function factoryFor(devices: Record<number, ScriptedDevice>, calls: number[]): TransportFactory {
  return (baud) => {
    calls.push(baud);
    const dev = devices[baud];
    if (!dev) throw new Error(`unexpected baud ${baud}`);
    return Promise.resolve(dev.transport);
  };
}

describe("CrtReaderClient.connect", () => {
  it("connects at the first baud and discovers identity", async () => {
    const dev = new ScriptedDevice(healthyScript);
    const calls: number[] = [];
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, calls));
    expect(calls).toEqual([115200]);
    expect(client.info).toMatchObject({
      firmware: "CRT-591-M001",
      version: "CRT-591-M001 V2.3",
      serialNumber: "SN42",
      configHex: "01 02 AB",
      baudRate: 115200,
      modelMismatch: false,
    });
    // Handshake order: INIT → VERSION → CONFIG → SERIAL.
    expect(dev.commands.map((c) => c.cm)).toEqual([
      CM.INIT,
      CM.READ_VERSION,
      CM.READ_CONFIG,
      CM.SERIAL_NUMBER,
    ]);
    await client.close();
  });

  it("falls through a silent baud and connects at the next", async () => {
    const silent = new ScriptedDevice(() => "silent");
    silent.transport.onWrite = () => undefined; // truly dead line: no EOT echo either
    const healthy = new ScriptedDevice(healthyScript);
    const calls: number[] = [];
    const promise = CrtReaderClient.connect(factoryFor({ 115200: silent, 9600: healthy }, calls));
    const settled = promise.then(
      (c) => c,
      (e) => {
        throw e;
      },
    );
    // 115200: EOT + retry (300ms each), then INIT resends (4 × 300ms).
    await vi.advanceTimersByTimeAsync(10_000);
    const client = await settled;
    expect(calls).toEqual([115200, 9600]);
    expect(client.info.baudRate).toBe(9600);
    await client.close();
  });

  it("tries the preferred baud first", async () => {
    const dev = new ScriptedDevice(healthyScript);
    const calls: number[] = [];
    const client = await CrtReaderClient.connect(factoryFor({ 57600: dev }, calls), {
      preferredBaud: 57600,
    });
    expect(calls[0]).toBe(57600);
    await client.close();
  });

  it("flags a model mismatch and tolerates rejected discovery reads", async () => {
    const dev = new ScriptedDevice((cmd) => {
      switch (cmd.cm) {
        case CM.INIT:
          return ok(cmd, A("CRT-591-HB2"));
        case CM.READ_VERSION:
        case CM.SERIAL_NUMBER:
          return [[ACK], buildNegativeResponse({ cm: cmd.cm, pm: cmd.pm, code: "00" })];
        case CM.READ_CONFIG:
          return ok(cmd, []);
        default:
          return ok(cmd);
      }
    });
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    expect(client.info).toMatchObject({
      firmware: "CRT-591-HB2",
      version: null,
      serialNumber: null,
      configHex: null,
      modelMismatch: true,
    });
    await client.close();
  });

  it("fails with physical-layer guidance when every baud stays silent", async () => {
    const dead: Record<number, ScriptedDevice> = {};
    for (const baud of [115200, 9600, 38400, 19200, 57600]) {
      const d = new ScriptedDevice(() => "silent");
      d.transport.onWrite = () => undefined;
      dead[baud] = d;
    }
    const promise = CrtReaderClient.connect(factoryFor(dead, []));
    const expectation = expect(promise).rejects.toSatisfy(
      (e: unknown) => e instanceof CrtLinkError && /check the COM cable/i.test(e.message),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expectation;
  });
});

describe("CrtReaderClient — B0 recovery policy", () => {
  async function connectFlaky(script: Script) {
    const dev = new ScriptedDevice(script);
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    return { dev, client };
  }

  it("auto-reinits ONCE for idempotent reads after a power-cycle (B0)", async () => {
    let statusCalls = 0;
    const { dev, client } = await connectFlaky((cmd, device) => {
      if (cmd.cm === CM.STATUS) {
        statusCalls++;
        if (statusCalls === 1) {
          return [[ACK], buildNegativeResponse({ cm: cmd.cm, pm: cmd.pm, code: "B0" })];
        }
        return ok(cmd, [], [0x31, 0x31, 0x30]);
      }
      if (cmd.cm === CM.INIT) return ok(cmd, A("CRT-591-M001"));
      return healthyScript(cmd, device);
    });
    const initsAfterConnect = dev.initCount;
    const result = await client.getStatus();
    expect(result.status.card).toBe("atGate");
    expect(dev.initCount).toBe(initsAfterConnect + 1); // exactly one recovery INIT
    await client.close();
  });

  it("surfaces B0 on motion commands without auto-reinit", async () => {
    const { dev, client } = await connectFlaky((cmd, device) => {
      if (cmd.cm === CM.MOVE) {
        return [[ACK], buildNegativeResponse({ cm: cmd.cm, pm: cmd.pm, code: "B0" })];
      }
      return healthyScript(cmd, device);
    });
    const initsAfterConnect = dev.initCount;
    await expect(client.moveCard("outOfGate")).rejects.toSatisfy(
      (e: unknown) => e instanceof CrtError && e.info.code === "B0",
    );
    expect(dev.initCount).toBe(initsAfterConnect); // untouched
    await client.close();
  });
});

describe("CrtReaderClient — composed and typed operations", () => {
  it("dispenseCard chains MOVE icPosition then MOVE outOfGate", async () => {
    const dev = new ScriptedDevice(healthyScript);
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    await client.dispenseCard();
    const moves = dev.commands.filter((c) => c.cm === CM.MOVE).map((c) => c.pm);
    expect(moves).toEqual([0x31, 0x39]);
    await client.close();
  });

  it("parses an RF activation end-to-end and fires onStatus", async () => {
    const dev = new ScriptedDevice((cmd, device) => {
      if (cmd.cm === CM.RF && cmd.pm === 0x30) {
        return ok(cmd, [0x4d, 0x00, 0x04, 4, 0xde, 0xad, 0xbe, 0xef, 0x08], [0x32, 0x32, 0x30]);
      }
      return healthyScript(cmd, device);
    });
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    const statuses: string[] = [];
    client.onStatus((s) => statuses.push(s.card));
    const result = await client.rfActivate("AB");
    expect(result.value).toMatchObject({ type: "mifare", card: "s50", uidHex: "DEADBEEF" });
    expect(result.status.card).toBe("atRfIcPosition");
    expect(statuses).toContain("atRfIcPosition");
    await client.close();
  });

  it("mifareRead strips the SW and mifareWrite refuses trailer blocks locally", async () => {
    const dev = new ScriptedDevice((cmd, device) => {
      if (cmd.cm === CM.RF && cmd.pm === 0x33) {
        return ok(cmd, [1, 2, 3, 4, 0x90, 0x00]);
      }
      return healthyScript(cmd, device);
    });
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    const read = await client.mifareRead({ sector: 1, block: 0, blocks: 1 });
    expect(Array.from(read.value)).toEqual([1, 2, 3, 4]);
    await expect(
      client.mifareWrite({ sector: 1, block: 3, data: new Uint8Array(16) }),
    ).rejects.toThrow(/trailer/);
    await client.close();
  });

  it("magRead resolves a negative-head reply (does not throw) and parses tracks", async () => {
    const trackAscii = "1P6283=7496003776810700729~P6283=0000000001037356~N24";
    const dev = new ScriptedDevice((cmd, device) => {
      if (cmd.cm === 0x36 && cmd.pm === 0x37) {
        return [
          [ACK],
          buildNegativeResponse({
            cm: 0x36,
            pm: 0x37,
            code: "02",
            data: [...trackAscii].map((c) => c.charCodeAt(0)),
          }),
        ];
      }
      return healthyScript(cmd, device);
    });
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    const mag = await client.magRead();
    expect(mag.candidates).toContain("0000000001037356");
    expect(mag.cardNumber).toBe("0000000001037356");
    const sent = dev.commands[dev.commands.length - 1];
    expect(sent.cm).toBe(0x36);
    expect(sent.pm).toBe(0x37);
    await client.close();
  });

  it("issueAndReadCard feeds straight to the read station (MOVE 34h), then reads", async () => {
    const trackAscii = "1P6283=7496003776810700729~P6283=0000000001037356~N24";
    const dev = new ScriptedDevice((cmd, device) => {
      if (cmd.cm === CM.MOVE && cmd.pm === 0x34) return ok(cmd, [], [0x32, 0x32, 0x30]);
      if (cmd.cm === 0x36) {
        return [
          [ACK],
          buildNegativeResponse({
            cm: 0x36,
            pm: 0x37,
            code: "02",
            data: [...trackAscii].map((c) => c.charCodeAt(0)),
          }),
        ];
      }
      return healthyScript(cmd, device);
    });
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    // issueAndReadCard settles with real delay() calls before reading — advance
    // the fake timers so those resolve.
    const p = client.issueAndReadCard();
    await vi.runAllTimersAsync();
    const mag = await p;
    expect(mag.cardNumber).toBe("0000000001037356");
    // Clean path: a single feed to the read station (34h) — no front poke (31h).
    expect(dev.commands.filter((c) => c.cm === CM.MOVE).map((c) => c.pm)).toEqual([0x34]);
    // Held inside — present holds it at the gate (30h), not out-of-gate (39h).
    await client.presentCard();
    expect(dev.commands.filter((c) => c.cm === CM.MOVE).map((c) => c.pm)).toEqual([0x34, 0x30]);
    await client.close();
  });

  it("issueAndReadCard falls back to stacker dispense (31h→34h) if the direct feed reads nothing", async () => {
    const trackAscii = "1P6283=x~P6283=0000000001037356~N";
    let magCalls = 0;
    const dev = new ScriptedDevice((cmd, device) => {
      if (cmd.cm === CM.MOVE && (cmd.pm === 0x31 || cmd.pm === 0x34))
        return ok(cmd, [], [0x32, 0x32, 0x30]);
      if (cmd.cm === 0x36) {
        magCalls++;
        // The first feed's read + its built-in settle-retry BOTH come back empty
        // (reads 1 & 2), so issueAndReadCard falls back to the 31h dispense; the
        // read after that (3rd) returns tracks.
        const empty = magCalls <= 2;
        const data = empty ? [] : [...trackAscii].map((c) => c.charCodeAt(0));
        return [
          [ACK],
          buildNegativeResponse({ cm: 0x36, pm: 0x37, code: empty ? "00" : "02", data }),
        ];
      }
      return healthyScript(cmd, device);
    });
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    const p = client.issueAndReadCard();
    await vi.runAllTimersAsync();
    const mag = await p;
    expect(mag.cardNumber).toBe("0000000001037356");
    // 34h (direct, reads empty) → 31h (dispense) → 34h (reposition) → read ok.
    expect(dev.commands.filter((c) => c.cm === CM.MOVE).map((c) => c.pm)).toEqual([
      0x34, 0x31, 0x34,
    ]);
    await client.close();
  });

  it("magRead throws a CARD read fault when the reply has no clean account", async () => {
    const dev = new ScriptedDevice((cmd, device) => {
      if (cmd.cm === 0x36) {
        // e=00 with no track payload — wrong position / partial read.
        return [[ACK], buildNegativeResponse({ cm: 0x36, pm: 0x37, code: "00" })];
      }
      return healthyScript(cmd, device);
    });
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    await expect(client.magRead()).rejects.toBeInstanceOf(CrtReadError);
    await client.close();
  });

  it("magRead rejects a garbage/partial read (no 16-digit account) as a CARD fault", async () => {
    const dev = new ScriptedDevice((cmd, device) => {
      if (cmd.cm === 0x36) {
        // Only a short digit run ("2124") — the stale/partial-read bug.
        const junk = "P6283=2124~";
        return [
          [ACK],
          buildNegativeResponse({
            cm: 0x36,
            pm: 0x37,
            code: "02",
            data: [...junk].map((c) => c.charCodeAt(0)),
          }),
        ];
      }
      return healthyScript(cmd, device);
    });
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    await expect(client.magRead()).rejects.toBeInstanceOf(CrtReadError);
    await client.close();
  });

  it("acceptAndReadCard permits entry, waits for the read position, then reads", async () => {
    const trackAscii = "1P6283=x~P6283=0000000001037356~N";
    let statusCalls = 0;
    const dev = new ScriptedDevice((cmd, device) => {
      if (cmd.cm === CM.ENTRY) return ok(cmd);
      if (cmd.cm === CM.STATUS) {
        statusCalls++;
        // Poll 1: no card. Poll 2: at gate (still being pulled — not ready).
        // Poll 3: auto-carried to the read station (st0=2) — ready.
        const st: [number, number, number] =
          statusCalls === 1
            ? [0x30, 0x32, 0x30]
            : statusCalls === 2
              ? [0x31, 0x32, 0x30]
              : [0x32, 0x32, 0x30];
        return ok(cmd, [], st);
      }
      if (cmd.cm === 0x36) {
        return [
          [ACK],
          buildNegativeResponse({
            cm: 0x36,
            pm: 0x37,
            code: "02",
            data: [...trackAscii].map((c) => c.charCodeAt(0)),
          }),
        ];
      }
      return healthyScript(cmd, device);
    });
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    const promise = client.acceptAndReadCard({ timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(2_000); // let two 800ms poll gaps elapse
    const mag = await promise;
    expect(mag.cardNumber).toBe("0000000001037356");
    // "Permit mag card in" is ENTRY 32h (the vendor's reload permit), not 30h.
    expect(dev.commands.some((c) => c.cm === CM.ENTRY && c.pm === 0x32)).toBe(true);
    // No positioning move — the reader auto-carries an inserted card.
    expect(dev.commands.some((c) => c.cm === CM.MOVE)).toBe(false);
    await client.close();
  });

  it("waitForCard rejects on timeout when nothing is inserted", async () => {
    const dev = new ScriptedDevice(healthyScript); // STATUS always reports no card
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    const promise = client.waitForCard({ timeoutMs: 2_000 });
    const expectation = expect(promise).rejects.toThrow(/No card was inserted/);
    await vi.advanceTimersByTimeAsync(4_000);
    await expectation;
    await client.close();
  });

  it("raw() passes undocumented commands through verbatim", async () => {
    const dev = new ScriptedDevice((cmd, device) => {
      if (cmd.cm === 0x36) return ok(cmd, A("TRACK2DATA"));
      return healthyScript(cmd, device);
    });
    const client = await CrtReaderClient.connect(factoryFor({ 115200: dev }, []));
    const frame = await client.raw(0x36, 0x30);
    expect(frame.kind).toBe("positive");
    const sent = dev.commands[dev.commands.length - 1];
    expect(sent.cm).toBe(0x36);
    await client.close();
  });
});
