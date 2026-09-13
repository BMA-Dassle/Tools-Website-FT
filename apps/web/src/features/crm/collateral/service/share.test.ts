import { describe, expect, it, vi } from "vitest";
import { CRM_SHARE_PATH } from "../contracts";
import type { CollateralItem } from "../contracts";
import {
  DEFAULT_SHARE_DAYS,
  MAX_SHARE_DAYS,
  SHARE_TOKEN_RE,
  createShare,
  expiresAtFor,
  isShareExpired,
  mintShareToken,
  openKeyFor,
  openShare,
  sharePathFor,
  shareUrlFor,
  type ShareDeps,
} from "./share";

/**
 * A share link is a URL that lives in someone's text messages for months. Each
 * case here is a way that has gone wrong for a capability link in this repo
 * before (see `lib/waiver-short-link.test.ts` for the waiver version):
 *
 *   the path moves        a link already delivered stops working, silently,
 *                         and nobody can report it because it is in a phone;
 *   guessable token       a forwarded link becomes "every flyer we have";
 *   the guest path writes DDL — one failing CREATE TABLE and every outstanding
 *                         link in every inbox dies at once;
 *   an expired link 200s  last season's pricing keeps being served;
 *   opens double-count    a mail client's pre-fetch turns "12 opens" into
 *                         fiction, and the number stops being worth showing;
 *   the URL is per-host   a link copied on a preview carries a *.vercel.app
 *                         host behind Vercel Authentication, so the guest
 *                         meets a Vercel login instead of a flyer.
 */

const ITEM: CollateralItem = {
  id: "7",
  title: "Group Pricing HPFM 2026",
  centre: "HPFM",
  type: "PDF",
  blobUrl: "https://blob.example.com/crm/collateral/2026-09-13/group-pricing-abc.pdf",
  blobPathname: "crm/collateral/2026-09-13/group-pricing-abc.pdf",
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

function deps(over: Partial<ShareDeps> = {}) {
  const inserted: unknown[] = [];
  const activities: unknown[] = [];
  const bumped: string[] = [];
  const base: ShareDeps = {
    getCollateral: async () => ITEM,
    findShareLead: async (value) =>
      value === "L-1042" ? { id: "1042", publicId: "L-1042", label: "L-1042" } : null,
    insertShareLink: async (input) => {
      inserted.push(input);
      return {
        token: input.token,
        collateral_id: input.collateralId,
        lead_id: input.leadId,
        contact_id: input.contactId,
        rep_id: input.repId,
        channel: input.channel,
        opened_at: null,
        last_opened_at: null,
        open_count: 0,
        expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
        expired_at: null,
        created_by: input.createdBy,
        created_at: NOW.toISOString(),
      };
    },
    bumpCollateralShares: async (id) => {
      bumped.push(id);
    },
    recordActivity: async (a) => {
      activities.push(a);
    },
    ...over,
  };
  return { d: base, inserted, activities, bumped };
}

describe("CRM_SHARE_PATH", () => {
  it("is /api/crm/share/ and nothing else — links already sent depend on it", () => {
    expect(CRM_SHARE_PATH).toBe("/api/crm/share/");
    expect(sharePathFor("abc123")).toBe("/api/crm/share/abc123");
  });

  it("is NOT a top-level segment: /s is the booking confirmation link's", () => {
    expect(CRM_SHARE_PATH.startsWith("/api/")).toBe(true);
    expect(CRM_SHARE_PATH.startsWith("/s/")).toBe(false);
  });

  it("builds a production URL regardless of the host the rep is on", () => {
    expect(shareUrlFor("abc123")).toBe("https://headpinz.com/api/crm/share/abc123");
    expect(shareUrlFor("abc123")).not.toContain("vercel.app");
  });

  it("percent-encodes a token rather than splicing it into the path raw", () => {
    expect(sharePathFor("a/b")).toBe("/api/crm/share/a%2Fb");
  });
});

describe("mintShareToken", () => {
  it("mints 128 bits of base64url, never twice the same", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => mintShareToken()));
    expect(tokens.size).toBe(500);
    for (const t of tokens) {
      expect(t).toMatch(SHARE_TOKEN_RE);
      expect(t.length).toBeGreaterThanOrEqual(22);
    }
  });
});

describe("expiresAtFor", () => {
  it("defaults to 30 days and clamps to a year", () => {
    expect(DEFAULT_SHARE_DAYS).toBe(30);
    expect(expiresAtFor(DEFAULT_SHARE_DAYS, NOW).toISOString()).toBe("2026-10-13T18:00:00.000Z");
    expect(expiresAtFor(0, NOW).toISOString()).toBe("2026-09-14T18:00:00.000Z");
    expect(expiresAtFor(9999, NOW).getTime()).toBe(expiresAtFor(MAX_SHARE_DAYS, NOW).getTime());
  });
});

describe("createShare", () => {
  it("writes Neon FIRST, bumps the counter, files the timeline row, then hands back the URL", async () => {
    const { d, inserted, activities, bumped } = deps();

    const out = await createShare(
      {
        collateralId: "7",
        lead: "L-1042",
        repId: "3",
        actorEmail: "kelsea@headpinz.com",
        now: NOW,
      },
      d,
    );

    expect(inserted).toHaveLength(1);
    expect(bumped).toEqual(["7"]);
    expect(out.lead?.publicId).toBe("L-1042");
    expect(out.share.leadId).toBe("1042");
    expect(out.share.createdBy).toBe("kelsea@headpinz.com");
    expect(out.share.url).toBe(`https://headpinz.com/api/crm/share/${out.share.token}`);

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      leadId: "1042",
      repId: "3",
      actorEmail: "kelsea@headpinz.com",
      subject: "Shared Group Pricing HPFM 2026",
      externalRef: out.share.token,
    });
  });

  it("refuses a file that does not exist, or one a director archived", async () => {
    const missing = deps({ getCollateral: async () => null });
    await expect(
      createShare({ collateralId: "9", actorEmail: "eric@headpinz.com" }, missing.d),
    ).rejects.toMatchObject({ code: "collateral_not_found" });

    const gone = deps({ getCollateral: async () => ({ ...ITEM, archivedAt: NOW.toISOString() }) });
    await expect(
      createShare({ collateralId: "7", actorEmail: "eric@headpinz.com" }, gone.d),
    ).rejects.toMatchObject({ code: "collateral_archived" });
    expect(gone.inserted).toHaveLength(0);
  });

  it("still returns the link when the timeline write fails — the rep has already been given it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d } = deps({
      recordActivity: async () => {
        throw new Error("neon down");
      },
    });

    const out = await createShare(
      { collateralId: "7", actorEmail: "kelsea@headpinz.com", now: NOW },
      d,
    );

    expect(out.share.url).toContain("/api/crm/share/");
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls[0])).toContain("kelsea@headpinz.com");
    error.mockRestore();
  });

  it("shares without a lead when none was named", async () => {
    const { d, activities } = deps();
    const out = await createShare({ collateralId: "7", actorEmail: "lori@headpinz.com" }, d);
    expect(out.lead).toBeNull();
    expect(out.share.leadId).toBeNull();
    expect(activities[0]).toMatchObject({ leadId: null });
  });
});

describe("isShareExpired", () => {
  it("is gone when revoked, when the file is archived, or when the date has passed", () => {
    const live = {
      expired_at: null,
      expires_at: "2026-10-13T18:00:00.000Z",
      collateral_archived_at: null,
    };
    expect(isShareExpired(live, NOW)).toBe(false);
    expect(isShareExpired({ ...live, expired_at: "2026-09-12T00:00:00.000Z" }, NOW)).toBe(true);
    expect(
      isShareExpired({ ...live, collateral_archived_at: "2026-09-12T00:00:00.000Z" }, NOW),
    ).toBe(true);
    expect(isShareExpired({ ...live, expires_at: "2026-09-13T17:59:59.000Z" }, NOW)).toBe(true);
  });

  it("never expires a link with no expiry date", () => {
    expect(
      isShareExpired({ expired_at: null, expires_at: null, collateral_archived_at: null }, NOW),
    ).toBe(false);
  });
});

describe("openKeyFor", () => {
  it("is the same for one viewer within a minute and different across minutes", () => {
    const a = openKeyFor({ token: "t", ip: "1.2.3.4", userAgent: "iPhone", now: NOW });
    const again = openKeyFor({
      token: "t",
      ip: "1.2.3.4",
      userAgent: "iPhone",
      now: new Date(NOW.getTime() + 20_000),
    });
    const laterMinute = openKeyFor({
      token: "t",
      ip: "1.2.3.4",
      userAgent: "iPhone",
      now: new Date(NOW.getTime() + 61_000),
    });
    const otherViewer = openKeyFor({ token: "t", ip: "5.6.7.8", userAgent: "iPhone", now: NOW });

    expect(again).toBe(a);
    expect(laterMinute).not.toBe(a);
    expect(otherViewer).not.toBe(a);
  });

  it("stores a hash, not the viewer", () => {
    const key = openKeyFor({ token: "t", ip: "1.2.3.4", userAgent: "iPhone", now: NOW });
    expect(key).not.toContain("1.2.3.4");
    expect(key).not.toContain("iPhone");
    expect(key).toHaveLength(32);
  });
});

describe("openShare", () => {
  const row = {
    token: "tok",
    collateral_id: "7",
    lead_id: null,
    contact_id: null,
    rep_id: null,
    channel: "link",
    opened_at: null,
    last_opened_at: null,
    open_count: 0,
    expires_at: "2026-10-13T18:00:00.000Z",
    expired_at: null,
    created_by: "kelsea@headpinz.com",
    created_at: "2026-09-13T18:00:00.000Z",
    last_open_key: null,
    blob_url: ITEM.blobUrl,
    title: ITEM.title,
    collateral_archived_at: null,
  };
  const token = "a".repeat(22);

  it("records the open and redirects to the blob URL", async () => {
    const recorded: [string, string][] = [];
    const out = await openShare(
      token,
      { ip: "1.2.3.4", userAgent: "iPhone", now: NOW },
      {
        getShareLinkForOpen: async () => row,
        recordShareOpen: async (t, k) => {
          recorded.push([t, k]);
          return 1;
        },
      },
    );

    expect(out).toEqual({ kind: "redirect", url: ITEM.blobUrl, title: ITEM.title, openCount: 1 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0][0]).toBe(token);
  });

  it("answers 'gone' for an expired link and records NO open", async () => {
    let recorded = 0;
    const out = await openShare(
      token,
      { ip: null, userAgent: null, now: NOW },
      {
        getShareLinkForOpen: async () => ({ ...row, expires_at: "2026-09-01T00:00:00.000Z" }),
        recordShareOpen: async () => {
          recorded += 1;
          return 1;
        },
      },
    );
    expect(out).toEqual({ kind: "gone" });
    expect(recorded).toBe(0);
  });

  it("answers 'not found' for an unknown token, and never queries a malformed one", async () => {
    let queries = 0;
    const store = {
      getShareLinkForOpen: async () => {
        queries += 1;
        return null;
      },
      recordShareOpen: async () => 0,
    };

    expect(await openShare("../../etc/passwd", { ip: null, userAgent: null }, store)).toEqual({
      kind: "not_found",
    });
    expect(queries).toBe(0);

    expect(await openShare(token, { ip: null, userAgent: null }, store)).toEqual({
      kind: "not_found",
    });
    expect(queries).toBe(1);
  });
});
