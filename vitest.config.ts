import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test' },
    // The embedded Postgres (PGlite) takes a few seconds to boot.
    hookTimeout: 90_000,
    testTimeout: 30_000,
  },
});
