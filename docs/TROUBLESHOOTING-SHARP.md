# Troubleshooting: Sharp Native Module Issues

## Problem

When installing dependencies with pnpm, the `sharp` image processing library may fail to build correctly, resulting in errors like:

```
Cannot find module '../build/Release/sharp-darwin-arm64v8.node'
```

Or:

```
Error: Something went wrong installing the "sharp" module
```

## Root Cause

**pnpm's strict security model** blocks build scripts by default to prevent potentially malicious code from running during installation. Sharp requires native binaries that need to be downloaded/built during installation, but pnpm blocks this by default.

## Solution

### Option 1: Manual Native Binary Installation (Quick Fix)

Navigate to sharp's directory and manually install the native binary:

```bash
cd node_modules/sharp
npm install --platform=darwin --arch=arm64
cd ../..
```

**For other platforms:**

- Linux (x64): `--platform=linux --arch=x64`
- Linux (ARM): `--platform=linux --arch=arm64`
- Windows (x64): `--platform=win32 --arch=x64`

### Option 2: Approve Sharp's Build Scripts (Recommended)

Allow pnpm to run sharp's build scripts:

```bash
pnpm approve-builds sharp
pnpm install
```

This tells pnpm that you trust sharp's build scripts.

**Check approved builds:**
```bash
pnpm config get approve-builds
```

### Option 3: Disable Build Script Restrictions (Not Recommended)

Disable pnpm's build script protection entirely:

```bash
pnpm config set enable-scripts true
pnpm install
```

⚠️ **Warning**: This reduces security by allowing all packages to run build scripts.

### Option 4: Use Different Package Manager

If sharp continues to cause issues, switch to npm or yarn temporarily:

```bash
npm install
```

Or:

```bash
yarn install
```

## Verification

After applying a fix, verify sharp works:

```bash
node -e "require('sharp')"
```

No output = success. Error = still broken.

## Prevention

### For Project Maintainers

**Add to `.npmrc`** (project root):

```
shamefully-hoist=true
enable-scripts=true
```

This allows build scripts for all contributors.

**Or use `.pnpmrc`:**

```
enable-scripts=true
auto-install-peers=true
```

**Or specify approved packages in `package.json`:**

```json
{
  "pnpm": {
    "allowedBuilds": ["sharp", "@xenova/transformers"]
  }
}
```

### For Contributors

Run after cloning:

```bash
pnpm approve-builds sharp
pnpm install
```

## Related Issues

This same issue can affect other native Node modules:

- `@xenova/transformers` (uses ONNX runtime)
- `canvas` (Cairo graphics)
- `sqlite3` (SQLite bindings)
- `bcrypt` (encryption)

Apply the same solutions for these packages.

## Why This Happens

1. **pnpm's security model**: Blocks build scripts by default
2. **Native modules**: Require platform-specific binaries
3. **Sharp's installation**: Downloads pre-built binaries via postinstall script
4. **Script blocked**: pnpm prevents the download, leaving sharp without binaries

## Additional Resources

- [pnpm build scripts documentation](https://pnpm.io/cli/install#--enable-scripts)
- [Sharp installation docs](https://sharp.pixelplumbing.com/install)
- [GitHub Issue: pnpm + sharp](https://github.com/lovell/sharp/issues/2655)

## Quick Reference

| Error | Solution |
|-------|----------|
| `Cannot find module 'sharp-*.node'` | Run Option 1 or 2 above |
| `Error installing sharp module` | Approve build scripts |
| `sharp not found` | Reinstall with approved builds |
| Build succeeds but still fails | Delete node_modules, reinstall with `enable-scripts=true` |

---

**Created**: 2025-01-14
**Last Updated**: 2025-01-14
**Affects**: pnpm users on all platforms
