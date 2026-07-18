import { describe, expect, it } from "vitest";
import { parseWedgeBurst } from "./wedge";

describe("parseWedgeBurst", () => {
  it("parses a full two-track burst", () => {
    const c = parseWedgeBurst(
      "%B6039123456789012^GAME/CARD^49121200000?;6039123456789012=49121200000?",
    );
    expect(c.tracks.track1).toBe("B6039123456789012^GAME/CARD^49121200000");
    expect(c.tracks.track2).toBe("6039123456789012=49121200000");
    expect(c.cardNumber).toBe("6039123456789012");
  });

  it("parses a track-2-only swipe (common wedge config)", () => {
    const c = parseWedgeBurst(";6039001122334455=0000?\r");
    expect(c.tracks.track1).toBeNull();
    expect(c.tracks.track2).toBe("6039001122334455=0000");
    expect(c.cardNumber).toBe("6039001122334455");
  });

  it("handles a second ; track as track 3", () => {
    const c = parseWedgeBurst(";1111222233334444=1?;99887766?");
    expect(c.tracks.track2).toBe("1111222233334444=1");
    expect(c.tracks.track3).toBe("99887766");
    expect(c.cardNumber).toBe("1111222233334444");
  });

  it("tolerates stripped sentinels and bare-digit reads", () => {
    expect(parseWedgeBurst("6039445566778899\n").cardNumber).toBe("6039445566778899");
    expect(parseWedgeBurst("card 12345678 ok").cardNumber).toBe("12345678");
  });

  it("takes the PAN from track 1 when track 2 is absent", () => {
    const c = parseWedgeBurst("%B6039445566778899^X?");
    expect(c.cardNumber).toBe("6039445566778899");
  });

  it("returns null when nothing usable is present", () => {
    const c = parseWedgeBurst("%?;?");
    expect(c.tracks.track1).toBeNull();
    expect(c.tracks.track2).toBeNull();
    expect(c.cardNumber).toBeNull();
  });
});
