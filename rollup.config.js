import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import esbuild from 'rollup-plugin-esbuild';

const external = [
  '@libsql/client',
  '@huggingface/transformers',
  'gray-matter',
  '@google/genai',
  'onnxruntime-node',
  'onnxruntime-web',
  'sharp',
  'fs',
  'path',
  'fs/promises',
  'node:fs/promises',
  'node:path'
];

export default {
  input: 'src/index.ts',
  output: [
    {
      file: 'dist/index.esm.js',
      format: 'es',
      sourcemap: false
    },
    {
      file: 'dist/index.cjs',
      format: 'cjs',
      sourcemap: false
    }
  ],
  external,
  plugins: [
    resolve(),
    commonjs(),
    esbuild({
      target: 'es2022',
      tsconfig: './tsconfig.json'
    })
  ]
};
