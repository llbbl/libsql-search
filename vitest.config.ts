import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/huggingface-transformers.mock.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: [['text', { skipFull: false }], 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'scripts/',
        '**/*.test.ts',
        '**/*.config.ts',
        '**/*.config.js',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
