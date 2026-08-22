import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const MANIFESTS = [
  { path: './package.json', expectedName: 'libsql-search' },
  { path: './jsr.json', expectedName: '@logan/libsql-search' },
  { path: './deno.json', expectedName: '@logan/libsql-search' },
];

function fail(message) {
  throw new Error(`release planning failed: ${message}`);
}

export function parseStableTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);

  if (!match) {
    return null;
  }

  return {
    tag,
    version: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function parseVersion(version) {
  const parsed = parseStableTag(`v${version}`);

  if (!parsed) {
    fail(`version "${version}" must match X.Y.Z with SemVer numeric identifiers`);
  }

  return parsed;
}

export function compareVersions(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function highestStableTag(tags) {
  const stableTags = tags.map(parseStableTag).filter(Boolean);

  if (stableTags.length === 0) {
    return parseStableTag('v0.0.0');
  }

  return stableTags.sort((a, b) => compareVersions(b, a))[0];
}

export function detectBump(commitsText) {
  if (/^[a-zA-Z][\w-]*(\([^)]+\))?!:/m.test(commitsText) || /^BREAKING[ -]CHANGE:/m.test(commitsText)) {
    return 'major';
  }

  if (/^feat(\([^)]+\))?:/m.test(commitsText)) {
    return 'minor';
  }

  return 'patch';
}

export function incrementVersion(version, bump) {
  const parsed = parseVersion(version);

  if (bump === 'major') {
    return `${parsed.major + 1}.0.0`;
  }

  if (bump === 'minor') {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }

  if (bump === 'patch') {
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }

  fail(`unsupported bump type "${bump}"`);
}

export function planRelease({ tags, commitCount, commitsText, manifestVersion }) {
  const latest = highestStableTag(tags);

  if (commitCount === 0) {
    return {
      shouldRelease: false,
      reason: `No commits found after ${latest.tag}.`,
      latestTag: latest.tag,
      latestVersion: latest.version,
      bump: 'none',
      version: '',
      tag: '',
      needsVersionCommit: false,
    };
  }

  const bump = detectBump(commitsText);
  const bumpedVersion = incrementVersion(latest.version, bump);
  const parsedManifest = parseVersion(manifestVersion);
  const parsedBumped = parseVersion(bumpedVersion);
  const parsedLatest = parseVersion(latest.version);
  let version = bumpedVersion;

  if (compareVersions(parsedManifest, parsedLatest) > 0 && compareVersions(parsedManifest, parsedBumped) >= 0) {
    version = manifestVersion;
  }

  return {
    shouldRelease: true,
    reason: `Selected ${version} from ${commitCount} commit(s) after ${latest.tag}.`,
    latestTag: latest.tag,
    latestVersion: latest.version,
    bump,
    version,
    tag: `v${version}`,
    needsVersionCommit: manifestVersion !== version,
  };
}

function runGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readManifestVersion() {
  const versions = [];

  for (const manifest of MANIFESTS) {
    const json = readJson(manifest.path);

    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      fail(`${manifest.path} must contain a JSON object`);
    }

    if (json.name !== manifest.expectedName) {
      fail(`${manifest.path} name must be "${manifest.expectedName}", found ${JSON.stringify(json.name)}`);
    }

    versions.push({ path: manifest.path, version: json.version });
  }

  const [first] = versions;

  if (!first?.version || typeof first.version !== 'string') {
    fail(`${first?.path ?? 'manifest'} must contain a string version`);
  }

  for (const entry of versions.slice(1)) {
    if (entry.version !== first.version) {
      fail(`manifest versions are not synchronized: ${versions.map((item) => `${item.path}=${item.version}`).join(', ')}`);
    }
  }

  parseVersion(first.version);
  return first.version;
}

function syncManifestVersions(version) {
  for (const manifest of MANIFESTS) {
    const json = readJson(manifest.path);
    json.version = version;
    writeJson(manifest.path, json);
  }
}

export function collectPlan() {
  const tags = runGit(['tag', '--merged', 'HEAD', '--list', 'v*']).split('\n').filter(Boolean);
  const latest = highestStableTag(tags);
  const hasRealLatestTag = tags.includes(latest.tag);
  const commitRange = hasRealLatestTag ? `${latest.tag}..HEAD` : 'HEAD';
  const commitCount = Number(runGit(['rev-list', '--count', commitRange]));
  const commitsText = commitCount > 0 ? runGit(['log', commitRange, '--pretty=format:%s%n%b']) : '';
  return planRelease({
    tags,
    commitCount,
    commitsText,
    manifestVersion: readManifestVersion(),
  });
}

function toOutputValue(value) {
  return String(value).replaceAll('\n', ' ');
}

function appendGitHubOutput(path, plan) {
  const lines = [
    `should_release=${plan.shouldRelease}`,
    `reason=${toOutputValue(plan.reason)}`,
    `latest_tag=${plan.latestTag}`,
    `latest_version=${plan.latestVersion}`,
    `bump=${plan.bump}`,
    `version=${plan.version}`,
    `tag=${plan.tag}`,
    `needs_version_commit=${plan.needsVersionCommit}`,
  ];

  appendFileSync(path, `${lines.join('\n')}\n`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const plan = collectPlan();

  if (args.has('--write') && plan.shouldRelease) {
    syncManifestVersions(plan.version);
  }

  if (args.has('--github-output')) {
    const outputPath = process.env.GITHUB_OUTPUT;

    if (!outputPath) {
      fail('--github-output requires GITHUB_OUTPUT to be set');
    }

    appendGitHubOutput(outputPath, plan);
    return;
  }

  console.log(JSON.stringify(plan, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
