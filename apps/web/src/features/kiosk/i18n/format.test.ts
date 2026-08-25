import { describe, expect, it } from "vitest";
import IntlMessageFormat from "intl-messageformat";
import { formatMessage } from "./format";
import { KIOSK_LOCALES, LOCALE_BCP47, normalizeLocale, isKioskLocale } from "./locales";
import { getMessages, fallbackMessage, type MessageKey } from "./messages";

describe("normalizeLocale", () => {
  it("maps supported inputs (incl. BCP-47 subtags + names) to a locale", () => {
    expect(normalizeLocale("es")).toBe("es");
    expect(normalizeLocale("ES")).toBe("es");
    expect(normalizeLocale("es-US")).toBe("es");
    expect(normalizeLocale("espanol")).toBe("es");
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("english")).toBe("en");
  });

  it("returns null for unsupported / empty input", () => {
    expect(normalizeLocale("fr")).toBeNull();
    expect(normalizeLocale("")).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
  });

  it("isKioskLocale is a correct type guard", () => {
    expect(isKioskLocale("en")).toBe(true);
    expect(isKioskLocale("es")).toBe(true);
    expect(isKioskLocale("fr")).toBe(false);
    expect(isKioskLocale(42)).toBe(false);
  });
});

describe("formatMessage", () => {
  it("returns the English source for the en locale", () => {
    expect(formatMessage("en", "attract.touchToStart")).toBe("Touch to get started");
  });

  it("returns the Spanish translation for the es locale", () => {
    expect(formatMessage("es", "attract.letsPlay")).toBe("¡A jugar!");
    expect(formatMessage("es", "attract.touchToStart")).toBe("Toca para comenzar");
  });

  it("es catalog covers every English key (no gaps in the spike set)", () => {
    const en = getMessages("en");
    const es = getMessages("es");
    for (const key of Object.keys(en)) {
      expect(es[key as keyof typeof es], `missing es for ${key}`).toBeTruthy();
    }
  });

  it("falls back to raw English when a formatter can't be built", () => {
    // Sanity: fallbackMessage is always the English source string.
    expect(formatMessage("es", "attract.letsPlay")).not.toBe(fallbackMessage("attract.letsPlay"));
    expect(fallbackMessage("attract.letsPlay")).toBe("Let’s play.");
  });
});

describe("catalog integrity", () => {
  // formatMessage swallows a malformed ICU string and silently renders the raw
  // ENGLISH source (see format.ts) — so a typo'd plural block in a Spanish value
  // ships as a half-translated screen with no error anywhere. Compile every
  // message in every locale so that can't happen quietly.
  it("every message in every locale is valid ICU", () => {
    const bad: string[] = [];
    for (const locale of KIOSK_LOCALES) {
      const messages = getMessages(locale);
      for (const [key, message] of Object.entries(messages)) {
        try {
          new IntlMessageFormat(message, LOCALE_BCP47[locale]);
        } catch (err) {
          bad.push(`${locale} ${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    expect(bad, `malformed ICU:\n${bad.join("\n")}`).toEqual([]);
  });

  it("no message is left as an empty string", () => {
    for (const locale of KIOSK_LOCALES) {
      const messages = getMessages(locale);
      for (const [key, message] of Object.entries(messages)) {
        expect(message.trim(), `empty ${locale} value for ${key}`).not.toBe("");
      }
    }
  });
});

describe("flow catalog — the wizard shell (KioskFlow)", () => {
  it("names the activity inside the exit-confirm copy, in both languages", () => {
    expect(formatMessage("en", "flow.exit.title.unfinished", { activity: "Laser Tag" })).toBe(
      "Your Laser Tag isn’t finished",
    );
    expect(formatMessage("es", "flow.exit.title.unfinished", { activity: "Laser Tag" })).toBe(
      "Tu Laser Tag no está terminado",
    );
    expect(formatMessage("es", "flow.exit.removeAndHome")).toBe(
      "Quitarlo e ir a la página principal",
    );
  });

  it("keeps the Game-Zone-cards caveat as a whole sentence, not a spliced fragment", () => {
    const plain = formatMessage("es", "flow.exit.body.unfinished", { activity: "Duckpin" });
    const withCards = formatMessage("es", "flow.exit.body.unfinishedCards", {
      activity: "Duckpin",
    });
    expect(plain).not.toContain("Game Zone");
    expect(withCards).toContain("Game Zone");
    // Both are complete Spanish sentences on their own.
    expect(plain.endsWith(".")).toBe(true);
    expect(withCards.endsWith(".")).toBe(true);
  });

  it("localizes the step counter and the blocked-Continue hints", () => {
    expect(formatMessage("es", "flow.stepOf", { current: 3, total: 5 })).toBe("Paso 3 de 5");
    expect(formatMessage("es", "stepReason.attractionProduct")).toBe(
      "Elige una actividad para continuar.",
    );
    expect(formatMessage("es", "stepTitle.yourInfo")).toBe("Tus datos");
  });

  it("pluralizes the phone-sign-in and unracered sheets per locale", () => {
    expect(formatMessage("en", "flow.mobileJoin.title", { count: 1 })).toBe(
      "Someone’s still signing in on their phone",
    );
    expect(formatMessage("en", "flow.mobileJoin.title", { count: 3 })).toBe(
      "3 people are still signing in on their phones",
    );
    expect(formatMessage("es", "flow.mobileJoin.title", { count: 3 })).toBe(
      "3 personas todavía están iniciando sesión en sus teléfonos",
    );
    expect(formatMessage("es", "flow.unracered.title", { names: "Ana", count: 1 })).toBe(
      "Ana todavía no está en una carrera",
    );
    expect(formatMessage("es", "flow.unracered.title", { names: "Ana & Luis", count: 2 })).toBe(
      "Ana & Luis todavía no están en una carrera",
    );
  });

  it("passes vendor error text through untranslated", () => {
    expect(formatMessage("es", "flow.err.timeFailedMsg", { msg: "SLOT_TAKEN" })).toBe(
      "No se pudo reservar esa hora: SLOT_TAKEN",
    );
  });

  it("holds an activity-name key for every attraction slug the flow can seed", () => {
    const keys: MessageKey[] = [
      "flow.activity.gelBlaster",
      "flow.activity.laserTag",
      "flow.activity.duckpin",
      "flow.activity.shuffleboard",
      "flow.activity.generic",
    ];
    for (const key of keys) expect(formatMessage("es", key)).toBeTruthy();
  });
});

describe("height & age safety confirm (HeightAgeConfirmModal)", () => {
  it("agrees the verb with the racer count in both languages", () => {
    expect(formatMessage("en", "heightAge.adults", { count: 1 })).toContain("1 adult racer who is");
    expect(formatMessage("en", "heightAge.adults", { count: 2 })).toContain(
      "2 adult racers who are each",
    );
    // Spanish has to agree across BOTH verbs (tiene/tienen + mide/miden), which
    // is why each plural branch carries a whole sentence.
    expect(formatMessage("es", "heightAge.adults", { count: 1 })).toContain("que tiene");
    expect(formatMessage("es", "heightAge.adults", { count: 1 })).toContain("mide al menos");
    expect(formatMessage("es", "heightAge.adults", { count: 3 })).toContain("que tienen");
    expect(formatMessage("es", "heightAge.adults", { count: 3 })).toContain("miden al menos");
  });

  it("carries the SAME enforced figures in every locale — a translation must not drift them", () => {
    for (const locale of KIOSK_LOCALES) {
      const adults = formatMessage(locale, "heightAge.adults", { count: 2 });
      expect(adults, `${locale} adult age`).toContain("13");
      expect(adults, `${locale} adult height`).toContain("59");

      const juniors = formatMessage(locale, "heightAge.juniors", { count: 2 });
      expect(juniors, `${locale} junior ages`).toMatch(/7/);
      expect(juniors, `${locale} junior min height`).toContain("49");
      expect(juniors, `${locale} junior max height`).toContain("70");
    }
  });

  it("renders the prime marks literally — ICU must not eat them as quotes", () => {
    // 4′11″ uses PRIME characters, not an ASCII apostrophe: a bare ' is
    // ICU's escape character, so `4'11"` risked swallowing the rest as a quoted
    // literal. Assert the glyphs survive formatting.
    const adults = formatMessage("en", "heightAge.adults", { count: 1 });
    expect(adults).toContain("59″");
    expect(adults).toContain("(4′11″)");
    expect(adults).not.toContain("{");
  });

  it("localizes the modal chrome, including both CTA variants", () => {
    expect(formatMessage("es", "heightAge.title")).toBe("Confirma estatura y edad");
    expect(formatMessage("es", "heightAge.changeParty")).toBe("Cambiar el tamaño del grupo");
    // Web (date flow) vs kiosk (walk-up, always today).
    expect(formatMessage("es", "heightAge.confirmDate")).toContain("fecha");
    expect(formatMessage("es", "heightAge.subheadingKiosk")).toContain("hora de carrera");
  });
});

describe("attraction catalog — the reused-web steps", () => {
  it("localizes the contact form and the product page chrome", () => {
    expect(formatMessage("es", "contact.title")).toBe("Tus datos");
    expect(formatMessage("es", "attraction.howMany")).toBe("¿Cuántas personas?");
    expect(formatMessage("es", "attraction.perPerson")).toBe("persona");
  });

  it("builds duration labels from the product's minutes", () => {
    expect(formatMessage("en", "attraction.durationMinutes", { minutes: 30 })).toBe("30 min");
    expect(formatMessage("en", "attraction.durationHours", { hours: 1 })).toBe("1 hour");
    expect(formatMessage("es", "attraction.sessionMinutes", { minutes: 15 })).toBe(
      "sesión de 15 min",
    );
  });

  it("states play time AND slot time when a product's gameplay is shorter (Nexus gel/laser)", () => {
    expect(formatMessage("en", "attraction.playExperience", { play: 7, total: 15 })).toBe(
      "7 min session · 15 min experience",
    );
    expect(formatMessage("es", "attraction.playExperience", { play: 7, total: 15 })).toBe(
      "sesión de 7 min · experiencia de 15 min",
    );
  });
});

describe("categories catalog (ICU interpolation + plurals)", () => {
  it("interpolates the attractions eyebrow count and pluralizes per locale", () => {
    expect(formatMessage("en", "categories.attr.eyebrow", { count: 1 })).toBe("1 attraction");
    expect(formatMessage("en", "categories.attr.eyebrow", { count: 7 })).toBe("7 attractions");
    expect(formatMessage("es", "categories.attr.eyebrow", { count: 1 })).toBe("1 atracción");
    expect(formatMessage("es", "categories.attr.eyebrow", { count: 7 })).toBe("7 atracciones");
  });

  it("pluralizes the tile availability count nouns", () => {
    expect(formatMessage("en", "categories.tile.countTables", { count: 1, time: "9:30 PM" })).toBe(
      "1 table · 9:30 PM",
    );
    expect(formatMessage("en", "categories.tile.countPlayers", { count: 4, time: "9:30 PM" })).toBe(
      "4 players · 9:30 PM",
    );
    expect(formatMessage("es", "categories.tile.countTables", { count: 1, time: "9:30 PM" })).toBe(
      "1 mesa · 9:30 PM",
    );
  });

  it("interpolates the experiences next-available line (with + without a count)", () => {
    expect(formatMessage("en", "categories.exp.nextAvailable", { time: "6:15 PM" })).toBe(
      "Next available · 6:15 PM",
    );
    expect(
      formatMessage("en", "categories.exp.nextAvailableSlots", { time: "6:15 PM", count: 5 }),
    ).toBe("Next available · 6:15 PM · 5 slots");
  });

  it("keeps interpolated price + venue values untranslated (only the wording localizes)", () => {
    // The number/venue passes through verbatim; only surrounding copy differs.
    expect(
      formatMessage("es", "categories.combo.priceLine", { weekday: "$65", weekend: "$75" }),
    ).toContain("$65/persona");
    expect(formatMessage("es", "categories.tile.atVenue", { venue: "FastTrax" })).toBe(
      "En FastTrax",
    );
  });
});

describe("confirmation catalog (interpolation)", () => {
  it("interpolates the lane label and the auto-reset countdown", () => {
    expect(formatMessage("en", "confirmation.lane.readyTitle", { lane: "Lane 7" })).toBe(
      "Lane 7 is ready",
    );
    expect(formatMessage("es", "confirmation.lane.openTitle", { lane: "Lane 7" })).toBe(
      "Lane 7 está abierta",
    );
    expect(formatMessage("en", "confirmation.returningIn", { seconds: 42 })).toBe(
      "Returning to start in 42s — touch anywhere to stay",
    );
  });

  // The lane handoff puts the NUMBER in a tile and the word beside it, so the word
  // and the status are separate strings in both catalogs. A guest on lanes 12+13
  // must not be told "Pista" — the plural has to exist and has to differ.
  it("has singular and plural lane words in both catalogs", () => {
    expect(formatMessage("en", "confirmation.lane.word.one")).toBe("Lane");
    expect(formatMessage("en", "confirmation.lane.word.many")).toBe("Lanes");
    expect(formatMessage("es", "confirmation.lane.word.one")).toBe("Pista");
    expect(formatMessage("es", "confirmation.lane.word.many")).toBe("Pistas");
    expect(formatMessage("es", "confirmation.lane.word.many")).not.toBe(
      formatMessage("es", "confirmation.lane.word.one"),
    );
  });

  it("interpolates the auto-open countdown in both languages", () => {
    expect(formatMessage("en", "confirmation.lane.autoOpen", { secs: "9" })).toBe(
      "Opening automatically in 9s — tap Later to hold off.",
    );
    // The Spanish line must actually carry the number, not drop the placeholder.
    expect(formatMessage("es", "confirmation.lane.autoOpen", { secs: "9" })).toContain("9");
    expect(formatMessage("es", "confirmation.lane.autoOpen", { secs: "9" })).not.toContain(
      "{secs}",
    );
  });

  // "Later" is deliberately short so the primary button dominates. A translator
  // lengthening it back into a sentence would undo the layout decision.
  it("keeps the decline label short in both languages", () => {
    for (const locale of ["en", "es"] as const) {
      const later = formatMessage(locale, "confirmation.lane.later");
      expect(later.length).toBeLessThanOrEqual(12);
      expect(later).not.toContain(" ");
    }
  });
});
