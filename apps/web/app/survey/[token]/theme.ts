/**
 * Survey palette, shared by the form, the reward screens, the review CTA and
 * the server-rendered terminal panels (page.tsx).
 *
 * Extracted from SurveyForm.tsx so the server component and the client
 * components can both reach it without importing across the "use client"
 * boundary in a circle. Data only — no components, no hooks — so it is safe to
 * import from either side.
 */

/**
 * Survey brand. "headpinz" (bowling, the original/live path) and "fasttrax"
 * (racing). The form is identical in structure — only the palette, the
 * fixed-nav clearance, and a couple of loyalty-program labels differ.
 */
export type SurveyBrand = "headpinz" | "fasttrax";

export interface Theme {
  /** Page background — matches the body bg the root layout sets per brand. */
  bg: string;
  /** Question / reward card panel. */
  card: string;
  /** Hairline border on cards + inputs. */
  border: string;
  /** Accent: selected pills, primary button, error text. */
  accent: string;
  /** Translucent accent fill behind selected pills. */
  accentFill: string;
  /** Muted secondary text. */
  muted: string;
  /** Tailwind top-padding that clears the brand's fixed nav. */
  navClear: string;
  /** Loyalty program name shown on the Pinz reward. */
  rewardsProgram: string;
}

export const THEMES: Record<SurveyBrand, Theme> = {
  headpinz: {
    bg: "#0a1628",
    card: "rgba(7,16,39,0.95)",
    border: "rgba(255,255,255,0.08)",
    accent: "#fd5b56", // coral
    accentFill: "rgba(253,91,86,0.18)",
    muted: "rgba(255,255,255,0.65)",
    navClear: "pt-36 sm:pt-44",
    rewardsProgram: "HeadPinz Rewards",
  },
  fasttrax: {
    bg: "#000418",
    card: "rgba(10,16,36,0.92)",
    border: "rgba(255,255,255,0.08)",
    accent: "#E53935", // ft-red
    accentFill: "rgba(229,57,53,0.18)",
    muted: "rgba(255,255,255,0.65)",
    navClear: "pt-28 sm:pt-36",
    rewardsProgram: "FastTrax Rewards",
  },
};
