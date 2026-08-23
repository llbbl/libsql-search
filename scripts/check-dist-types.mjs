#!/usr/bin/env node

/**
 * Type-check the built declarations against each other.
 *
 * `dist/index.d.ts` and `dist/turso.d.ts` are bundled separately, so each one
 * carries its own copy of the `DatabaseAdapter` declaration. Those two copies
 * are only interchangeable while they stay structurally identical — the moment
 * one of them gains a `unique symbol` brand, a private member, or a member the
 * other lacks, `tursoAdapter()`'s return value stops being assignable to
 * `SearchOptions['client']` and every Turso user's build breaks, with nothing
 * in the source tree looking wrong.
 *
 * `tsc --noEmit` over `src/` cannot catch that: within the source tree both
 * entry points share one declaration. This compiles a consumer against the
 * built artifacts instead, which is the only place the split is visible.
 *
 * It also asserts that `dist/index.d.ts` names no Turso type and exports no new
 * symbol, which is the packaging promise: an existing `@libsql/client` user
 * sees nothing new on the main entry point.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const distDirectory = join(repoRoot, 'dist');

/**
 * The exact value exports of the main entry point.
 *
 * Pinned rather than derived so that a new export has to be added here
 * deliberately. The Turso work must add none.
 */
const EXPECTED_VALUE_EXPORTS = [
  'DEFAULT_SEARCH_CANDIDATE_MULTIPLIER',
  'IndexingError',
  'MAX_SEARCH_CANDIDATES',
  'MIN_SEARCH_CANDIDATES',
  'createEmbeddingProvider',
  'createTable',
  'generateEmbedding',
  'generateEmbeddings',
  'getAllArticles',
  'getArticleBySlug',
  'getArticlesByFolder',
  'getEmbeddingProviderMetadata',
  'getFolders',
  'indexContent',
  'padEmbedding',
  'prepareTextForEmbedding',
  'search',
  'validateEmbeddingBatch',
];

const EXPECTED_TYPE_EXPORTS = [
  'EmbeddingBatchBehavior',
  'EmbeddingBatchItem',
  'EmbeddingBatchItemResult',
  'EmbeddingBatchMode',
  'EmbeddingBatchResult',
  'EmbeddingIntent',
  'EmbeddingOptions',
  'EmbeddingProvider',
  'EmbeddingProviderClient',
  'EmbeddingProviderMetadata',
  'EmbeddingRequestOptions',
  'IndexFailure',
  'IndexFailurePolicy',
  'IndexFailureStage',
  'IndexResult',
  'IndexedDocument',
  'IndexerOptions',
  'IndexingErrorPhase',
  'SearchOptions',
  'SearchResult',
];

function parseExportList(source, keyword) {
  const pattern = keyword === 'type'
    ? /^export type \{([^}]*)\};$/m
    : /^export \{([^}]*)\};$/m;
  const match = pattern.exec(source);

  if (!match) {
    throw new Error(`Could not find an "export ${keyword === 'type' ? 'type ' : ''}{...}" line in the built declaration`);
  }

  return match[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
}

function assertSameList(actual, expected, file, label) {
  const added = actual.filter((name) => !expected.includes(name));
  const removed = expected.filter((name) => !actual.includes(name));

  if (added.length > 0 || removed.length > 0) {
    throw new Error(
      `${file} ${label} changed.` +
        (added.length > 0 ? ` Added: ${added.join(', ')}.` : '') +
        (removed.length > 0 ? ` Removed: ${removed.join(', ')}.` : '') +
        ' Update scripts/check-dist-types.mjs only if the change is intended.',
    );
  }
}

async function assertMainEntryUnchanged() {
  const source = await readFile(join(distDirectory, 'index.d.ts'), 'utf8');

  assertSameList(
    parseExportList(source, 'value'),
    [...EXPECTED_VALUE_EXPORTS].sort(),
    'dist/index.d.ts',
    'value exports',
  );
  assertSameList(
    parseExportList(source, 'type'),
    [...EXPECTED_TYPE_EXPORTS].sort(),
    'dist/index.d.ts',
    'type exports',
  );

  // Comments are allowed to mention the subpath; declarations are not allowed
  // to depend on it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  if (/@tursodatabase\//.test(code)) {
    throw new Error('dist/index.d.ts references @tursodatabase/* outside of comments');
  }

  if (/from ['"]\.\/turso/.test(code)) {
    throw new Error('dist/index.d.ts imports from the Turso entry point');
  }

  console.log('  ok dist/index.d.ts exports unchanged, no Turso dependency');
}

/**
 * The Turso entry point's exports.
 *
 * `DatabaseAdapter` is exported HERE and deliberately not from the main entry:
 * it is the type `tursoAdapter()` returns, and without it a consumer cannot
 * name that type. An export modifier is not a structural member, so the
 * asymmetry does not affect cross-entry assignability -- which the compile
 * below proves rather than assumes.
 */
const EXPECTED_TURSO_VALUE_EXPORTS = ['tursoAdapter'];
const EXPECTED_TURSO_TYPE_EXPORTS = ['DatabaseAdapter', 'TursoDatabase', 'TursoStatement'];

async function assertTursoEntryExports() {
  const source = await readFile(join(distDirectory, 'turso.d.ts'), 'utf8');

  assertSameList(
    parseExportList(source, 'value'),
    [...EXPECTED_TURSO_VALUE_EXPORTS].sort(),
    'dist/turso.d.ts',
    'value exports',
  );
  assertSameList(
    parseExportList(source, 'type'),
    [...EXPECTED_TURSO_TYPE_EXPORTS].sort(),
    'dist/turso.d.ts',
    'type exports',
  );

  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  // The whole point of the structural TursoDatabase interface: declaring this
  // entry point must never make the native package a resolution target.
  if (/from ['"]@tursodatabase\//.test(code)) {
    throw new Error('dist/turso.d.ts imports from @tursodatabase/* -- it must stay structural');
  }

  console.log('  ok dist/turso.d.ts exports as expected, no native import');
}

async function assertRuntimeEntryUnchanged() {
  for (const file of ['index.esm.js', 'index.cjs']) {
    const source = await readFile(join(distDirectory, file), 'utf8');

    if (source.includes('@tursodatabase/')) {
      throw new Error(`dist/${file} references @tursodatabase/*`);
    }
  }

  // The subpath's runtime must not import it either -- it takes the handle as
  // an argument.
  for (const file of ['turso.esm.js', 'turso.cjs']) {
    const source = await readFile(join(distDirectory, file), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    if (/(from|require\()\s*['"]@tursodatabase\//.test(code)) {
      throw new Error(`dist/${file} imports @tursodatabase/* -- it must take the handle as an argument`);
    }
  }

  console.log('  ok no runtime bundle imports @tursodatabase/*');
}

async function checkCrossEntryTypes() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'libsql-search-dts-'));
  const consumerFile = join(temporaryDirectory, 'consumer.ts');

  const consumerSource = `
import type { IndexerOptions, SearchOptions } from ${JSON.stringify(join(distDirectory, 'index.js'))};
import { tursoAdapter } from ${JSON.stringify(join(distDirectory, 'turso.js'))};

declare const handle: { exec(sql: string): unknown; prepare(sql: string): { run(args?: unknown): unknown; all(args?: unknown): unknown } };

// The assignments are the assertion: an adapter produced by the subpath entry
// must satisfy the client type declared by the main entry, across two
// independently bundled declarations.
const searchClient: SearchOptions['client'] = tursoAdapter(handle);
const indexClient: IndexerOptions['client'] = tursoAdapter(handle);

void searchClient;
void indexClient;
`;

  await writeFile(consumerFile, consumerSource);

  try {
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        '--noEmit',
        '--strict',
        '--target', 'ES2022',
        '--module', 'ES2022',
        '--moduleResolution', 'node',
        '--skipLibCheck',
        consumerFile,
      ],
      { encoding: 'utf8', cwd: repoRoot },
    );

    if (result.status !== 0) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error(
        'An adapter from dist/turso.d.ts is not assignable to the client type in dist/index.d.ts. ' +
          'The two bundled copies of DatabaseAdapter have drifted apart.',
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log('  ok libsql-search/turso adapters satisfy libsql-search client types');
}

async function main() {
  await assertMainEntryUnchanged();
  await assertTursoEntryExports();
  await assertRuntimeEntryUnchanged();
  await checkCrossEntryTypes();

  console.log('Built declaration checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
