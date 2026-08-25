/**
 * NFL game-day bowling — public surface.
 *
 * `.server` modules are DELIBERATELY not re-exported: claims.server.ts and
 * espn.server.ts pull in the Neon client, and a client component importing this
 * barrel must not drag a database driver into the browser bundle. Server code
 * imports those files by path. Same rule features/world-cup/index.ts follows for
 * live-teams and notify.
 */
export * from "./schedule";
export * from "./blocks";
export * from "./flags";
