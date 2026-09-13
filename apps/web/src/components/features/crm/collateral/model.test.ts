import { describe, expect, it } from "vitest";
import type { CollateralItem, MessageTemplate } from "~/features/crm/collateral/contracts";
import {
  ALL_FOLDER,
  collateralCardModel,
  collateralMessage,
  folderOptions,
  folderValue,
  gsm7Offenders,
  isNewCollateral,
  selectionFromFolder,
  selectionFromQuery,
  templatePreview,
} from "./model";

/**
 * Everything the Collateral screen decides, decided here so it can be asserted
 * without a DOM (R12). The cases that matter are the ones a screenshot would
 * not catch: a folder value that round-trips through the URL, an "expired"
 * file that still looks current, and an error code shown to a rep raw.
 */

const ITEM: CollateralItem = {
  id: "2",
  title: "Group Pricing HPFM 2026",
  centre: "HPFM",
  type: "PDF",
  blobUrl: "https://blob.test/pricing.pdf",
  blobPathname: null,
  contentType: "application/pdf",
  sizeBytes: 317_440,
  tags: ["pricing"],
  validFrom: null,
  validUntil: null,
  shares: 88,
  uploadedBy: "kelsea@headpinz.com",
  updatedBy: null,
  archivedAt: null,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
};

const NOW = new Date("2026-09-13T18:00:00.000Z");
const TODAY = "2026-09-13";

describe("folders", () => {
  it("offers All, the three centres by their short names, then the live tags", () => {
    const options = folderOptions([
      { tag: "pricing", n: 3 },
      { tag: "holiday", n: 1 },
    ]);
    expect(options.map((o) => o.label)).toEqual([
      "All",
      "HP Fort Myers",
      "FastTrax",
      "HP Naples",
      "Pricing",
      "Holiday",
    ]);
    expect(options[4]?.badge).toBe(3);
  });

  it("round-trips a selection through its folder value", () => {
    expect(folderValue({ centre: "HPN", tag: null })).toBe("centre:HPN");
    expect(folderValue({ centre: null, tag: "pricing" })).toBe("tag:pricing");
    expect(folderValue({ centre: null, tag: null })).toBe(ALL_FOLDER);

    expect(selectionFromFolder("centre:HPN")).toEqual({ centre: "HPN", tag: null });
    expect(selectionFromFolder("tag:pricing")).toEqual({ centre: null, tag: "pricing" });
    expect(selectionFromFolder(ALL_FOLDER)).toEqual({ centre: null, tag: null });
  });

  it("ignores a centre code the URL invented", () => {
    expect(selectionFromFolder("centre:HPXX")).toEqual({ centre: null, tag: null });
    expect(selectionFromQuery({ centre: "nope", tag: "pricing" })).toEqual({
      centre: null,
      tag: "pricing",
    });
    expect(selectionFromQuery({ centre: "FT" })).toEqual({ centre: "FT", tag: null });
  });
});

describe("collateralCardModel", () => {
  it("prints the prototype's meta line, with its date format and not core's", () => {
    // crm-shared.js:72 `fDateY` is "Sep 1, 2026"; core's adds a weekday.
    expect(collateralCardModel(ITEM, TODAY, NOW).meta).toBe(
      "HPFM · PDF · 310 KB · updated Sep 1, 2026",
    );
    expect(collateralCardModel(ITEM, TODAY, NOW).meta).not.toContain("Tue");
  });

  it("says All for a file every centre shares, and drops an unknown size", () => {
    const model = collateralCardModel({ ...ITEM, centre: null, sizeBytes: null }, TODAY, NOW);
    expect(model.meta).toBe("All · PDF · updated Sep 1, 2026");
  });

  it("labels a season a rep must not send yet, and one that has passed", () => {
    expect(collateralCardModel({ ...ITEM, validUntil: "2026-09-01" }, TODAY, NOW)).toMatchObject({
      validity: "expired",
      validityLabel: "Expired Sep 1, 2026",
    });
    expect(collateralCardModel({ ...ITEM, validFrom: "2026-11-01" }, TODAY, NOW)).toMatchObject({
      validity: "upcoming",
      validityLabel: "From Nov 1, 2026",
    });
    expect(collateralCardModel(ITEM, TODAY, NOW).validityLabel).toBeNull();
  });

  it("counts shares in words, and flags a recent upload as New", () => {
    expect(collateralCardModel(ITEM, TODAY, NOW).sharesLabel).toBe("88 shares");
    expect(collateralCardModel({ ...ITEM, shares: 1 }, TODAY, NOW).sharesLabel).toBe("1 share");

    expect(isNewCollateral({ ...ITEM, createdAt: "2026-09-10T12:00:00.000Z" }, NOW)).toBe(true);
    expect(isNewCollateral({ ...ITEM, createdAt: "2026-07-10T12:00:00.000Z" }, NOW)).toBe(false);
    expect(isNewCollateral({ ...ITEM, createdAt: "not a date" }, NOW)).toBe(false);
  });
});

describe("templates", () => {
  const sms: MessageTemplate = {
    id: "2",
    kind: "sms",
    name: "Quote nudge (48 h)",
    subject: null,
    body: "Hi {{guest.first}} — checking in on the {{event.date}} quote.",
    mergeFields: ["guest.first", "event.date"],
    centre: null,
    position: 2,
    updatedBy: "seed",
    archivedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    gsm7: { ok: false, offending: "—" },
  };

  it("previews subject then body, truncated", () => {
    expect(templatePreview({ ...sms, subject: "RE: Quote" }, 10)).toBe("RE: Quote — Hi {{guest…");
    expect(templatePreview(sms, 200)).toBe(sms.body);
  });

  it("lists the SMS templates that would cost double, and no email ones", () => {
    const email: MessageTemplate = { ...sms, id: "4", kind: "email", gsm7: null };
    expect(gsm7Offenders([sms, email]).map((t) => t.id)).toEqual(["2"]);
    expect(gsm7Offenders([{ ...sms, gsm7: { ok: true, offending: null } }])).toEqual([]);
  });
});

describe("collateralMessage", () => {
  it("turns a server code into a sentence, including the zod prefix form", () => {
    expect(collateralMessage("blob_not_configured")).toContain("paste the file's public link");
    expect(collateralMessage("file_too_big")).toContain("25 MB");
    expect(collateralMessage('not_gsm7: "—" is not GSM-7 — texts with it cost double')).toBe(
      'not_gsm7: "—" is not GSM-7 — texts with it cost double',
    );
  });

  it("shows an unmapped message as the server wrote it", () => {
    expect(collateralMessage("unexpected")).toBe("unexpected");
  });
});
