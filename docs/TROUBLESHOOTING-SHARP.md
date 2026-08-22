# Troubleshooting: Transitive `sharp` Install Errors

`libsql-search` does not directly depend on `sharp`. If you see an install error
mentioning `sharp`, it is coming from another dependency in your application or
toolchain.

This page exists because the error can show up in environments that also use
`libsql-search`, and it is easy to misattribute the failure to this package.

## Typical Error

```text
Cannot find module '../build/Release/sharp-*.node'
```

Or:

```text
Error: Something went wrong installing the "sharp" module
```

## Why It Happens

With pnpm, native packages may need explicit build-script approval. If the
relevant install script is blocked, the native binary is never downloaded or
built.

## What To Do

First inspect which build scripts pnpm blocked:

```bash
pnpm ignored-builds
```

Then approve the package that is actually failing and reinstall:

```bash
pnpm approve-builds
pnpm install
```

In the interactive `pnpm approve-builds` prompt, select `sharp` if that is the
package reporting the native-module failure.

For a committed repository-level fix, you can also allow the package explicitly
in `pnpm-workspace.yaml` with `onlyBuiltDependencies`.

## Relation To `libsql-search`

- local embeddings use `@xenova/transformers`
- the first local embedding run may download a model at runtime
- that runtime model download is separate from a pnpm native-module install
  failure

## Verification

After reinstalling, rerun the command that originally failed. If your app uses
`sharp` directly, verify that import in your own project context.

## Additional Resources

- [pnpm approve-builds](https://pnpm.io/10.x/cli/approve-builds)
- [Sharp installation docs](https://sharp.pixelplumbing.com/install)
