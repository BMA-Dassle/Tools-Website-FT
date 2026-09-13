import { describe, expect, it } from "vitest";
import {
  COLLATERAL_ACCEPT,
  COLLATERAL_MAX_BYTES,
  collateralTypeFromName,
  collateralTypeFromUrl,
  extensionOf,
  normaliseTags,
  parseTagInput,
  sizeLabel,
  titleFromFilename,
  validityOf,
} from "./library";

/**
 * The card copy in the prototype is "HPFM · PDF · 310 KB · updated Sep 1", so
 * these helpers decide what a rep reads on every tile. They also decide what
 * the upload route will accept, which is the part that matters: a public blob
 * URL serving an .html or an .exe a rep was handed by a guest is a liability,
 * so the extension table is the gate and the browser's `accept` attribute is
 * built from the same table rather than typed out again.
 */

describe("collateralTypeFromName", () => {
  it("labels the kinds the prototype's library holds", () => {
    expect(collateralTypeFromName("Group Pricing HPFM 2026.pdf")).toBe("PDF");
    expect(collateralTypeFromName("Corporate deck (editable).pptx")).toBe("PPTX");
    expect(collateralTypeFromName("menu.DOCX")).toBe("DOCX");
    expect(collateralTypeFromName("rates.xlsx")).toBe("XLSX");
    expect(collateralTypeFromName("lane.JPEG")).toBe("JPG");
    expect(collateralTypeFromName("lane.png")).toBe("PNG");
  });

  it("refuses anything else, including the dangerous ones", () => {
    expect(collateralTypeFromName("payload.html")).toBeNull();
    expect(collateralTypeFromName("setup.exe")).toBeNull();
    expect(collateralTypeFromName("script.svg")).toBeNull();
    expect(collateralTypeFromName("no-extension")).toBeNull();
  });

  it("offers exactly those extensions to the file picker", () => {
    expect(COLLATERAL_ACCEPT).toContain(".pdf");
    expect(COLLATERAL_ACCEPT).toContain(".pptx");
    expect(COLLATERAL_ACCEPT).not.toContain(".html");
  });

  it("reads the extension past a query string on a pasted URL", () => {
    expect(extensionOf("https://x.test/a/b/flyer.pdf?download=1")).toBe("pdf");
    expect(collateralTypeFromUrl("https://x.test/flyer.pdf?v=2")).toBe("PDF");
    expect(collateralTypeFromUrl("https://x.test/some/page")).toBe("FILE");
  });
});

describe("titleFromFilename", () => {
  it("turns a filename nobody chose carefully into something a rep can read", () => {
    expect(titleFromFilename("group_pricing-hpfm-2026.pdf")).toBe("group pricing hpfm 2026");
    expect(titleFromFilename("C:\\Users\\kelsea\\Holiday Party Menu 2026.pdf")).toBe(
      "Holiday Party Menu 2026",
    );
    expect(titleFromFilename("deck.pptx")).toBe("deck");
  });
});

describe("validityOf", () => {
  const today = "2026-09-13";

  it("is current when there are no dates at all", () => {
    expect(validityOf({ validFrom: null, validUntil: null }, today)).toBe("current");
  });

  it("is upcoming before it starts and expired after it ends, inclusive on both days", () => {
    expect(validityOf({ validFrom: "2026-10-01", validUntil: null }, today)).toBe("upcoming");
    expect(validityOf({ validFrom: "2026-09-13", validUntil: null }, today)).toBe("current");
    expect(validityOf({ validFrom: null, validUntil: "2026-09-12" }, today)).toBe("expired");
    expect(validityOf({ validFrom: null, validUntil: "2026-09-13" }, today)).toBe("current");
  });
});

describe("sizeLabel", () => {
  it("prints the sizes the prototype's cards print", () => {
    expect(sizeLabel(317_440)).toBe("310 KB");
    expect(sizeLabel(2_516_582)).toBe("2.4 MB");
    expect(sizeLabel(8_598_323)).toBe("8.2 MB");
    expect(sizeLabel(40 * 1024 * 1024)).toBe("40 MB");
    expect(sizeLabel(512)).toBe("512 B");
  });

  it("prints nothing rather than '0 B' when the size is unknown", () => {
    expect(sizeLabel(null)).toBe("");
    expect(sizeLabel(undefined)).toBe("");
    expect(sizeLabel(0)).toBe("");
  });

  it("describes the upload cap in the same words the refusal uses", () => {
    expect(sizeLabel(COLLATERAL_MAX_BYTES)).toBe("25 MB");
  });
});

describe("normaliseTags", () => {
  it("folds case and spacing so one idea is one folder", () => {
    expect(normaliseTags(["Pricing", "pricing", "PRICING ", "  holiday  menu "])).toEqual([
      "pricing",
      "holiday menu",
    ]);
  });

  it("drops anything that would not read as a folder, and caps the list", () => {
    expect(normaliseTags(["ok", "", "   ", "no/slashes", "x".repeat(40)])).toEqual(["ok"]);
    expect(normaliseTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(8);
  });

  it("parses what the sheet's one input holds", () => {
    expect(parseTagInput("corporate, fall\npricing")).toEqual(["corporate", "fall", "pricing"]);
    expect(parseTagInput("")).toEqual([]);
  });
});
