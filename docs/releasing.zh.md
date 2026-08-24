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

## 第一次发布到 npm

首次发布前 npm 上还没有这个包，因此暂时无法为它绑定 trusted publisher。npm 还要求维护者先为账户启用双重身份验证，才能建立 trusted publisher。需要通过 release 工作流引导一次：

1. 为执行发布的 npm 账户启用双重身份验证。
2. 创建一个具有 package 读写权限、开启 **Bypass 2FA** 且短期有效的 granular npm token。
3. 在 GitHub 仓库中添加名为 `NPM_TOKEN` 的 Actions secret。
4. 按下一节的步骤准备并推送第一个版本 tag。
5. npm 包创建成功后，进入其 npm 设置，配置 trusted publisher：
   - GitHub owner：`wss534857356`
   - Repository：`dsh-plugin-codex`
   - Workflow filename：`release.yml`
   - Allowed action：`npm publish`
6. 删除 GitHub 仓库中的 `NPM_TOKEN` secret，并撤销首发 token；后续发布将改用 GitHub OIDC 的短期凭证。

工作流刻意保留可选的 `NPM_TOKEN` 环境桥接，因此首发可以使用 secret，切换 OIDC 后无需再次修改仓库代码。

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
