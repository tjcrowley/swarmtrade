import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/__tests__/**/*.test.ts', 'packages/*/__tests__/**/*.test.ts'],
    globals: true,
  },
});
