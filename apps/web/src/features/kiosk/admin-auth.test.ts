import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import { kioskAdminOk, kioskStaffOk } from "./admin-auth";

/** Both gates only read headers.get() and req.url — a minimal fake suffices. */
function req(headers: Record<string, string> = {}, url = "http://kiosk.test/api/kiosk/staff") {
  return { headers: new Headers(headers), url } as unknown as NextRequest;
}

const ENV_KEYS = ["KIOSK_ADMIN_PIN", "KIOSK_STAFF_PIN"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("kioskStaffOk / kioskAdminOk — the two PIN tiers", () => {
  it("staff PIN opens staff", () => {
    process.env.KIOSK_ADMIN_PIN = "9999";
    process.env.KIOSK_STAFF_PIN = "1234";
    expect(kioskStaffOk(req({ "x-kiosk-pin": "1234" }))).toBe(true);
  });

  it("admin PIN opens staff too — the higher credential is never locked out", () => {
    process.env.KIOSK_ADMIN_PIN = "9999";
    process.env.KIOSK_STAFF_PIN = "1234";
    expect(kioskStaffOk(req({ "x-kiosk-pin": "9999" }))).toBe(true);
  });

  it("staff PIN does NOT open admin", () => {
    process.env.KIOSK_ADMIN_PIN = "9999";
    process.env.KIOSK_STAFF_PIN = "1234";
    expect(kioskAdminOk(req({ "x-kiosk-pin": "1234" }))).toBe(false);
    expect(kioskAdminOk(req({ "x-kiosk-pin": "9999" }))).toBe(true);
  });

  it("wrong and blank PINs fail both gates", () => {
    process.env.KIOSK_ADMIN_PIN = "9999";
    process.env.KIOSK_STAFF_PIN = "1234";
    for (const bad of ["", "0000", "12345", "123"]) {
      expect(kioskStaffOk(req({ "x-kiosk-pin": bad }))).toBe(false);
      expect(kioskAdminOk(req({ "x-kiosk-pin": bad }))).toBe(false);
    }
    expect(kioskStaffOk(req())).toBe(false);
  });

  it("KIOSK_STAFF_PIN unset → the owner's interim 14503 works, and so does the admin PIN", () => {
    process.env.KIOSK_ADMIN_PIN = "9999";
    delete process.env.KIOSK_STAFF_PIN;
    expect(kioskStaffOk(req({ "x-kiosk-pin": "14503" }))).toBe(true);
    expect(kioskStaffOk(req({ "x-kiosk-pin": "9999" }))).toBe(true);
    expect(kioskStaffOk(req({ "x-kiosk-pin": "1234" }))).toBe(false);
    // The interim staff PIN must never open admin.
    expect(kioskAdminOk(req({ "x-kiosk-pin": "14503" }))).toBe(false);
  });

  it("KIOSK_STAFF_PIN set → it replaces the interim fallback", () => {
    process.env.KIOSK_ADMIN_PIN = "9999";
    process.env.KIOSK_STAFF_PIN = "5555";
    expect(kioskStaffOk(req({ "x-kiosk-pin": "5555" }))).toBe(true);
    expect(kioskStaffOk(req({ "x-kiosk-pin": "14503" }))).toBe(false);
  });

  it("accepts the legacy x-kiosk-admin-pin header and the ?pin= query", () => {
    process.env.KIOSK_ADMIN_PIN = "9999";
    process.env.KIOSK_STAFF_PIN = "1234";
    expect(kioskStaffOk(req({ "x-kiosk-admin-pin": "1234" }))).toBe(true);
    expect(kioskAdminOk(req({ "x-kiosk-admin-pin": "9999" }))).toBe(true);
    expect(kioskStaffOk(req({}, "http://kiosk.test/api/kiosk/staff?pin=1234"))).toBe(true);
  });
});
