import { readFile } from 'node:fs/promises';

const PACKAGE_JSON_NAME = 'libsql-search';
const JSR_NAME = '@logan/libsql-search';
const DENO_NAME = '@logan/libsql-search';

const tag = process.argv[2];

function fail(message) {
  console.error(`release version validation failed: ${message}`);
  process.exit(1);
}

if (!tag) {
  fail('expected a release tag argument like v1.2.3');
}

const tagMatch = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);

if (!tagMatch) {
  fail(`tag "${tag}" must match vX.Y.Z with SemVer numeric identifiers`);
}

const version = tag.slice(1);

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    fail(`could not parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateManifest({ filePath, manifest, expectedName }) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail(`${filePath} must contain a JSON object`);
  }

  if (manifest.name !== expectedName) {
    fail(`${filePath} name must be "${expectedName}", found ${JSON.stringify(manifest.name)}`);
  }

  if (manifest.version !== version) {
    fail(`${filePath} version must be "${version}" for tag "${tag}", found ${JSON.stringify(manifest.version)}`);
  }
}

const packageJson = await readJson('./package.json');
const jsrJson = await readJson('./jsr.json');
const denoJson = await readJson('./deno.json');

validateManifest({
  filePath: 'package.json',
  manifest: packageJson,
  expectedName: PACKAGE_JSON_NAME,
});
validateManifest({
  filePath: 'jsr.json',
  manifest: jsrJson,
  expectedName: JSR_NAME,
});
validateManifest({
  filePath: 'deno.json',
  manifest: denoJson,
  expectedName: DENO_NAME,
});

console.log(version);
