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
import {
  BILLBOARD_LEAD_MS,
  BILLBOARD_SLIDES,
  bankSize,
  billboardPhase,
  billboardStage,
} from "./billboard";
import { AD_ROTATE_MS, slidePlaysVideo, vehiclePhaseMs } from "./rotation";

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

  it("every slide at both venues now runs a clip", () => {
    // The whole rotation is video; a slide silently losing one would drop that
    // activity back to a still while its neighbours move, which reads as broken
    // rather than as a deliberate mix.
    for (const center of VENUES) {
      for (const s of kioskAdSlidesFor(center)) {
        expect(s.video, `slide "${s.title}" (${center}) lost its clip`).toBeTruthy();
      }
    }
  });

  it("kiosk clips are kiosk-encoded, not marketing masters", () => {
    // Chrome will not cache an entry over roughly 1/8 of its disk cache (~30-40MB
    // here), so an oversized clip re-downloads on every attract re-mount, 24/7.
    // The two reused masters are small; the two big ones have kiosk cuts.
    expect(KIOSK_VIDEOS.race).toContain("ft-race-kiosk");
    expect(KIOSK_VIDEOS.gel).toContain("nexus-gel-kiosk");
    expect(KIOSK_VIDEOS.race).not.toContain("hero-video");
  });
});

describe("video/still alternation", () => {
  const FM = kioskAdSlidesFor("fort-myers"); // 4 slides, all with clips

  it("no two consecutive slides move within a lap", () => {
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let i = 0; i < FM.length - 1; i++) {
        const a = slidePlaysVideo(cycle, i, !!FM[i].video);
        const b = slidePlaysVideo(cycle, i + 1, !!FM[i + 1].video);
        expect(a && b, `slides ${i} and ${i + 1} both play on lap ${cycle}`).toBe(false);
      }
    }
  });

  it("an activity flips every lap — video, then still, then video", () => {
    // The whole point: cycle-only parity would freeze each slide on one side
    // forever with an even slide count.
    for (let i = 0; i < FM.length; i++) {
      const seen = [0, 1, 2, 3].map((c) => slidePlaysVideo(c, i, true));
      expect(seen, `slide ${i} did not alternate`).toEqual([seen[0], !seen[0], seen[0], !seen[0]]);
    }
  });

  it("a slide with no clip never plays, whatever the parity says", () => {
    for (let cycle = 0; cycle < 4; cycle++) {
      expect(slidePlaysVideo(cycle, 0, false)).toBe(false);
    }
  });

  it("survives a negative cycle from a badly-set device clock", () => {
    expect(() => slidePlaysVideo(-3, 1, true)).not.toThrow();
    expect(typeof slidePlaysVideo(-3, 1, true)).toBe("boolean");
    // -3 + 1 = -2, even → plays. JS % would give -0 here; the guard normalises.
    expect(slidePlaysVideo(-3, 1, true)).toBe(true);
  });
});

describe("vehicle relay hands off across the bank", () => {
  // The bug this replaces: a fixed `(position % 4) * 2000` gave FastTrax's
  // SEVEN kiosks only four phases, so 1&5, 2&6 and 3&7 crossed simultaneously
  // and the row looked like it fired in unison.
  it("every screen in a bank gets its own slot", () => {
    for (const count of [4, 5, 7]) {
      const phases = Array.from({ length: count }, (_, p) => vehiclePhaseMs(p, count, p + 1));
      expect(new Set(phases).size, `bank of ${count} reused a phase`).toBe(count);
    }
  });

  it("phases march evenly across one slide, never past it", () => {
    const count = 7; // FastTrax
    const phases = Array.from({ length: count }, (_, p) => vehiclePhaseMs(p, count, p + 1));
    expect(phases[0]).toBe(0);
    for (const ph of phases) expect(ph).toBeLessThan(AD_ROTATE_MS);
    // Even spacing — the wave should not bunch up at one end of the row.
    const gaps = phases.slice(1).map((ph, i) => ph - phases[i]);
    for (const g of gaps) expect(Math.abs(g - AD_ROTATE_MS / count)).toBeLessThanOrEqual(1);
  });

  it("the rightmost screen fires first, so the wave travels right to left", () => {
    // syncGlowPhase seeks to (now + phase), so a BIGGER phase is further along
    // and therefore earlier. Position 0 is leftmost and must be last.
    const count = 5; // HPFM
    const phases = Array.from({ length: count }, (_, p) => vehiclePhaseMs(p, count, p + 1));
    expect(Math.max(...phases)).toBe(phases[count - 1]);
    expect(Math.min(...phases)).toBe(phases[0]);
  });

  it("a kiosk outside the bank map still animates, off the choreography", () => {
    const ph = vehiclePhaseMs(null, 5, 9);
    expect(Number.isFinite(ph)).toBe(true);
    expect(ph).toBeGreaterThanOrEqual(0);
    expect(ph).toBeLessThan(AD_ROTATE_MS);
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

describe("Mega Tuesday is a FastTrax promo, not a HeadPinz one", () => {
  // Both FM venues share center "fort-myers", so a center-keyed rotation put a
  // racing-only dated promo (with an operational junior-racer rule) on the
  // HeadPinz bank — the one bank that also runs the billboard.
  const isMega = kioskAdSlidesFor("fort-myers").some((s) => s.title.includes("Mega"));

  it("HeadPinz Fort Myers never gets the Mega slide", () => {
    expect(kioskAdSlidesFor("fort-myers", "headpinz").some((s) => s.title.includes("Mega"))).toBe(
      false,
    );
  });

  it("FastTrax still gets it, exactly as before", () => {
    expect(kioskAdSlidesFor("fort-myers", "fasttrax").some((s) => s.title.includes("Mega"))).toBe(
      isMega,
    );
    // Omitting brand must not change today's behaviour for existing callers.
    expect(kioskAdSlidesFor("fort-myers").length).toBe(
      kioskAdSlidesFor("fort-myers", "fasttrax").length,
    );
  });

  it("everyday racing cross-promo stays on HeadPinz", () => {
    // Only the DATED promo is gated; "Racing starts here" is fine on the
    // shared campus and must not disappear with it.
    expect(
      kioskAdSlidesFor("fort-myers", "headpinz").some((s) => s.title.startsWith("Racing")),
    ).toBe(true);
  });
});

describe("billboard: curtain up together, words one by one", () => {
  const count = bankSize("HPFM");
  const at = (t: number, p: number) => billboardStage(t, p, count);

  it("every screen cuts to its image at the same instant", () => {
    // The ragged look came from each screen changing picture a second apart.
    for (let p = 0; p < count; p++) {
      expect(at(0, p).image, `screen ${p} did not raise the curtain at t=0`).toBe(true);
      expect(at(0, p).word, `screen ${p} lit its word during the lead-in`).toBe(false);
    }
  });

  it("words then light one at a time, left to right", () => {
    for (let p = 0; p < count; p++) {
      const mine = BILLBOARD_LEAD_MS + p * 1000;
      expect(at(mine, p).word, `screen ${p} missed its slot`).toBe(true);
      if (p > 0) expect(at(mine - 1, p).word, `screen ${p} lit early`).toBe(false);
      // ...and a screen further right has not lit yet at this instant.
      if (p + 1 < count) expect(at(mine, p + 1).word).toBe(false);
    }
  });

  it("the image is up the whole time the show runs", () => {
    const finaleEnd = BILLBOARD_LEAD_MS + count * 1000 + 2200 + 3800;
    for (let t = 0; t < finaleEnd; t += 250) {
      for (let p = 0; p < count; p++) expect(at(t, p).image, `gap at t=${t}`).toBe(true);
    }
  });

  it("the bank shares the finale, then the curtain drops everywhere at once", () => {
    const finaleStart = BILLBOARD_LEAD_MS + count * 1000 + 2200;
    const finaleEnd = finaleStart + 3800;
    for (let p = 0; p < count; p++) {
      expect(at(finaleStart, p).finale).toBe(true);
      expect(at(finaleStart, p).word).toBe(false); // activity words clear first
      expect(at(finaleEnd, p)).toEqual({ image: false, word: false, finale: false });
    }
  });

  it("the whole show fits inside one cycle, with quiet after it", () => {
    const finaleEnd = BILLBOARD_LEAD_MS + count * 1000 + 2200 + 3800;
    expect(finaleEnd).toBeLessThan(40_000);
    expect(at(finaleEnd + 1000, 0).image).toBe(false);
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
