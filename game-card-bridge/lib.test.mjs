/**
 * Zero-dep tests for the EIS socket layer + ack-outcome classifier
 * (`node --test`). An ephemeral local TCP server plays the EIS so every
 * failure mode the queue worker must classify is reproduced for real:
 * connect-refused, accept-then-hang, close-with-no-reply, decline, success.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { creditTokensEis, eisRequest, classifyOutcome, creditXml, tagText } from "./lib.mjs";

const OK_REPLY =
  "<iEnhancedInterfaceResponse><CommandStatus>" +
  "<ResponseCode>0</ResponseCode><ResponseDescription>Approved</ResponseDescription>" +
  "</CommandStatus></iEnhancedInterfaceResponse>";
const DECLINE_REPLY = OK_REPLY.replace(">0<", ">14<").replace("Approved", "Account not found");

function listen(handler) {
  return new Promise((resolve) => {
    // Track accepted sockets and destroy them on close: a socket with no data
    // listener is paused and never notices the peer left, so a bare
    // srv.close() would wait forever on Windows.
    const socks = new Set();
    const srv = net.createServer((sock) => {
      socks.add(sock);
      sock.on("close", () => socks.delete(sock));
      sock.on("error", () => {});
      handler(sock);
    });
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        port: srv.address().port,
        close: () => {
          for (const s of socks) s.destroy();
          return new Promise((r) => srv.close(r));
        },
      }),
    );
  });
}

const cfg = (port, timeoutMs = 1500) => ({ ip: "127.0.0.1", port, timeoutMs });
const card = {
  mac: "TESTMAC",
  accountNumber: "1038010",
  tokens: 500,
  bonusTokens: 100,
  employeeId: "WebReload",
};

test("connect refused → attempted=false → no_attempt (safe SOAP fallback)", async () => {
  const { port, close } = await listen(() => {});
  await close(); // free the port so the connect is refused
  let err = null;
  try {
    await eisRequest("<x/>", cfg(port));
  } catch (e) {
    err = e;
  }
  assert.ok(err, "should reject");
  assert.equal(err.attempted, false);
  assert.equal(classifyOutcome(null, err), "no_attempt");
});

test("accept then hang → timeout with attempted=true → unknown (never retried)", async () => {
  const { port, close } = await listen(() => {
    /* accept and say nothing */
  });
  let err = null;
  try {
    await eisRequest("<x/>", cfg(port, 300));
  } catch (e) {
    err = e;
  }
  await close();
  assert.ok(err, "should time out");
  assert.equal(err.attempted, true);
  assert.equal(classifyOutcome(null, err), "unknown");
});

test("accept then close with no reply → code null → unknown, never declined", async () => {
  const { port, close } = await listen((sock) => sock.end());
  const res = await creditTokensEis({ ...cfg(port), ...card });
  await close();
  assert.equal(res.ok, false);
  assert.equal(res.code, null);
  assert.equal(classifyOutcome(res, null), "unknown");
});

test("ResponseCode 0 → ok", async () => {
  const { port, close } = await listen((sock) => sock.on("data", () => sock.write(OK_REPLY)));
  const res = await creditTokensEis({ ...cfg(port), ...card });
  await close();
  assert.equal(res.ok, true);
  assert.equal(res.code, "0");
  assert.equal(res.description, "Approved");
  assert.equal(res.attempted, true);
  assert.equal(classifyOutcome(res, null), "ok");
});

test("non-0 ResponseCode → declined (EIS definitively did not credit)", async () => {
  const { port, close } = await listen((sock) => sock.on("data", () => sock.write(DECLINE_REPLY)));
  const res = await creditTokensEis({ ...cfg(port), ...card });
  await close();
  assert.equal(res.ok, false);
  assert.equal(res.code, "14");
  assert.equal(classifyOutcome(res, null), "declined");
});

test("config/input problems throw attempted=false (nothing was sent)", async () => {
  for (const bad of [
    { ...cfg(1), ...card, mac: "" },
    { ...cfg(1), ...card, accountNumber: "" },
  ]) {
    let err = null;
    try {
      await creditTokensEis(bad);
    } catch (e) {
      err = e;
    }
    assert.ok(err);
    assert.equal(err.attempted, false);
    assert.equal(classifyOutcome(null, err), "no_attempt");
  }
});

test("creditXml carries the request shape the EIS expects", () => {
  const xml = creditXml({
    accountNumber: "42",
    tokens: 5,
    bonusTokens: 1,
    employeeId: "WebReload",
    mac: "AB<>CD",
  });
  assert.ok(xml.includes("<RequestType>CreditAccounts</RequestType>"));
  assert.ok(xml.includes("<MacAddress>AB&lt;&gt;CD</MacAddress>"), "MAC is XML-escaped");
  assert.ok(xml.includes("<AccountNumber>42</AccountNumber>"));
  assert.ok(xml.includes("<Tokens>5</Tokens><TokenBonus>1</TokenBonus>"));
  assert.equal(tagText(OK_REPLY, "ResponseCode"), "0");
  assert.equal(tagText("<a>", "ResponseCode"), null);
});
