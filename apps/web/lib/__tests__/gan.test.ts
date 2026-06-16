import { describe, it, expect } from "vitest";
import {
  buildGanPrefix,
  composeGan,
  CURRENT_DEPOSIT_GAN_PREFIXES,
  LEGACY_DEPOSIT_GAN_PREFIXES,
  GAN_MAX_LEN,
} from "../gan";
import { isInternalDepositGan } from "../square-gift-card";
import { HERMES_CENTER_MAP } from "../hermes-client";

describe("buildGanPrefix", () => {
  it("builds GF prefixes from Square location ids", () => {
    expect(buildGanPrefix("GF", "TXBSQN0FEKQ11")).toBe("GFHPFM");
    expect(buildGanPrefix("GF", "LAB52GY480CJF")).toBe("GFFT");
    expect(buildGanPrefix("GF", "PPTR5G2N0QXF7")).toBe("GFHPN");
  });

  it("builds WEB prefixes from Square location ids", () => {
    expect(buildGanPrefix("WEB", "TXBSQN0FEKQ11")).toBe("WEBHPFM");
    expect(buildGanPrefix("WEB", "LAB52GY480CJF")).toBe("WEBFT");
    expect(buildGanPrefix("WEB", "PPTR5G2N0QXF7")).toBe("WEBHPN");
  });

  it("accepts centerCode aliases as well as location ids", () => {
    expect(buildGanPrefix("WEB", "fort-myers")).toBe("WEBHPFM");
    expect(buildGanPrefix("WEB", "fasttrax")).toBe("WEBFT");
    expect(buildGanPrefix("GF", "naples")).toBe("GFHPN");
  });

  it("falls back to the FM tag for an unknown location", () => {
    expect(buildGanPrefix("WEB", "nonsense")).toBe("WEBHPFM");
  });
});

describe("composeGan", () => {
  it("leaves a short GAN untouched and marks it usable", () => {
    expect(composeGan("WEBFT", "12345678")).toEqual({ gan: "WEBFT12345678", useCustom: true });
  });

  it("strips non-alphanumerics from prefix and suffix", () => {
    expect(composeGan("WEB-FT", "1234 5678").gan).toBe("WEBFT12345678");
  });

  it("trims the suffix tail so prefix+suffix never exceeds the 20-char ceiling", () => {
    // WEBHPFM (7) + a 16-char QAMF id = 23 → trim suffix to its last 13 chars.
    const { gan, useCustom } = composeGan("WEBHPFM", "ABCDEFGHIJKLMNOP");
    expect(gan).toBe("WEBHPFMDEFGHIJKLMNOP");
    expect(gan.length).toBe(GAN_MAX_LEN);
    expect(gan.startsWith("WEBHPFM")).toBe(true); // prefix preserved
    expect(gan.endsWith("KLMNOP")).toBe(true); // suffix tail preserved
    expect(useCustom).toBe(true);
  });

  it("reports useCustom=false when the prefix alone can't reach 8 chars", () => {
    expect(composeGan("GF", "").useCustom).toBe(false);
  });
});

describe("isInternalDepositGan ↔ generator coverage (money-bug backstop)", () => {
  it("blocks every prefix buildGanPrefix can emit", () => {
    for (const channel of ["GF", "WEB"] as const) {
      for (const loc of ["TXBSQN0FEKQ11", "LAB52GY480CJF", "PPTR5G2N0QXF7"]) {
        const gan = composeGan(buildGanPrefix(channel, loc), "12345678").gan;
        expect(isInternalDepositGan(gan)).toBe(true);
      }
    }
  });

  it("blocks every current and legacy prefix", () => {
    for (const p of [...CURRENT_DEPOSIT_GAN_PREFIXES, ...LEGACY_DEPOSIT_GAN_PREFIXES]) {
      expect(isInternalDepositGan(`${p}12345678`)).toBe(true);
    }
  });

  it("blocks every GF prefix persisted by the contract dispatch (HERMES_CENTER_MAP)", () => {
    for (const center of Object.values(HERMES_CENTER_MAP)) {
      expect(isInternalDepositGan(`${center.ganPrefix}12345678`)).toBe(true);
    }
  });

  it("does NOT flag a real customer gift card GAN (numeric)", () => {
    expect(isInternalDepositGan("7777000012340000")).toBe(false);
    expect(isInternalDepositGan(null)).toBe(false);
    expect(isInternalDepositGan("")).toBe(false);
  });
});
