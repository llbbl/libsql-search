import dts from 'rollup-plugin-dts';

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
  output: {
    file: 'dist/index.d.ts',
    format: 'es'
  },
  external,
  plugins: [dts()]
};
