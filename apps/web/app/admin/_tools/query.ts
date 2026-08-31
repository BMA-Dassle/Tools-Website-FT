/**
 * The resolved `searchParams` an admin tool component receives.
 *
 * The shared tool modules take the RESOLVED object, not the Promise Next hands
 * a page. Both route shells `await` it and pass the result, so the two pages
 * cannot drift on when they resolve it — and the shared module stays a plain
 * component that a test can call with a literal.
 */
export type AdminToolQuery = Record<string, string | string[] | undefined>;

/** `searchParams` as Next declares it on a page. */
export type AdminToolQueryPromise = Promise<AdminToolQuery>;
