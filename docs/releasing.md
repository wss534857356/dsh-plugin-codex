# Build and release

English | [中文](releasing.zh.md)

The repository has two GitHub Actions workflows:

- `build.yml` runs the complete release verification on Node 22.19 and Node 24 on Linux, plus Node 24 on Windows. The Linux Node 24 job uploads the resulting npm tarball as a workflow artifact.
- `release.yml` accepts only a stable `vX.Y.Z` tag whose version exactly matches `package.json`, requires that commit to be on `main`, rebuilds and tests from the lockfile, publishes the verified tarball to npm, and attaches that same tarball to a generated GitHub release.

The release job uses npm provenance and grants only `contents: write` and `id-token: write`. Normal builds are read-only.

## Local verification

Use the pinned package manager and lockfile:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` runs type checking, unit tests, production builds, an allowlist check over `npm pack --dry-run`, and creates `dist/dsh-llm-codex-app-server-X.Y.Z.tgz`.

To exercise the npm publish lifecycle without changing the registry:

```sh
npm publish --dry-run
```

## First npm publication

The package does not exist on npm until the first release, so npm trusted publishing cannot be attached to it yet. npm also requires account-level two-factor authentication before a maintainer can establish a trusted publisher. Bootstrap it once through the release workflow:

1. Enable two-factor authentication on the publishing npm account.
2. Create a short-lived granular npm token with package read/write permission and **Bypass 2FA** enabled.
3. Add it to the GitHub repository as an Actions secret named `NPM_TOKEN`.
4. Prepare and push the first version tag using the procedure below.
5. After the package exists, open its npm settings and configure the trusted publisher with:
   - GitHub owner: `wss534857356`
   - Repository: `dsh-plugin-codex`
   - Workflow filename: `release.yml`
   - Allowed action: `npm publish`
6. Remove the `NPM_TOKEN` repository secret and revoke the bootstrap token. Future releases authenticate with short-lived GitHub OIDC credentials.

The workflow deliberately keeps the optional `NPM_TOKEN` environment bridge so the first publication can use the secret and later publications can use OIDC without changing repository code.

## Cut a release

Start from a clean, current `main` branch. `npm version` refuses a dirty worktree, updates `package.json`, creates the release commit, and creates the matching tag.

```sh
git switch main
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run check
npm version patch -m "chore: release v%s"
git push origin main --follow-tags
```

Use `minor` or `major` instead of `patch` when required. Do not create prerelease tags with this workflow: its guard intentionally accepts stable `X.Y.Z` versions only.

The tag push starts `release.yml`. A tag/version mismatch, a tag outside `main`, a failed test, a missing runtime entry, an unexpected source/test file in the tarball, or an npm authentication failure stops the release before the GitHub release is created.

Published npm versions are immutable. Fix a bad release with a new patch version; deprecate the old version in npm when necessary rather than trying to overwrite it.
