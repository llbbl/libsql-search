# Releasing

Normal releases are automatic. Merge a reviewed PR to `main`; the `Publish
Package` workflow decides the next stable SemVer version, creates any required
manifest-only release commit, creates an annotated `vX.Y.Z` tag, publishes npm
and JSR, then creates GitHub Release notes after both registries succeed.

## Automatic release flow

1. Every push to `main` starts `.github/workflows/publish.yml`.
2. The workflow ignores self-generated `chore(release): ...` commits.
3. A serialized release-writer job fetches the current `origin/main` after it
   has the release slot. If `origin/main` moved beyond the triggering commit,
   that older run exits and the newer run handles the accumulated changes.
4. The release planner compares commits since the highest stable `vX.Y.Z` tag
   merged into the release commit. Higher tags that are not reachable from
   `main` are ignored so a stray or divergent tag cannot make the default
   release line jump. Commits whose changed files are confined to `docs/**` or
   `.github/**` do not count as release-eligible and do not affect the bump. If
   the newest `main` commit is docs-only but an earlier untagged code or README
   commit is still pending, that newest run releases the accumulated eligible
   changes. `feat:` bumps minor and all other eligible commits bump patch.
   Breaking changes (a `subject!:` prefix or a `BREAKING CHANGE:` footer) bump
   major only once the package is `1.0.0` or higher. While the package is still
   on the `0.x` line a breaking change bumps the minor instead, so an unattended
   `fix!:` cannot auto-promote the package to `1.0.0`. Promoting off `0.x` is
   deliberate and manual: see step 5.
5. `package.json`, `jsr.json`, and `deno.json` are synchronized to the chosen
   version. If they already match the chosen version, no release commit is
   created. A manifest version that is already ahead of the latest tag wins over
   the computed bump; this is the supported escape hatch for a deliberate
   version jump, including promoting off the `0.x` line. Set all three manifests
   to `1.0.0` on a reviewed PR and the next qualifying release publishes
   `v1.0.0`.
6. The workflow validates the candidate, creates an annotated tag, and atomically
   pushes the release commit plus tag.
7. npm publishes `libsql-search` through trusted publishing OIDC with the GitHub
   environment named `npm`.
8. JSR publishes `@logan/libsql-search` through a separate OIDC job.
9. GitHub Release notes are generated only after both registry jobs complete.

The current bootstrap case is supported: if the latest tag is `v0.1.3` and the
manifests already say `0.1.4`, the first qualifying `main` release tags and
publishes `v0.1.4` without creating an empty release commit.

## Manual overrides

Manual version and tag commands are overrides, not the default path. Use them
only when you intentionally need to publish a specific already-reviewed `main`
commit.

1. Synchronize `package.json`, `jsr.json`, and `deno.json` to the target
   `X.Y.Z` version.
2. Merge that manifest change to `main`.
3. Create annotated tag `vX.Y.Z` on the merged `main` commit.
4. Push the tag.

The same `Publish Package` workflow validates manual tags before publishing. It
checks that the tag target is on `origin/main`, that the tag and manifests agree,
and that the remote tag still resolves to the checked-out commit immediately
before each registry publish.

## Recovery dispatch

Use the guarded workflow dispatch path when an existing `vX.Y.Z` tag needs a
registry or GitHub Release recovery without creating a new version. Example:

```bash
gh workflow run publish.yml --ref main -f release_tag=v0.1.4
```

Dispatch validates that `release_tag` is strict `vX.Y.Z`, fetches the remote tag,
peels it to a commit, checks that commit is on `origin/main`, checks manifests
against the tag, and then publishes from the tag target SHA. Unlike a tag-push
run, dispatch does not require the tag target to equal the workflow dispatch
SHA; this allows a newer `main` workflow fix to recover an older release tag.

npm and GitHub Release recovery steps remain idempotent and skip when the
version or release already exists. JSR recovery always invokes
`pnpm dlx jsr@0.14.3 publish`; do not use `deno info jsr:...` as an existence
gate, because it can resolve successfully even when the public JSR package
version metadata is not actually published.

## GitHub and registry settings

- npm trusted publishing must point at workflow filename `publish.yml` and use
  the GitHub Actions environment named `npm`.
- The workflow does not use `NPM_TOKEN`.
- JSR publishing uses its own OIDC job and does not depend on the npm
  environment.
- The repository settings must allow GitHub Actions to push the generated
  `chore(release): ...` commit to `main`; otherwise the automatic release job
  will validate successfully and then fail at the atomic push step.
- Configure a repository ruleset or tag protection rule for `v*` tags.
- Restrict the `npm` environment to the `main` deployment branch for automatic
  releases and `v*` tags for intentional manual overrides.

GitHub Releases are an after-publish record. They are not a prerequisite for npm
or JSR publishing.
