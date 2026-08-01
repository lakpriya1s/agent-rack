import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the TypeScript sources. Without this, vitest also picks up any compiled
    // `dist/**/*.test.js` left over from a previous build and runs every suite twice.
    include: ['src/**/*.test.ts'],
  },
});
