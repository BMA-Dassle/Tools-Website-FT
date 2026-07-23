/**
 * Enhanced-3PI cloud client tests: the ConsolidateCards request shape (verbatim
 * from the vendor spec's XML example, p.28) and the raw TCP exchange against an
 * ephemeral local server playing the Transaction Server — success, decline,
 * close-with-no-reply, connect-refused.
 */
import { describe, it, expect } from "vitest";
import net from "node:net";
import { consolidateCardsXml, eisRequest, eisStamps, eisTagText } from "./intercard-eis";
import { IntercardError } from "./intercard";

const OK_REPLY =
  "<iEnhancedInterfaceResponse><CommandStatus>" +
  "<ResponseCode>0</ResponseCode><ResponseDescription>Success</ResponseDescription>" +
  "</CommandStatus></iEnhancedInterfaceResponse>";
const DECLINE_REPLY = OK_REPLY.replace(">0<", ">14<").replace("Success", "Account not found");

function listen(handler: (sock: net.Socket) => void) {
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    // Track accepted sockets and destroy them on close — a paused socket never
    // notices the peer left, so a bare srv.close() can hang on Windows.
    const socks = new Set<net.Socket>();
    const srv = net.createServer((sock) => {
      socks.add(sock);
      sock.on("close", () => socks.delete(sock));
      sock.on("error", () => {});
      handler(sock);
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        port: (srv.address() as net.AddressInfo).port,
        close: () => {
          for (const s of socks) s.destroy();
          return new Promise((r) => srv.close(() => r()));
        },
      }),
    );
  });
}

describe("consolidateCardsXml (spec p.28 request shape)", () => {
  const xml = consolidateCardsXml({
    mac: "AB<>CD",
    targetAccount: "9006223372036854775807", // bigint-scale — must stay text
    sourceAccounts: ["9006223372036854775801", "42"],
    transactionId: "txn-1",
  });

  it("carries the documented elements in the documented shape", () => {
    expect(xml).toContain("<RequestType>ConsolidateCards</RequestType>");
    expect(xml).toContain("<MacAddress>AB&lt;&gt;CD</MacAddress>"); // escaped
    expect(xml).toContain("<TransactionID>txn-1</TransactionID>");
    expect(xml).toContain(
      "<ConsolidateCards><TargetAccount>9006223372036854775807</TargetAccount>" +
        "<ConsolidateSourceAccountList>" +
        "<AccountNumber>9006223372036854775801</AccountNumber>" +
        "<AccountNumber>42</AccountNumber>" +
        "</ConsolidateSourceAccountList></ConsolidateCards>",
    );
    // Header before body, both inside the request envelope.
    expect(xml.indexOf("<TransactionRequest>")).toBeLessThan(xml.indexOf("<ConsolidateCards>"));
    expect(xml).toContain("</iEnhancedInterfaceRequest>");
  });

  it("stamps LT/UTC with millisecond resolution (spec requirement)", () => {
    const { lt, utc } = eisStamps(new Date("2026-07-23T18:30:05.091Z"));
    expect(utc).toBe("2026-07-23T18:30:05.091Z");
    // July = EDT: Eastern wall time with the -04:00 offset.
    expect(lt).toBe("2026-07-23T14:30:05.091-04:00");
  });
});

describe("eisRequest (raw TCP exchange)", () => {
  it("resolves the reply on ResponseCode 0", async () => {
    const { port, close } = await listen((sock) => sock.on("data", () => sock.write(OK_REPLY)));
    const reply = await eisRequest("<x/>", { host: "127.0.0.1", port });
    await close();
    expect(eisTagText(reply, "ResponseCode")).toBe("0");
    expect(eisTagText(reply, "ResponseDescription")).toBe("Success");
  });

  it("resolves a decline reply (caller reads the non-0 code)", async () => {
    const { port, close } = await listen((sock) =>
      sock.on("data", () => sock.write(DECLINE_REPLY)),
    );
    const reply = await eisRequest("<x/>", { host: "127.0.0.1", port });
    await close();
    expect(eisTagText(reply, "ResponseCode")).toBe("14");
    expect(eisTagText(reply, "ResponseDescription")).toBe("Account not found");
  });

  it("close with no reply resolves empty — no parseable code (caller treats as failed exchange)", async () => {
    const { port, close } = await listen((sock) => sock.end());
    const reply = await eisRequest("<x/>", { host: "127.0.0.1", port });
    await close();
    expect(eisTagText(reply, "ResponseCode")).toBeNull();
  });

  it("connect refused throws IntercardError (never a silent success)", async () => {
    const { port, close } = await listen(() => {});
    await close(); // free the port so the connect is refused
    await expect(eisRequest("<x/>", { host: "127.0.0.1", port })).rejects.toBeInstanceOf(
      IntercardError,
    );
  });

  it("a hung server times out with EIS_TIMEOUT", async () => {
    const { port, close } = await listen(() => {
      /* accept and say nothing */
    });
    await expect(
      eisRequest("<x/>", { host: "127.0.0.1", port, timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: "EIS_TIMEOUT" });
    await close();
  });
});
