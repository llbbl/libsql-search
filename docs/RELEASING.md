# Releasing

Releases are tag-driven and publish only after the release commit has landed on
`main`.

## Flow

1. Open a release PR that synchronizes `package.json`, `jsr.json`, and
   `deno.json` to the same `X.Y.Z` version.
2. Merge the PR to `main`.
3. Wait for `main` CI to pass on the merged commit.
4. Create and push tag `vX.Y.Z` on that merged `main` commit.
5. The `Publish Package` workflow validates that the tag commit is on
   `origin/main`, the tag and manifests agree, and the remote tag still resolves
   to the workflow commit.
6. The workflow publishes `libsql-search` to npm through trusted publishing OIDC
   using the GitHub environment named `npm`.
7. The workflow publishes `@logan/libsql-search` to JSR through its separate OIDC
   publish job.
8. After both registries succeed, the workflow creates a GitHub Release with
   generated notes.

GitHub Releases are an after-publish record. They are not a prerequisite for npm
or JSR publishing.

After the first successful trusted npm release, remove the legacy `NPM_TOKEN`
repository secret.

## Recommended GitHub Settings

Before creating the first trusted tag release, configure:

- A repository ruleset or tag protection rule for `v*` tags.
- The GitHub Actions environment named `npm` restricted to selected deployment
  branches and tags matching `v*`.
