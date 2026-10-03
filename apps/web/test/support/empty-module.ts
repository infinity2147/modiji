// Stand-in for `server-only` where it must be importable outside a React Server Components build
// (vitest unit tests of server modules; the esbuild leak control).
export {};
