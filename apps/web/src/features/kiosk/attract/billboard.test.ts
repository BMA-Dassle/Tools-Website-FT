import { describe, expect, it } from "vitest";
import {
  BILLBOARD_CYCLE_MS,
  BILLBOARD_SLIDES,
  bankPosition,
  bankSize,
  billboardPhase,
} from "./billboard";

describe("bankPosition", () => {
  it("maps HPFM's out-of-order physical bank (3,2,6,1,4)", () => {
    expect(bankPosition("HPFM", 3)).toBe(0);
    expect(bankPosition("HPFM", 2)).toBe(1);
    expect(bankPosition("HPFM", 6)).toBe(2);
    expect(bankPosition("HPFM", 1)).toBe(3);
    expect(bankPosition("HPFM", 4)).toBe(4);
  });

  it("is identity for FastTrax (banked in number order)", () => {
    for (let n = 1; n <= 7; n++) expect(bankPosition("FT", n)).toBe(n - 1);
  });

  it("maps Naples' physical bank (10,9,7,8)", () => {
    expect(bankPosition("HPN", 10)).toBe(0);
    expect(bankPosition("HPN", 9)).toBe(1);
    expect(bankPosition("HPN", 7)).toBe(2);
    expect(bankPosition("HPN", 8)).toBe(3);
  });

  it("excludes kiosks missing from the map (owner: don't include them for now)", () => {
    expect(bankPosition("HPFM", 9)).toBeNull();
    expect(bankPosition("HPN", 5)).toBeNull();
    expect(bankPosition("HPN", 0)).toBeNull();
  });
});

describe("billboardPhase", () => {
  const N = bankSize("HPFM"); // 5 screens

  it("runs idle → activity in position order → finale → idle inside one cycle", () => {
    // leftmost screen lights at t=0, position 3 not until 3s
    expect(billboardPhase(0, 0, N)).toBe("activity");
    expect(billboardPhase(0, 3, N)).toBe("idle");
    expect(billboardPhase(3_000, 3, N)).toBe("activity");
    // finale starts at count*1000 + 2200 = 7200 for EVERY screen
    expect(billboardPhase(7_199, 0, N)).toBe("activity");
    expect(billboardPhase(7_200, 0, N)).toBe("finale");
    expect(billboardPhase(7_200, N - 1, N)).toBe("finale");
    // finale ends at 7200 + 3800 = 11000; the rest of the cycle is idle
    expect(billboardPhase(11_000, 0, N)).toBe("idle");
    expect(billboardPhase(BILLBOARD_CYCLE_MS - 1, 0, N)).toBe("idle");
  });

  it("is cyclical — the next cycle replays the same phases", () => {
    for (const t of [0, 3_000, 7_200, 11_000]) {
      for (let p = 0; p < N; p++) {
        expect(billboardPhase(t + BILLBOARD_CYCLE_MS * 7, p, N)).toBe(billboardPhase(t, p, N));
      }
    }
  });

  it("tolerates a negative clock offset without going undefined", () => {
    expect(["idle", "activity", "finale"]).toContain(billboardPhase(-500, 0, N));
  });
});

describe("BILLBOARD_SLIDES", () => {
  it("Naples never advertises racing", () => {
    for (const slide of BILLBOARD_SLIDES.HPN) {
      expect(slide.word.toLowerCase()).not.toContain("rac");
    }
  });

  it("every slide has a photo and an accent", () => {
    for (const slides of Object.values(BILLBOARD_SLIDES)) {
      for (const s of slides) {
        expect(s.photo).toBeTruthy();
        expect(s.accent).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});
