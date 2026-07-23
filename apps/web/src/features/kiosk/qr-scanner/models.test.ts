import { describe, expect, it } from "vitest";
import { DEFAULT_SCANNER_MODEL_ID, getScannerModel, listScannerModels } from "./models";

describe("scanner model registry", () => {
  it("resolves the default model", () => {
    const model = getScannerModel(DEFAULT_SCANNER_MODEL_ID);
    expect(model).not.toBeNull();
    expect(model!.id).toBe(DEFAULT_SCANNER_MODEL_ID);
  });

  it("returns null for unknown/absent ids (configs from newer builds must degrade)", () => {
    expect(getScannerModel("some-future-scanner")).toBeNull();
    expect(getScannerModel(null)).toBeNull();
    expect(getScannerModel(undefined)).toBeNull();
    expect(getScannerModel("")).toBeNull();
  });

  it("every entry is internally consistent", () => {
    for (const model of listScannerModels()) {
      expect(getScannerModel(model.id)).toBe(model);
      expect(model.kind).toBe("serial-line");
      expect(model.label.length).toBeGreaterThan(0);
      expect(model.defaultBaudRate).toBeGreaterThan(0);
      // The panel's baud select is built from baudCandidates — the default must be offered.
      expect(model.baudCandidates).toContain(model.defaultBaudRate);
    }
  });

  it("honeywell-3320g: 115200 default per the vendor guide", () => {
    const m = getScannerModel("honeywell-3320g")!;
    expect(m.defaultBaudRate).toBe(115200);
    expect(m.expectedUsbIds[0]?.usbVendorId).toBe(0x0c2e);
  });
});
