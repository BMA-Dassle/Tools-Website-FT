import { describe, expect, it } from "vitest";
import { LineAccumulator } from "./line-accumulator";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("LineAccumulator", () => {
  it("one complete CRLF-terminated scan → one payload, CR stripped", () => {
    const acc = new LineAccumulator();
    expect(acc.push(bytes("FT:123:456\r\n"))).toEqual(["FT:123:456"]);
  });

  it("payload fragmented across chunks stays buffered until the terminator", () => {
    const acc = new LineAccumulator();
    expect(acc.push(bytes("PAY"))).toEqual([]);
    expect(acc.push(bytes("LOAD\r"))).toEqual(["PAYLOAD"]);
    expect(acc.push(bytes("\nNEXT\r\n"))).toEqual(["NEXT"]);
  });

  it("multiple scans in one chunk come out in order", () => {
    const acc = new LineAccumulator();
    expect(acc.push(bytes("a\r\nb\r\nc\r\n"))).toEqual(["a", "b", "c"]);
  });

  it("tolerates LF-only and CR-only terminators", () => {
    expect(new LineAccumulator().push(bytes("lf-only\n"))).toEqual(["lf-only"]);
    const cr = new LineAccumulator();
    expect(cr.push(bytes("cr-only\r"))).toEqual(["cr-only"]);
  });

  it("drops blank / whitespace-only lines, trims edges, keeps interior spaces", () => {
    const acc = new LineAccumulator();
    expect(acc.push(bytes("\r\n   \r\n  hello world  \r\n"))).toEqual(["hello world"]);
  });

  it("multibyte UTF-8 split across a chunk boundary decodes intact", () => {
    const acc = new LineAccumulator();
    const encoded = bytes("Beyoncé\r\n"); // é = 2 bytes; split inside it
    const cut = 6; // "Beyonc" is 6 single-byte chars; byte 7 starts é
    expect(acc.push(encoded.slice(0, cut + 1))).toEqual([]);
    expect(acc.push(encoded.slice(cut + 1))).toEqual(["Beyoncé"]);
  });

  it("caps a terminator-less flood, then recovers on the next framed scan", () => {
    const acc = new LineAccumulator({ maxLineBytes: 16 });
    expect(acc.push(bytes("x".repeat(40)))).toEqual([]); // dropped, no garbage emitted
    expect(acc.push(bytes("clean\r\n"))).toEqual(["clean"]);
  });

  it("reset() drops the buffered tail", () => {
    const acc = new LineAccumulator();
    acc.push(bytes("partial"));
    acc.reset();
    expect(acc.push(bytes("\n"))).toEqual([]); // tail gone — nothing to complete
    expect(acc.push(bytes("ok\r\n"))).toEqual(["ok"]);
  });
});
