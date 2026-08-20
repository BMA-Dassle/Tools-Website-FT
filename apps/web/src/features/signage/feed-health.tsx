"use client";

/**
 * The poll-health stamps, made available to any scene that wants to show them.
 *
 * A CONTEXT RATHER THAN A PROP, for once, and the reason is narrow: the two
 * stamps are needed by ONE leaf in the footer of ONE board, and the alternative
 * is widening `SceneProps` — the contract sixteen scenes implement — plus a
 * pass-through in SceneDirector, plus a prop on the shared Footer, plus a prop
 * on Shell, plus every "nothing to show" card that builds on Shell. Four layers
 * of plumbing so a 23px readout can reach a corner it is already inside.
 *
 * The default is BOTH NULL, which the pure resolver reads as "warming" and the
 * component renders as nothing. So a scene rendered without the provider — the
 * admin preview, a unit test, a Storybook-style harness — silently shows no
 * stamp instead of throwing or claiming a board is dead.
 *
 * Health is deliberately NOT part of the shared clock. See the note in
 * liveness.ts about why these stamps must stay on the client's raw Date.now().
 */
import { createContext, useContext } from "react";
import type { TvFeedHealth } from "./useTvFeed";

const NEVER_POLLED: TvFeedHealth = { lastFullOkMs: null, lastPulseOkMs: null };

const FeedHealthContext = createContext<TvFeedHealth>(NEVER_POLLED);

export const FeedHealthProvider = FeedHealthContext.Provider;

export function useFeedHealth(): TvFeedHealth {
  return useContext(FeedHealthContext);
}
