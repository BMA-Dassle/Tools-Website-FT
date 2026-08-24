import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOGO_MARK_KEYS, DEFAULT_LOGO_MARK, isLogoMark, resolveLogoMark, logoAsset } from "./logo";
import { resolveScreenConfig, rolePreset } from "./defaults";
import { isSceneImplemented, sceneHasData } from "./scenes/registry";

/**
 * Where a mark's `src` really lives on disk.
 *
 * Anchored to THIS FILE, not to `process.cwd()`. Both spellings pass when vitest
 * is invoked from `apps/web`, and only this one passes when it is invoked from the
 * repo root — which is how the workspace-wide run does it, so the cwd version was
 * a test that reported green exactly where it was not being asked the question.
 */
const assetPath = (src: string) => fileURLToPath(new URL(`../../../public${src}`, import.meta.url));

/**
 * Pixel size and alpha, read out of a WebP's own RIFF header. Hand-rolled rather
 * than pulled from sharp: this needs to run in the unit suite on any machine, and
 * the three container shapes are a dozen lines between them.
 *
 * Returns null for a format this does not parse, so a future PNG or SVG mark
 * skips the check instead of failing it for the wrong reason.
 */
function webpHeader(file: Buffer): { width: number; height: number; hasAlpha: boolean } | null {
  if (file.subarray(0, 4).toString("ascii") !== "RIFF") return null;
  if (file.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const chunk = file.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    // Extended format: 24-bit canvas width-1 / height-1 at byte 24, alpha flag in
    // the feature byte at 20.
    return {
      width: (file[24] | (file[25] << 8) | (file[26] << 16)) + 1,
      height: (file[27] | (file[28] << 8) | (file[29] << 16)) + 1,
      hasAlpha: (file[20] & 0x10) !== 0,
    };
  }
  if (chunk === "VP8L") {
    // Lossless: 14-bit width-1 then 14-bit height-1, packed little-endian from
    // byte 21, with the alpha_is_used bit just above them.
    const bits = file.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      hasAlpha: ((bits >> 28) & 1) !== 0,
    };
  }
  if (chunk === "VP8 ") {
    // Simple lossy: 14-bit dimensions after the 3-byte start code. Never carries
    // alpha — that is what the VP8X container is for.
    return {
      width: file.readUInt16LE(26) & 0x3fff,
      height: file.readUInt16LE(28) & 0x3fff,
      hasAlpha: false,
    };
  }
  return null;
}

describe("logo marks", () => {
  it("has at least one mark, and the default is one of them", () => {
    expect(LOGO_MARK_KEYS.length).toBeGreaterThan(0);
    expect(LOGO_MARK_KEYS).toContain(DEFAULT_LOGO_MARK);
    expect(isLogoMark(DEFAULT_LOGO_MARK)).toBe(true);
  });

  it("EVERY mark's file actually exists in public/", () => {
    // The whole content of a logo screen is this one file. A row pointing at a
    // path nobody shipped would render a broken image on a wall, and nothing in
    // the type system catches a wrong string inside a string.
    for (const mark of LOGO_MARK_KEYS) {
      const asset = logoAsset(mark);
      const path = assetPath(asset.src);
      expect(existsSync(path), `${mark}: missing ${asset.src}`).toBe(true);
      expect(statSync(path).size, `${mark}: ${asset.src} is empty`).toBeGreaterThan(0);
    }
  });

  it("every mark declares the size the FILE really is", () => {
    // The declared dimensions are the aspect ratio the scene scales by, so a wrong
    // pair silently stretches the artwork on a wall. Read out of the file's own
    // header rather than trusted — this is exactly the kind of number that stays
    // right until someone swaps the asset and forgets the row.
    for (const mark of LOGO_MARK_KEYS) {
      const asset = logoAsset(mark);
      expect(asset.width, `${mark}: width`).toBeGreaterThan(0);
      expect(asset.height, `${mark}: height`).toBeGreaterThan(0);
      const header = webpHeader(readFileSync(assetPath(asset.src)));
      if (!header) continue; // not a webp — nothing to cross-check
      expect(header.width, `${mark}: declared width vs file`).toBe(asset.width);
      expect(header.height, `${mark}: declared height vs file`).toBe(asset.height);
    }
  });

  it("every mark's file really has an alpha channel", () => {
    // The transparent surround is why the mark sits on black rather than inside a
    // white box. A flattened re-export would look fine in a picture viewer and
    // wrong on the wall, and `ground: "light"` alone cannot catch that.
    for (const mark of LOGO_MARK_KEYS) {
      const header = webpHeader(readFileSync(assetPath(logoAsset(mark).src)));
      if (!header) continue;
      expect(header.hasAlpha, `${mark}: asset has no alpha channel`).toBe(true);
    }
  });

  it("every mark carries its own light field, so it reads on black", () => {
    // A mark that is dark ink on transparency would be INVISIBLE on this scene's
    // black background. `ground` exists to make the next person adding a row
    // answer that question deliberately instead of finding out on a TV.
    for (const mark of LOGO_MARK_KEYS) {
      expect(logoAsset(mark).ground, `${mark} must be usable on black`).toBe("light");
    }
  });

  it("resolves anything unrecognisable to the default rather than to nothing", () => {
    // THE CONFIG_VERSION CONTRACT. A screen whose only content is one image must
    // never go black over a typo in a text field, a mark from a newer deploy, or a
    // hand-edited JSONB blob.
    expect(resolveLogoMark(undefined)).toBe(DEFAULT_LOGO_MARK);
    expect(resolveLogoMark(null)).toBe(DEFAULT_LOGO_MARK);
    expect(resolveLogoMark("")).toBe(DEFAULT_LOGO_MARK);
    expect(resolveLogoMark("PinBoyz")).toBe(DEFAULT_LOGO_MARK); // wrong case
    expect(resolveLogoMark("pinboys")).toBe(DEFAULT_LOGO_MARK); // typo
    expect(resolveLogoMark("a-mark-from-2027")).toBe(DEFAULT_LOGO_MARK);
    expect(resolveLogoMark(42)).toBe(DEFAULT_LOGO_MARK);
    expect(resolveLogoMark({ mark: "pinboyz" })).toBe(DEFAULT_LOGO_MARK);
  });

  it("keeps a mark it does recognise", () => {
    for (const mark of LOGO_MARK_KEYS) expect(resolveLogoMark(mark)).toBe(mark);
  });

  it("is not fooled by inherited Object properties", () => {
    // `"toString" in LOGO_MARKS` is true on a plain object literal, which would
    // make `LOGO_MARKS["toString"]` a function masquerading as an asset.
    expect(isLogoMark("toString")).toBe(false);
    expect(isLogoMark("constructor")).toBe(false);
    expect(isLogoMark("__proto__")).toBe(false);
    expect(resolveLogoMark("toString")).toBe(DEFAULT_LOGO_MARK);
  });
});

describe("venue-logo screens", () => {
  it("resolves a mark for EVERY screen, so the scene never branches on absence", () => {
    // Unlike briefingRoom / cameraMonitor / resultsBoard, this one is never null:
    // there is a safe guess for a logo, so there is no setup-notice state.
    expect(resolveScreenConfig(null, "HPFM").venueLogo.mark).toBe(DEFAULT_LOGO_MARK);
    expect(resolveScreenConfig({}, "HPFM").venueLogo.mark).toBe(DEFAULT_LOGO_MARK);
    expect(resolveScreenConfig({ venueLogo: { mark: "nope" } }, "HPFM").venueLogo.mark).toBe(
      DEFAULT_LOGO_MARK,
    );
    expect(resolveScreenConfig({ venueLogo: { mark: "pinboyz" } }, "HPFM").venueLogo.mark).toBe(
      "pinboyz",
    );
  });

  it("the logo-only preset shows the logo ALONE, with nothing interrupting it", () => {
    const c = rolePreset("logo-only").config;
    const playlist = c.playlist ?? [];
    expect(playlist).toHaveLength(1);
    expect(playlist[0].scene).toBe("venue-logo");
    // No data gate: the sole entry being gated would resolve to an empty playlist,
    // which sanitizePlaylist replaces with house ads — the opposite of the point.
    expect(playlist[0].requiresData).toBeUndefined();
    // Confetti from a kiosk on the far side of the building has no story here.
    for (const key of ["vip-welcome", "celebration", "billboard-crown"] as const) {
      expect(c.interrupts?.[key]?.enabled, `${key} must be off`).toBe(false);
    }
    // The preset names a mark, so the role is complete the moment it is picked.
    expect(resolveLogoMark(c.venueLogo?.mark)).toBe(c.venueLogo?.mark);
  });

  it("an empty playlist still resolves to something, and it is never venue-logo by accident", () => {
    // The floor for a config we cannot read is house ads, not a holding card — a
    // logo screen is a deliberate choice, never a fallback.
    expect(resolveScreenConfig({ playlist: [] }, "HPFM").playlist[0].scene).toBe("ads");
  });

  it("is IMPLEMENTED, so the scheduler will actually select it", () => {
    // The billboard-crown lesson: a scene the scheduler picks but the switch does
    // not render paints house ads for a third of every cycle with nothing to
    // explain it. A logo screen has ONE entry, so getting this wrong would mean
    // the screen shows ads and never the logo at all.
    expect(isSceneImplemented("venue-logo")).toBe(true);
  });

  it("never reports itself as empty, whatever the feed is doing", () => {
    expect(sceneHasData("venue-logo", null)).toBe(true);
  });
});
