import { defineConfig } from 'vitest/config';

// Phase 0.1: legacy tests live under legacy/test/ and reference v1 types
// that no longer exist in src/. New tests will land per slice in
// docs/plan/v4-plan.md.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
