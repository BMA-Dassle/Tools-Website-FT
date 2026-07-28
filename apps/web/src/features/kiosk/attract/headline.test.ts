/**
 * Headline attract layout — data-shape guarantees.
 *
 * These are the invariants the SCREEN cannot check for itself: the renderer
 * happily paints a missing headline as an empty 150px line, and a bad video key
 * would only surface as a silent black backdrop on a kiosk nobody is watching.
 */
import { describe, expect, it } from "vitest";
import { kioskAdSlidesFor, KIOSK_VIDEOS } from "../assets";
import { formatMessage } from "../i18n/format";
import { fallbackMessage } from "../i18n/messages";
import { parseKioskConfigFromSearchParams, resolveKioskConfig } from "../config";
import { BILLBOARD_SLIDES, bankSize, billboardPhase } from "./billboard";

const VENUES = ["fort-myers", "naples"] as const;

describe("ad slides carry everything the headline layout needs", () => {
  for (const center of VENUES) {
    it(`${center}: every slide has a translated headline`, () => {
      const slides = kioskAdSlidesFor(center);
      expect(slides.length).toBeGreaterThan(0);
      for (const s of slides) {
        expect(s.headline, `slide "${s.title}" is missing a headline key`).toBeTruthy();
        // Resolve through the real lookup, not the raw catalogs: a TYPO in the
        // slide still type-checks (MessageKey is wide) but would render the key
        // itself at 150px on a kiosk. Both locales must produce real copy.
        const enCopy = fallbackMessage(s.headline);
        const esCopy = formatMessage("es", s.headline);
        expect(enCopy, `no EN copy for ${s.headline}`).toBeTruthy();
        expect(enCopy, `${s.headline} rendered as its own key`).not.toBe(s.headline);
        expect(esCopy, `no ES copy for ${s.headline}`).toBeTruthy();
        expect(esCopy, `${s.headline} is untranslated`).not.toBe(enCopy);
      }
    });

    it(`${center}: every declared video key resolves to a real clip`, () => {
      for (const s of kioskAdSlidesFor(center)) {
        if (!s.video) continue; // a still slide is a supported mix
        expect(KIOSK_VIDEOS[s.video], `no clip for "${s.video}"`).toMatch(/^https:\/\/.+\.mp4$/);
      }
    });

    it(`${center}: a vehicle only rides a slide whose activity it belongs to`, () => {
      for (const s of kioskAdSlidesFor(center)) {
        if (s.vehicle === "car") expect(s.title.toLowerCase()).toMatch(/rac|mega/);
        if (s.vehicle === "ball") expect(s.title.toLowerCase()).toMatch(/bowl/);
      }
    });
  }

  it("gel blasters stay a still until the Nexus montage is on the blob", () => {
    // Guards the note in KIOSK_VIDEOS: when the clip IS uploaded this test
    // fails, which is the reminder to add the key rather than a silent gap.
    const gel = kioskAdSlidesFor("fort-myers").find((s) => s.title.startsWith("Gel"));
    expect(gel?.video).toBeUndefined();
  });
});

describe("attract layout is per-device and defaults to headline", () => {
  it("a config that predates the field backfills to the new layout", () => {
    const resolved = resolveKioskConfig({ center: "fort-myers", brand: "fasttrax" });
    expect(resolved?.attractLayout).toBe("headline");
  });

  it("?attract=adzone puts a single kiosk back without a redeploy", () => {
    const parsed = parseKioskConfigFromSearchParams({ center: "FT", attract: "adzone" });
    expect(parsed.attractLayout).toBe("adzone");
    expect(resolveKioskConfig(parsed)?.attractLayout).toBe("adzone");
  });

  it("an unknown value is ignored rather than blanking the screen", () => {
    expect(parseKioskConfigFromSearchParams({ attract: "banana" }).attractLayout).toBeUndefined();
  });
});

describe("billboard drives the headline for its window, then hands back", () => {
  // The integration replaces an overlay: whatever the phase says, the screen
  // renders ONE headline. These pin the phase boundaries the renderer keys off.
  const count = bankSize("HPFM");

  it("HPFM has a slide for every screen in the bank", () => {
    expect(BILLBOARD_SLIDES.HPFM.length).toBe(count);
  });

  it("each screen lights a second after the one to its left", () => {
    for (let p = 0; p < count; p++) {
      expect(billboardPhase(p * 1000, p, count)).toBe("activity");
      if (p > 0) expect(billboardPhase(p * 1000 - 1, p, count)).toBe("idle");
    }
  });

  it("the whole bank shares the finale, then everything returns to idle", () => {
    const finaleStart = count * 1000 + 2200;
    for (let p = 0; p < count; p++) {
      expect(billboardPhase(finaleStart, p, count)).toBe("finale");
      expect(billboardPhase(finaleStart + 3799, p, count)).toBe("finale");
      expect(billboardPhase(finaleStart + 3800, p, count)).toBe("idle");
    }
  });

  it("FastTrax has no billboard content, so its screens never leave idle", () => {
    expect(BILLBOARD_SLIDES.FT).toHaveLength(0);
  });
});
