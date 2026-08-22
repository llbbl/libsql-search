#!/usr/bin/env node

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pnpmVersion = '10.34.5';

function getPnpmCommand() {
  const execPath = process.env.npm_execpath;
  if (execPath?.includes('pnpm')) {
    if (!/\.[cm]?js$/i.test(execPath)) {
      return {
        command: execPath,
        baseArgs: [],
      };
    }

    return {
      command: process.execPath,
      baseArgs: [execPath],
    };
  }

  return {
    command: 'pnpm',
    baseArgs: [],
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      CI: 'true',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }

  return result;
}

async function writeConsumerProject(directory) {
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        packageManager: `pnpm@${pnpmVersion}`,
      },
      null,
      2,
    ),
  );

  await writeFile(join(directory, '.npmrc'), 'enable-pre-post-scripts=true\n');
  await writeFile(
    join(directory, 'pnpm-workspace.yaml'),
    [
      'onlyBuiltDependencies:',
      '  - esbuild',
      '  - protobufjs',
      '  - sharp',
      '',
    ].join('\n'),
  );
}

function smokeSource(moduleSyntax) {
  const importBlock = moduleSyntax === 'esm'
    ? `import * as libsqlSearch from 'libsql-search';`
    : `const libsqlSearch = require('libsql-search');`;

  return `${importBlock}

const expectedFunctions = [
  'createTable',
  'generateEmbedding',
  'getAllArticles',
  'getArticleBySlug',
  'getArticlesByFolder',
  'getFolders',
  'indexContent',
  'padEmbedding',
  'prepareTextForEmbedding',
  'search',
];

for (const name of expectedFunctions) {
  if (typeof libsqlSearch[name] !== 'function') {
    throw new Error(\`Expected root export \${name} to be a function\`);
  }
}

const prepared = libsqlSearch.prepareTextForEmbedding({
  title: 'Package smoke test',
  tags: ['esm', 'cjs'],
  content: 'Verify root export consumption.',
});

if (!prepared.includes('Package smoke test') || !prepared.includes('Tags: esm, cjs')) {
  throw new Error('prepareTextForEmbedding returned unexpected content');
}

const padded = libsqlSearch.padEmbedding([1, 2], 4);

if (padded.length !== 4 || padded[0] !== 1 || padded[1] !== 2 || padded[2] !== 0 || padded[3] !== 0) {
  throw new Error('padEmbedding returned unexpected dimensions or values');
}
`;
}

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'libsql-search-smoke-'));
  const packDirectory = join(tempRoot, 'pack');
  const consumerDirectory = join(tempRoot, 'consumer');
  const storeDirectory = join(tempRoot, 'pnpm-store');
  const { command, baseArgs } = getPnpmCommand();

  try {
    await mkdir(packDirectory, { recursive: true });
    await mkdir(consumerDirectory, { recursive: true });

    run(command, [...baseArgs, 'pack', '--pack-destination', packDirectory], {
      cwd: repoRoot,
    });

    const packedFiles = (await readdir(packDirectory)).filter((file) => file.endsWith('.tgz'));
    if (packedFiles.length !== 1) {
      throw new Error(`Expected one packed tarball, found ${packedFiles.length}`);
    }

    const tarballPath = join(packDirectory, packedFiles[0]);

    await writeConsumerProject(consumerDirectory);

    run(
      command,
      [
        ...baseArgs,
        '--store-dir',
        storeDirectory,
        'add',
        '--allow-build=esbuild',
        '--allow-build=protobufjs',
        '--allow-build=sharp',
        tarballPath,
        '@libsql/client@^0.15.0',
      ],
      {
        cwd: consumerDirectory,
      },
    );

    await writeFile(join(consumerDirectory, 'esm-smoke.mjs'), smokeSource('esm'));
    await writeFile(join(consumerDirectory, 'cjs-smoke.cjs'), smokeSource('cjs'));

    run(process.execPath, [join(consumerDirectory, 'esm-smoke.mjs')], {
      cwd: consumerDirectory,
    });
    run(process.execPath, [join(consumerDirectory, 'cjs-smoke.cjs')], {
      cwd: consumerDirectory,
    });

    console.log(`Package smoke test passed for ${packedFiles[0]}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
