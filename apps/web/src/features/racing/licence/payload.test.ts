/**
 * The barcode payload has been wrong in production before, and the failure mode
 * is invisible everywhere except the one place it matters: the pass installs,
 * the page renders, the API returns 200 — and the register refuses to scan it.
 *
 * These pin the exact string. Change them only with a live register scan to
 * prove the new one works.
 */
import { describe, it, expect, afterEach } from "vitest";
import { memberQrPayload, licenceHubUrl } from "./payload";

const CODE = "mgrm2g8o42wxc";

afterEach(() => {
  delete process.env.SMSTIM_SITE;
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe("memberQrPayload", () => {
  it("is the AUTHENTICATE url the BMI register scans", () => {
    expect(memberQrPayload(CODE)).toBe(
      "https://smstim.in/908/authenticate/?login_code=mgrm2g8o42wxc",
    );
  });

  it("is NOT the SMS-Timing app's JSON-array payload", () => {
    // `https://smstim.in?["headpinzftmyers","<uuid>"]` is the app's own QR and
    // the register REJECTS it. Both shapes share the smstim.in host, which is
    // exactly why this is easy to get wrong — see kiosk/qr-scanner/member-qr.ts.
    const out = memberQrPayload(CODE);
    expect(out).not.toContain("[");
    expect(out).toContain("/authenticate/");
    expect(out).toContain("login_code=");
  });

  it("follows SMSTIM_SITE so a second club needs no code change", () => {
    process.env.SMSTIM_SITE = "911";
    expect(memberQrPayload(CODE)).toBe(
      "https://smstim.in/911/authenticate/?login_code=mgrm2g8o42wxc",
    );
  });

  it("is the SAME string the wallet pass and the racer hub both use", async () => {
    // The whole reason this module exists: these were two hand-built copies
    // that nothing forced to agree.
    const { buildLicenceMeta } = await import("~/features/racing/wallet/licence-meta");
    const meta = await buildLicenceMeta({
      personId: "409523",
      code: CODE,
      fullName: "Eric Osborn",
      skipPersonFetch: true,
    });
    expect(meta.memberQr).toBe(memberQrPayload(CODE));
  });
});

describe("licenceHubUrl", () => {
  it("points at the racer's permanent page", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://fasttraxent.com";
    expect(licenceHubUrl(CODE)).toBe("https://fasttraxent.com/r/mgrm2g8o42wxc");
  });

  it("accepts an explicit origin so a preview hands out preview links", () => {
    expect(licenceHubUrl(CODE, "https://preview.example")).toBe(
      "https://preview.example/r/mgrm2g8o42wxc",
    );
  });
});
