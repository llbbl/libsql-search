#!/usr/bin/env node

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pnpmVersion = '10.34.5';

/**
 * Every arm of the published peer range, as separate install specs.
 *
 * The arms are read from our own manifest rather than copied here, so this
 * smoke test cannot drift from what we publish and fails if the declared range
 * is ever unsatisfiable.
 *
 * They are installed and exercised one at a time rather than as a single
 * disjunction. A disjunction max-satisfies to the newest arm, which would leave
 * every older arm we publish completely untested — the packaged build could
 * come to depend on something only the newest client has, and every gate here
 * would still pass while a consumer sitting on a version our own range blesses
 * broke at runtime.
 */
async function getClientPeerArms() {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const range = manifest.peerDependencies?.['@libsql/client'];

  if (!range) {
    throw new Error('Expected a @libsql/client peer dependency range in package.json');
  }

  return range.split('||').map((arm) => {
    const spec = arm.trim();

    // Caret on a 0.x version pins the minor, so the resolved version must start
    // with `0.<minor>.`. Asserting that in the consumer is what proves each
    // iteration actually installed a different client instead of silently
    // resolving to the same one twice. Any other range shape has no such
    // one-line invariant, so it is rejected rather than quietly unchecked.
    const zeroCaret = /^\^0\.(\d+)\.\d+$/.exec(spec);

    if (!zeroCaret) {
      throw new Error(
        `Peer range arm "${spec}" is not a ^0.x.y caret. Teach getClientPeerArms() how ` +
          `to derive the expected resolved version for this shape before publishing it.`,
      );
    }

    return { spec: `@libsql/client@${spec}`, expectedVersionPrefix: `0.${zeroCaret[1]}.` };
  });
}

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

function smokeSource(moduleSyntax, expectedVersionPrefix) {
  const importBlock = moduleSyntax === 'esm'
    ? [
        `import * as libsqlSearch from 'libsql-search';`,
        // The Turso entry point is resolved even though @tursodatabase/database
        // is NOT installed in this consumer. That is the point: the subpath is
        // declared as an optional peer, and nothing in it imports the native
        // package, so requiring it must not drag one in.
        `import { tursoAdapter } from 'libsql-search/turso';`,
        `import { createClient } from '@libsql/client';`,
        `import { readFileSync } from 'node:fs';`,
        `import { join } from 'node:path';`,
      ].join('\n')
    : [
        `const libsqlSearch = require('libsql-search');`,
        `const { tursoAdapter } = require('libsql-search/turso');`,
        `const { createClient } = require('@libsql/client');`,
        `const { readFileSync } = require('node:fs');`,
        `const { join } = require('node:path');`,
      ].join('\n');

  return `${importBlock}

const expectedVersionPrefix = ${JSON.stringify(expectedVersionPrefix)};

/**
 * Confirm this consumer really installed the peer arm under test.
 *
 * Without this the loop over the peer arms could silently resolve to the same
 * client twice and still report success, which is the exact blind spot the loop
 * exists to close.
 *
 * The manifest is read by filesystem path on purpose: as of 0.17 the client no
 * longer exports './package.json', so require('@libsql/client/package.json')
 * throws ERR_PACKAGE_PATH_NOT_EXPORTED. This is the documented workaround.
 */
const clientVersion = JSON.parse(
  readFileSync(join(process.cwd(), 'node_modules', '@libsql', 'client', 'package.json'), 'utf8'),
).version;

if (!clientVersion.startsWith(expectedVersionPrefix)) {
  throw new Error(
    \`Expected @libsql/client \${expectedVersionPrefix}x, resolved \${clientVersion}\`,
  );
}

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

/**
 * The checks above are pure, so they would pass even if the packaged build and
 * the peer-resolved client disagreed at runtime. This runs the one schema call
 * every consumer makes first, against a real ':memory:' database created by the
 * client the declared peer range resolves to, and confirms the vector index the
 * default search path depends on is actually there afterwards.
 *
 * No embedding provider is involved: this is a client compatibility check, not
 * a search test. The vitest suite covers search semantics against the source.
 */
async function verifyClientInterop() {
  const client = createClient({ url: ':memory:' });

  try {
    await libsqlSearch.createTable(client, 'articles', 384);

    const indexes = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='articles'",
    );
    const indexNames = indexes.rows.map((row) => row.name);

    if (!indexNames.includes('articles_embedding_idx')) {
      throw new Error(
        \`Expected articles_embedding_idx to exist, found: \${indexNames.join(', ')}\`,
      );
    }

    const schema = await client.execute(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='articles'",
    );

    if (!String(schema.rows[0].sql).includes('F32_BLOB(384)')) {
      throw new Error('Expected the articles table to declare embedding F32_BLOB(384)');
    }
  } finally {
    client.close();
  }
}

/**
 * Confirm the Turso subpath is usable from the packed tarball, without the
 * native package installed and without a database of any kind.
 *
 * Two things are proven here that no other gate covers:
 *
 * 1. The subpath "libsql-search/turso" resolves in both module systems from the
 *    published exports map, with @tursodatabase/database absent.
 * 2. An adapter built by the SUBPATH bundle is accepted by createTable() from
 *    the MAIN bundle. The two bundles each carry their own copy of the adapter
 *    declaration, so this is the runtime half of the cross-entry compatibility
 *    the type check covers separately.
 */
async function verifyTursoSubpath() {
  if (typeof tursoAdapter !== 'function') {
    throw new Error('Expected tursoAdapter to be a function on libsql-search/turso');
  }

  const ddl = [];
  const adapter = tursoAdapter({
    exec: async (sql) => {
      ddl.push(sql);
    },
    prepare: () => ({
      run: async () => ({ changes: 0 }),
      all: async () => [],
    }),
  });

  if (adapter.supportsVectorIndex !== false) {
    throw new Error('Expected the Turso adapter to report no vector index support');
  }

  await libsqlSearch.createTable(adapter, 'articles', 384);

  // Joined with a space rather than a newline: this source is itself built
  // inside a template literal, and an escape here would be consumed a level too
  // early.
  const joined = ddl.join(' ');

  if (joined.includes('libsql_vector_idx')) {
    throw new Error('Expected createTable to skip the vector index on the Turso adapter');
  }

  for (const fragment of ['CREATE TABLE IF NOT EXISTS', 'articles_folder_idx', 'articles_slug_idx']) {
    if (!joined.includes(fragment)) {
      throw new Error(\`Expected createTable to emit \${fragment} on the Turso adapter\`);
    }
  }
}

verifyClientInterop().then(verifyTursoSubpath).catch((error) => {
  console.error(error);
  // Not process.exit(): the parent captures stdio through a pipe, and pipe
  // writes complete asynchronously, so exiting on the next tick can discard the
  // diagnostic just written above. Setting the code lets the process drain and
  // exit non-zero on its own.
  process.exitCode = 1;
});
`;
}

async function smokeAgainstClientArm(options) {
  const { arm, index, tarballPath, tempRoot, storeDirectory, command, baseArgs } = options;
  const consumerDirectory = join(tempRoot, `consumer-${index}`);

  await mkdir(consumerDirectory, { recursive: true });
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
      arm.spec,
    ],
    {
      cwd: consumerDirectory,
    },
  );

  const esmPath = join(consumerDirectory, 'esm-smoke.mjs');
  const cjsPath = join(consumerDirectory, 'cjs-smoke.cjs');

  await writeFile(esmPath, smokeSource('esm', arm.expectedVersionPrefix));
  await writeFile(cjsPath, smokeSource('cjs', arm.expectedVersionPrefix));

  run(process.execPath, [esmPath], { cwd: consumerDirectory });
  run(process.execPath, [cjsPath], { cwd: consumerDirectory });

  console.log(`  ok ${arm.spec} (esm + cjs)`);
}

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'libsql-search-smoke-'));
  const packDirectory = join(tempRoot, 'pack');
  const storeDirectory = join(tempRoot, 'pnpm-store');
  const { command, baseArgs } = getPnpmCommand();
  const clientPeerArms = await getClientPeerArms();

  try {
    await mkdir(packDirectory, { recursive: true });

    run(command, [...baseArgs, 'pack', '--pack-destination', packDirectory], {
      cwd: repoRoot,
    });

    const packedFiles = (await readdir(packDirectory)).filter((file) => file.endsWith('.tgz'));
    if (packedFiles.length !== 1) {
      throw new Error(`Expected one packed tarball, found ${packedFiles.length}`);
    }

    const tarballPath = join(packDirectory, packedFiles[0]);

    for (const [index, arm] of clientPeerArms.entries()) {
      await smokeAgainstClientArm({
        arm,
        index,
        tarballPath,
        tempRoot,
        storeDirectory,
        command,
        baseArgs,
      });
    }

    console.log(
      `Package smoke test passed for ${packedFiles[0]} against ` +
        `${clientPeerArms.length} peer range arm(s)`,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
