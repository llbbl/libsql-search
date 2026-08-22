import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectPlan,
  detectBump,
  highestStableTag,
  incrementVersion,
  parseStableTag,
  planRelease,
} from './plan-release.mjs';

function createTempRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'libsql-search-release-plan-'));
  const run = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const writeJson = (path, value) => writeFileSync(join(repo, path), `${JSON.stringify(value, null, 2)}\n`);

  run(['init', '-b', 'main']);
  run(['config', 'user.name', 'Test User']);
  run(['config', 'user.email', 'test@example.com']);
  writeJson('package.json', { name: 'libsql-search', version: '0.1.4' });
  writeJson('jsr.json', { name: '@logan/libsql-search', version: '0.1.4' });
  writeJson('deno.json', { name: '@logan/libsql-search', version: '0.1.4' });
  run(['add', '.']);
  run(['commit', '-m', 'chore: initial release']);
  run(['tag', 'v0.1.4']);

  return { repo, run };
}

function withCwd(path, callback) {
  const originalCwd = process.cwd();

  try {
    process.chdir(path);
    return callback();
  } finally {
    process.chdir(originalCwd);
  }
}

test('parseStableTag accepts only stable vX.Y.Z tags', () => {
  assert.deepEqual(parseStableTag('v1.2.3'), {
    tag: 'v1.2.3',
    version: '1.2.3',
    major: 1,
    minor: 2,
    patch: 3,
  });
  assert.equal(parseStableTag('1.2.3'), null);
  assert.equal(parseStableTag('v1.2.3-beta.1'), null);
  assert.equal(parseStableTag('v01.2.3'), null);
});

test('highestStableTag ignores malformed and prerelease tags', () => {
  assert.equal(highestStableTag(['v0.9.0', 'v1.0.0-beta.1', 'v1.0.0', 'latest']).tag, 'v1.0.0');
  assert.equal(highestStableTag([]).tag, 'v0.0.0');
});

test('collectPlan ignores higher stable tags that are not merged into HEAD', () => {
  const { repo, run } = createTempRepo();
  writeFileSync(join(repo, 'main-change.txt'), 'main\n');
  run(['add', '.']);
  run(['commit', '-m', 'fix: main patch']);

  run(['switch', '--orphan', 'divergent']);
  writeFileSync(join(repo, 'divergent-change.txt'), 'divergent\n');
  run(['add', '.']);
  run(['commit', '-m', 'feat: divergent major']);
  run(['tag', 'v99.0.0']);
  run(['switch', 'main']);

  withCwd(repo, () => {
    const plan = collectPlan();

    assert.equal(plan.latestTag, 'v0.1.4');
    assert.equal(plan.version, '0.1.5');
  });
});

test('collectPlan skips release when commits after the latest tag only change docs', () => {
  const { repo, run } = createTempRepo();
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'docs', 'release.md'), 'docs\n');
  run(['add', '.']);
  run(['commit', '-m', 'feat: docs-only feature text']);

  withCwd(repo, () => {
    const plan = collectPlan();

    assert.equal(plan.shouldRelease, false);
    assert.equal(plan.latestTag, 'v0.1.4');
    assert.equal(plan.version, '');
  });
});

test('collectPlan releases eligible code when ignored docs-only commit is HEAD', () => {
  const { repo, run } = createTempRepo();
  writeFileSync(join(repo, 'src.ts'), 'export const value = 1;\n');
  run(['add', '.']);
  run(['commit', '-m', 'fix: code patch']);
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'docs', 'release.md'), 'docs\n');
  run(['add', '.']);
  run(['commit', '-m', 'feat: docs-only feature text']);

  withCwd(repo, () => {
    const plan = collectPlan();

    assert.equal(plan.shouldRelease, true);
    assert.equal(plan.bump, 'patch');
    assert.equal(plan.version, '0.1.5');
    assert.equal(plan.reason, 'Selected 0.1.5 from 1 commit(s) after v0.1.4.');
  });
});

test('detectBump handles breaking changes, features, and patch fallback', () => {
  assert.equal(detectBump('chore!: drop old Node support'), 'major');
  assert.equal(detectBump('fix: adjust output\n\nBREAKING CHANGE: output is stricter'), 'major');
  assert.equal(detectBump('feat(search): add provider'), 'minor');
  assert.equal(detectBump('docs: refresh README'), 'patch');
});

test('incrementVersion applies semver bumps', () => {
  assert.equal(incrementVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(incrementVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(incrementVersion('1.2.3', 'patch'), '1.2.4');
});

test('planRelease uses the already synchronized manifest version for bootstrap patch', () => {
  assert.deepEqual(
    planRelease({
      tags: ['v0.1.3'],
      commitCount: 2,
      commitsText: 'fix(ci): add release workflow\nchore: sync manifests',
      manifestVersion: '0.1.4',
    }),
    {
      shouldRelease: true,
      reason: 'Selected 0.1.4 from 2 commit(s) after v0.1.3.',
      latestTag: 'v0.1.3',
      latestVersion: '0.1.3',
      bump: 'patch',
      version: '0.1.4',
      tag: 'v0.1.4',
      needsVersionCommit: false,
    },
  );
});

test('planRelease bumps beyond manifest version when commits require it', () => {
  const plan = planRelease({
    tags: ['v0.1.3'],
    commitCount: 1,
    commitsText: 'feat: add provider',
    manifestVersion: '0.1.4',
  });

  assert.equal(plan.version, '0.2.0');
  assert.equal(plan.needsVersionCommit, true);
});

test('planRelease returns no-op when there are no commits after latest tag', () => {
  const plan = planRelease({
    tags: ['v1.2.3'],
    commitCount: 0,
    commitsText: '',
    manifestVersion: '1.2.3',
  });

  assert.equal(plan.shouldRelease, false);
  assert.equal(plan.version, '');
  assert.equal(plan.needsVersionCommit, false);
});
