import dts from 'rollup-plugin-dts';

const external = [
  '@libsql/client',
  'gray-matter',
  '@google/genai',
  '@tursodatabase/database',
  'fs',
  'path',
  'fs/promises',
  'node:fs/promises',
  'node:path'
];

/**
 * Declarations are bundled per entry point too, for the same reason the runtime
 * is: `dist/index.d.ts` must not gain a reference to the Turso entry point, and
 * `dist/turso.d.ts` must stand on its own.
 */
export default [
  {
    input: 'src/index.ts',
    output: { file: 'dist/index.d.ts', format: 'es' },
    external,
    plugins: [dts()]
  },
  {
    input: 'src/turso.ts',
    output: { file: 'dist/turso.d.ts', format: 'es' },
    external,
    plugins: [dts()]
  }
];
