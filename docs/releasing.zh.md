# 构建与发布

[English](releasing.md) | 中文

仓库包含两条 GitHub Actions 工作流：

- `build.yml` 在 Linux 的 Node 22.19、Node 24，以及 Windows 的 Node 24 上执行完整发布校验；Linux Node 24 job 会把生成的 npm tarball 上传为工作流产物。
- `release.yml` 只接受与 `package.json` 版本完全一致的稳定版 `vX.Y.Z` tag，并要求该提交位于 `main`。它会从锁文件重新安装、构建和测试，把已经校验的同一个 tarball 发布到 npm，再将它附加到自动生成的 GitHub Release。

发布 job 开启 npm provenance，只授予 `contents: write` 和 `id-token: write`；普通构建只有只读权限。

## 本地校验

使用仓库固定的包管理器与锁文件：

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` 会依次执行类型检查、单元测试、生产构建、基于 `npm pack --dry-run` 的文件白名单校验，并生成 `dist/dsh-llm-codex-app-server-X.Y.Z.tgz`。

若要在不修改 registry 的前提下演练 npm publish 生命周期：

```sh
npm publish --dry-run
```

## npm trusted publishing

发布通过 npm trusted publishing 使用 GitHub OIDC 鉴权。npm 包设置必须授权：

- GitHub owner：`wss534857356`
- Repository：`dsh-plugin-codex`
- Workflow filename：`release.yml`
- Allowed action：`npm publish`

发布步骤不能设置 `NODE_AUTH_TOKEN`。空 token 会选择 token 鉴权，阻止 npm 使用 GitHub OIDC 身份。

## 发布新版本

从干净且最新的 `main` 开始。`npm version` 会拒绝脏工作区，更新 `package.json`，创建发布 commit，并创建匹配的 tag。

```sh
git switch main
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run check
npm version patch -m "chore: release v%s"
git push origin main --follow-tags
```

需要时可将 `patch` 换成 `minor` 或 `major`。不要通过这条工作流创建 prerelease tag：校验器有意只接受稳定的 `X.Y.Z` 版本。

推送 tag 后会启动 `release.yml`。tag 与版本不一致、tag 提交不在 `main`、测试失败、运行时入口缺失、tarball 意外包含源码或测试，以及 npm 鉴权失败，都会在创建 GitHub Release 前终止发布。

npm 已发布版本不可覆盖。错误版本应通过新的 patch 版本修复；必要时在 npm 上 deprecate 旧版本，不要尝试覆盖。
