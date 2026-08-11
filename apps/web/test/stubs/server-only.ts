/**
 * Vitest stub for Next's `server-only` package.
 *
 * `import "server-only"` exists purely so that importing a server module from a
 * client component fails at BUILD time with a clear message instead of at
 * runtime with a confusing one. It has no behaviour to reproduce — under test
 * the import simply needs to resolve.
 *
 * Aliased in vitest.config.ts. Nothing imports this file directly.
 */
export {};
