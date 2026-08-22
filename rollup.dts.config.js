import dts from 'rollup-plugin-dts';

const external = [
  '@libsql/client',
  '@xenova/transformers',
  'gray-matter',
  '@google/genai',
  'fs',
  'path',
  'fs/promises',
  'node:fs/promises',
  'node:path'
];

export default {
  input: 'src/index.ts',
  output: {
    file: 'dist/index.d.ts',
    format: 'es'
  },
  external,
  plugins: [dts()]
};
