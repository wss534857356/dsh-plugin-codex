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

## npm trusted publishing

Releases authenticate through npm trusted publishing with GitHub OIDC. The package's npm settings must authorize:

- GitHub owner: `wss534857356`
- Repository: `dsh-plugin-codex`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`

The publish step must not set `NODE_AUTH_TOKEN`. An empty token selects token authentication and prevents npm from using the GitHub OIDC identity.

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
