import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import esbuild from 'rollup-plugin-esbuild';

const external = [
  '@libsql/client',
  '@huggingface/transformers',
  'gray-matter',
  '@google/genai',
  // Never bundled, and never imported by our source either. Listed so that a
  // future import of it fails the build loudly instead of being inlined into
  // an entry point that must not resolve a native package.
  '@tursodatabase/database',
  'onnxruntime-node',
  'onnxruntime-web',
  'sharp',
  'fs',
  'path',
  'fs/promises',
  'node:fs/promises',
  'node:path'
];

const plugins = () => [
  resolve(),
  commonjs(),
  esbuild({
    target: 'es2022',
    tsconfig: './tsconfig.json'
  })
];

/**
 * One self-contained bundle per entry point.
 *
 * The Turso entry is built separately rather than as a shared-chunk sibling of
 * the main entry, so that `libsql-search` and `libsql-search/turso` never load
 * each other. The small amount of adapter code duplicated between them is
 * stateless, and adapters are recognized by a plain marker property, so an
 * adapter from one bundle works with functions from the other.
 */
export default [
  {
    input: 'src/index.ts',
    output: [
      { file: 'dist/index.esm.js', format: 'es', sourcemap: false },
      { file: 'dist/index.cjs', format: 'cjs', sourcemap: false }
    ],
    external,
    plugins: plugins()
  },
  {
    input: 'src/turso.ts',
    output: [
      { file: 'dist/turso.esm.js', format: 'es', sourcemap: false },
      { file: 'dist/turso.cjs', format: 'cjs', sourcemap: false }
    ],
    external,
    plugins: plugins()
  }
];
