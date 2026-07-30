/**
 * The send path. Every case here is a way a real email has gone wrong, or a way
 * the admin/register split could leak the remove button to a whole party.
 *
 * The mint itself is mocked — it has its own 89-case suite. What is under test is
 * WHICH capability each surface asks for, WHICH venue it resolves, and what
 * happens when minting degrades.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WaiverLinkForSend } from "@/lib/waiver-short-link";

const mintWaiverLinkOrLongUrl = vi.hoisted(() => vi.fn());
vi.mock("@/lib/waiver-short-link", () => ({ mintWaiverLinkOrLongUrl }));

import {
  waiverLinkForQuote,
  waiverUrlForQuote,
  waiverLinkForSuppliedUrl,
  _resetWaiverLinkSendCache,
  type WaiverLinkQuote,
} from "./waiver-link-send";

/** A successful mint, shaped like the real one. */
function minted(over: Partial<WaiverLinkForSend> = {}): WaiverLinkForSend {
  return {
    url: "https://headpinz.com/w/AbCdEfGhIjKlMnOp",
    code: "AbCdEfGhIjKlMnOp",
    capability: "admin",
    short: true,
    target: "/waiver?c=fort-myers&loc=332160&pid=51383608",
    failure: null,
    ...over,
  };
}

/** A DEGRADED mint — the long sign-only URL, no code, no capability. */
function degraded(): WaiverLinkForSend {
  return {
    url: "https://headpinz.com/waiver?c=fort-myers&loc=332160&pid=51383608",
    code: null,
    capability: null,
    short: false,
    target: "/waiver?c=fort-myers&loc=332160&pid=51383608",
    failure: "not-persisted",
  };
}

const QUOTE: WaiverLinkQuote = {
  id: 4242,
  center_code: "fort-myers",
  bmi_reservation_id: "51383608",
  base_url: "https://headpinz.com",
};

beforeEach(() => {
  mintWaiverLinkOrLongUrl.mockReset();
  mintWaiverLinkOrLongUrl.mockResolvedValue(minted());
  _resetWaiverLinkSendCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("waiverLinkForQuote", () => {
  it("mints for the quote's own venue, with the STORED brand origin", () => {
    return waiverLinkForQuote(QUOTE, "admin").then(() => {
      expect(mintWaiverLinkOrLongUrl).toHaveBeenCalledWith({
        center: "fort-myers",
        reservation: { locationId: "332160", projectId: "51383608" },
        capability: "admin",
        // From the quote row, never a request origin — a cron has no request, and a
        // brand-less origin would put a HeadPinz guest on the FastTrax host.
        origin: "https://headpinz.com",
      });
    });
  });

  it("sends a FastTrax quote to 467486 and a Naples quote to Naples", async () => {
    await waiverLinkForQuote({ ...QUOTE, center_code: "fasttrax" }, "register");
    expect(mintWaiverLinkOrLongUrl.mock.calls[0][0].reservation.locationId).toBe("467486");

    mintWaiverLinkOrLongUrl.mockClear();
    _resetWaiverLinkSendCache();
    await waiverLinkForQuote({ ...QUOTE, center_code: "naples" }, "register");
    expect(mintWaiverLinkOrLongUrl.mock.calls[0][0]).toMatchObject({
      center: "naples",
      reservation: { locationId: "332145" },
    });
  });

  it("REFUSES an unknown center_code without minting anything", async () => {
    expect(await waiverLinkForQuote({ ...QUOTE, center_code: "sarasota" }, "admin")).toBeNull();
    expect(mintWaiverLinkOrLongUrl).not.toHaveBeenCalled();
  });

  it("refuses a quote with no reservation id", async () => {
    expect(await waiverLinkForQuote({ ...QUOTE, bmi_reservation_id: "  " }, "admin")).toBeNull();
    expect(mintWaiverLinkOrLongUrl).not.toHaveBeenCalled();
  });

  it("keeps a 17-digit BMI id as an exact string", async () => {
    const big = "63000000004542824"; // > Number.MAX_SAFE_INTEGER
    await waiverLinkForQuote({ ...QUOTE, bmi_reservation_id: big }, "admin");
    expect(mintWaiverLinkOrLongUrl.mock.calls[0][0].reservation.projectId).toBe(big);
  });

  it("memoizes a SUCCESS per quote+capability", async () => {
    await waiverLinkForQuote(QUOTE, "admin");
    await waiverLinkForQuote(QUOTE, "admin");
    expect(mintWaiverLinkOrLongUrl).toHaveBeenCalledTimes(1);
  });

  it("never lets admin and register share a cache slot", async () => {
    // If they did, the FIRST caller would decide the capability for the second —
    // i.e. a share box could be handed the admin link.
    mintWaiverLinkOrLongUrl.mockResolvedValueOnce(minted({ capability: "admin", code: "A" }));
    mintWaiverLinkOrLongUrl.mockResolvedValueOnce(minted({ capability: "register", code: "R" }));
    const admin = await waiverLinkForQuote(QUOTE, "admin");
    const register = await waiverLinkForQuote(QUOTE, "register");
    expect(mintWaiverLinkOrLongUrl).toHaveBeenCalledTimes(2);
    expect(admin!.capability).toBe("admin");
    expect(register!.capability).toBe("register");
  });

  it("does NOT cache a degraded mint — it retries", async () => {
    // Caching a degradation would strip the remove button from every remaining
    // email in the batch off one transient Neon blip, silently, for the life of
    // the instance. Minting is idempotent, so retrying costs one upsert.
    mintWaiverLinkOrLongUrl.mockResolvedValueOnce(degraded());
    mintWaiverLinkOrLongUrl.mockResolvedValueOnce(minted());
    expect((await waiverLinkForQuote(QUOTE, "admin"))!.short).toBe(false);
    expect((await waiverLinkForQuote(QUOTE, "admin"))!.short).toBe(true);
    expect(mintWaiverLinkOrLongUrl).toHaveBeenCalledTimes(2);
  });

  it("waiverUrlForQuote is the url, or null when there is no venue", async () => {
    expect(await waiverUrlForQuote(QUOTE, "admin")).toBe(minted().url);
    expect(await waiverUrlForQuote({ ...QUOTE, center_code: "?" }, "admin")).toBeNull();
  });
});

describe("waiverLinkForSuppliedUrl", () => {
  it("upgrades a canonical reservation link and keeps ITS origin", async () => {
    const url = await waiverLinkForSuppliedUrl(
      "https://fasttraxent.com/waiver?c=fort-myers&loc=467486&pid=51383608",
      "admin",
    );
    expect(mintWaiverLinkOrLongUrl).toHaveBeenCalledWith({
      center: "fort-myers",
      reservation: { locationId: "467486", projectId: "51383608" },
      capability: "admin",
      // The caller that built the absolute URL is the one that knew the brand.
      origin: "https://fasttraxent.com",
    });
    expect(url).toBe(minted().url);
  });

  it("carries a 17-digit pid through the query string intact", async () => {
    const big = "63000000004542824";
    await waiverLinkForSuppliedUrl(`/waiver?c=naples&loc=332145&pid=${big}`, "register", {
      origin: "https://headpinz.com",
    });
    expect(mintWaiverLinkOrLongUrl.mock.calls[0][0].reservation.projectId).toBe(big);
  });

  it("replaces a LEGACY kiosk link rather than shipping it", async () => {
    // The whole reason this function inspects the host: a caller still holding a
    // legacy link must not be able to put one in an email.
    for (const legacy of [
      "https://kiosk.sms-timing.com/headpinzftmyers/subscribe",
      "https://kiosk.bmileisure.com/headpinznaples",
      "https://kiosk.sms-timing.com/headpinzftmyers/subscribe/event?id=9931",
    ]) {
      const url = await waiverLinkForSuppliedUrl(legacy, "admin", {
        center: "naples",
        origin: "https://headpinz.com",
      });
      expect(url).toBe("https://headpinz.com/waiver?c=naples");
      expect(url).not.toContain("kiosk.");
    }
    expect(mintWaiverLinkOrLongUrl).not.toHaveBeenCalled();
  });

  it("falls back to the canonical picker when nothing was supplied", async () => {
    for (const empty of ["", "   ", null, undefined]) {
      expect(
        await waiverLinkForSuppliedUrl(empty, "admin", { origin: "https://headpinz.com" }),
      ).toBe("https://headpinz.com/waiver");
    }
    expect(mintWaiverLinkOrLongUrl).not.toHaveBeenCalled();
  });

  it("does not shorten a standalone link — there is no capability to encode", async () => {
    const url = await waiverLinkForSuppliedUrl("/waiver?c=naples", "admin", {
      origin: "https://headpinz.com",
    });
    expect(url).toBe("https://headpinz.com/waiver?c=naples");
    expect(mintWaiverLinkOrLongUrl).not.toHaveBeenCalled();
  });

  it("refuses a HALF-SET pair the same way buildWaiverUrl does", async () => {
    for (const half of ["/waiver?c=naples&loc=332145", "/waiver?c=naples&pid=51383608"]) {
      const url = await waiverLinkForSuppliedUrl(half, "admin", {
        origin: "https://headpinz.com",
      });
      expect(url).toBe("https://headpinz.com/waiver?c=naples");
    }
    expect(mintWaiverLinkOrLongUrl).not.toHaveBeenCalled();
  });

  it("returns a usable URL even when the mint degrades", async () => {
    mintWaiverLinkOrLongUrl.mockResolvedValueOnce(degraded());
    const url = await waiverLinkForSuppliedUrl(
      "https://headpinz.com/waiver?c=fort-myers&loc=332160&pid=51383608",
      "admin",
    );
    // Long, sign-only, absolute — never empty, and never a bare relative path in
    // an inbox.
    expect(url).toBe(degraded().url);
    expect(url.startsWith("https://")).toBe(true);
  });

  it("leaves an unrelated absolute URL alone", async () => {
    const other = "https://headpinz.com/contract/AB12CD";
    expect(await waiverLinkForSuppliedUrl(other, "admin")).toBe(other);
    expect(mintWaiverLinkOrLongUrl).not.toHaveBeenCalled();
  });

  it("never emits the placeholder parse base", async () => {
    const url = await waiverLinkForSuppliedUrl("/waiver?c=naples", "register", {
      origin: "https://headpinz.com",
    });
    expect(url).not.toContain("waiver.invalid");
  });
});
