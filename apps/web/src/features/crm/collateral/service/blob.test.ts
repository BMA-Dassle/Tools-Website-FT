import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLOB_TOKEN_ENV,
  COLLATERAL_BLOB_PREFIX,
  CollateralUploadError,
  UPLOAD_ERRORS,
  blobConfigured,
  blobPathFor,
  deleteCollateralFile,
  uploadCollateralFile,
  type BlobPutDeps,
} from "./blob";

/**
 * The Blob rail, driven through its injection points rather than against a
 * real store. What is pinned here is ORDER and SAFETY, because both are
 * invisible once they drift:
 *
 *   token checked first    a deployment with no store must refuse BEFORE the
 *                          25 MB body is read; reversing these two lines
 *                          buffers a file only to throw it away;
 *   size before type       the cheap check first, again so nothing large is
 *                          read to be refused;
 *   path sanitised         a filename is guest-adjacent input and must never
 *                          steer an object key — no slashes, no `..`, no
 *                          spaces, no unicode;
 *   delete never throws    it runs inside a failure path that already has an
 *                          answer for the rep; a second throw there would turn
 *                          a handled error into a 500.
 */

const TOKEN = "vercel_blob_rw_TESTTOKEN";

function file(name: string, size: number, type = "application/pdf"): File {
  return {
    name,
    size,
    type,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as File;
}

function putDeps(over: Partial<BlobPutDeps> = {}): { deps: BlobPutDeps; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const deps: BlobPutDeps = {
    put: (async (path: string, body: unknown, opts: unknown) => {
      calls.push([path, body, opts]);
      return {
        url: `https://blob.test/${path}`,
        pathname: path,
        contentType: "application/pdf",
      };
    }) as unknown as BlobPutDeps["put"],
    now: () => new Date("2026-09-13T18:00:00.000Z"),
    ...over,
  };
  return { deps, calls };
}

beforeEach(() => {
  process.env[BLOB_TOKEN_ENV] = TOKEN;
});

afterEach(() => {
  delete process.env[BLOB_TOKEN_ENV];
  vi.restoreAllMocks();
});

describe("blobConfigured", () => {
  it("reads the token by NAME, per call, so setting it takes effect without a deploy", () => {
    expect(blobConfigured()).toBe(true);
    delete process.env[BLOB_TOKEN_ENV];
    expect(blobConfigured()).toBe(false);
  });
});

describe("blobPathFor", () => {
  it("keeps the day, the extension and a slug of the name", () => {
    expect(blobPathFor("Group Pricing 2026.pdf", new Date("2026-09-13T18:00:00.000Z"))).toBe(
      `${COLLATERAL_BLOB_PREFIX}2026-09-13/group-pricing-2026.pdf`,
    );
  });

  it("lets nothing in a filename steer the path", () => {
    const path = blobPathFor("../../etc/pa ss wd.pdf", new Date("2026-09-13T00:00:00.000Z"));
    expect(path).toBe(`${COLLATERAL_BLOB_PREFIX}2026-09-13/pa-ss-wd.pdf`);
    expect(path.startsWith(COLLATERAL_BLOB_PREFIX)).toBe(true);
    expect(path).not.toContain("..");
  });

  it("still produces a key for a name with nothing usable in it", () => {
    expect(blobPathFor("$$$.pdf", new Date("2026-09-13T00:00:00.000Z"))).toBe(
      `${COLLATERAL_BLOB_PREFIX}2026-09-13/file.pdf`,
    );
  });

  /**
   * Observed, and deliberate: `extensionOf` strips everything from the first
   * `?` or `#` because it also reads URLs (`collateralTypeFromUrl`). A LOCAL
   * file called "Pricing #2.pdf" therefore looks extension-less and the upload
   * is refused as an unsupported kind rather than stored under a wrong name.
   * A refusal a director can fix by renaming beats a mis-typed object.
   */
  it("treats a # in a name as a URL fragment, so such a file is refused, not mis-stored", async () => {
    expect(blobPathFor("Pricing #2.pdf", new Date("2026-09-13T00:00:00.000Z"))).toBe(
      `${COLLATERAL_BLOB_PREFIX}2026-09-13/pricing-2`,
    );
    await expect(
      uploadCollateralFile(file("Pricing #2.pdf", 900), putDeps().deps),
    ).rejects.toMatchObject({ code: UPLOAD_ERRORS.badType });
  });
});

describe("uploadCollateralFile", () => {
  it("refuses with blob_not_configured BEFORE it looks at the file", async () => {
    delete process.env[BLOB_TOKEN_ENV];
    const { deps, calls } = putDeps();
    await expect(uploadCollateralFile(file("x.pdf", 10), deps)).rejects.toMatchObject({
      code: UPLOAD_ERRORS.notConfigured,
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses no file at all", async () => {
    const { deps } = putDeps();
    await expect(uploadCollateralFile(null, deps)).rejects.toMatchObject({
      code: UPLOAD_ERRORS.noFile,
    });
  });

  it("refuses an oversize file before it considers the extension", async () => {
    const { deps, calls } = putDeps();
    await expect(
      uploadCollateralFile(file("huge.exe", 40 * 1024 * 1024), deps),
    ).rejects.toMatchObject({ code: UPLOAD_ERRORS.tooBig });
    expect(calls).toHaveLength(0);
  });

  it("refuses a kind we will not serve to a guest", async () => {
    const { deps, calls } = putDeps();
    await expect(uploadCollateralFile(file("page.html", 200), deps)).rejects.toMatchObject({
      code: UPLOAD_ERRORS.badType,
    });
    expect(calls).toHaveLength(0);
  });

  it("stores it public, with a random suffix, and reports what the row needs", async () => {
    const { deps, calls } = putDeps();
    const out = await uploadCollateralFile(file("Pricing.pdf", 317_440), deps);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(`${COLLATERAL_BLOB_PREFIX}2026-09-13/pricing.pdf`);
    expect(calls[0][2]).toMatchObject({ access: "public", addRandomSuffix: true });
    expect(out).toMatchObject({
      pathname: `${COLLATERAL_BLOB_PREFIX}2026-09-13/pricing.pdf`,
      contentType: "application/pdf",
      sizeBytes: 317_440,
      type: "PDF",
    });
  });

  it("throws a CollateralUploadError the route can map to a status", async () => {
    const { deps } = putDeps();
    const err = await uploadCollateralFile(null, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CollateralUploadError);
  });
});

describe("deleteCollateralFile", () => {
  it("removes the object the insert never referenced", async () => {
    const seen: string[] = [];
    const ok = await deleteCollateralFile("https://blob.test/x.pdf", {
      del: (async (url: string) => {
        seen.push(url);
      }) as never,
    });
    expect(ok).toBe(true);
    expect(seen).toEqual(["https://blob.test/x.pdf"]);
  });

  it("never throws when the delete fails — it only logs the orphan", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = await deleteCollateralFile("https://blob.test/x.pdf", {
      del: (async () => {
        throw new Error("blob store unreachable");
      }) as never,
    });
    expect(ok).toBe(false);
    expect(logged).toHaveBeenCalled();
  });

  it("does nothing without a URL or without a token", async () => {
    let called = 0;
    const del = (async () => {
      called += 1;
    }) as never;
    expect(await deleteCollateralFile("", { del })).toBe(false);
    delete process.env[BLOB_TOKEN_ENV];
    expect(await deleteCollateralFile("https://blob.test/x.pdf", { del })).toBe(false);
    expect(called).toBe(0);
  });
});
