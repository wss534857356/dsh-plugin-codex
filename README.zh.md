# dsh-llm-codex-app-server

[English](README.md) | 中文

`dsh-llm-codex-app-server` 注册一个由本地登录的 Codex App Server 驱动的 DeepSeek Harness 主模型提供方。它是独立于 Harness 主仓库的组合包，因此安装时不会修改 `deepseek-harness` 仓库。

它与 Harness 内置的 `@deepseek-ai/dsh-subagent-codex` 不同。内置包将 Codex 暴露为接受委派的子 agent；本包注册到 `ctx.llm`，因此 Harness Agent loop 可以选择 `codex-local` 作为模型提供方。

## 工作方式

在有界缓存租约有效期间，普通 Harness 会话会复用一个固定版本为 `@openai/codex@0.147.0`、运行于私有空目录中的 App Server 进程和一个临时线程。该进程使用 `CODEX_HOME` 下的原生 Codex 账户状态；插件不会读取、复制、记录或保存 OAuth token 与 API key。没有 Session ID 的请求和辅助请求仍使用一次性进程。

适配器将 Harness 系统文本作为 App Server 的基础指令，通过在空 turn 开始前注入全部已记录的 Harness 消息来重建冷启动线程，在 App Server 的 `deepseek_harness` 命名空间下声明 Harness 工具，并通过原生 turn input 发送后续普通用户消息。外层 Harness 的 `skill` 工具在该命名空间内映射为 `harness_skill`；其参数 schema 只接受当前 Harness Session 目录中的名称，而 Codex 原生 skill 仍由 Codex 自己的 loader 管理。只有完整请求与预期的后续请求完全一致时才会复用热线程，否则会丢弃并重建线程。App Server 仍会加入 Codex 自有的指令和工具。这是有意设计的分层提供方，不是原始模型传输层，也不声称 Harness 取代了 Codex prompt。

推理、Assistant 文本、用量、Codex 自有上下文、诊断信息和动作生命周期会在到达时转换为 Harness 流事件。Codex 缓存输入通过 Harness 的 `cacheReadTokens` 上报，因此标准 token 计量器和会话统计无需提供方专用 UI 即可显示缓存命中率。每个 `codex-action` 块都包含 `category`（`lifecycle`、`context`、`action` 或 `diagnostic`）、解析后的 `phase`、准确的 `protocolEvent` 以及对应的 JSON 协议快照。即使 App Server 没有发出对应的 `ThreadItem`，原始 Code Mode 调用及其结果也会保留。Codex 原生动作失败或被拒绝仍属于动作结果；除非 App Server 报告整个 turn 失败，否则不会导致 Harness 模型请求失败。

在发布流事件之前，插件会解码已完成的 Codex 原生图片输出，并通过 Harness 的持久附件服务提交图片。适配器发出标准 Harness `image` 块供预览和下载，而动作快照与重放状态只保留小型附件标记。冷启动重建会验证附件，并且只在内存中的 App Server 请求内恢复 data URL；热 Session 续接只比较标记，不读取图片。聊天附件不等于隐式修改工作区：要生成 `public/example.png` 或其他项目文件，Codex 仍须为明确的目标路径请求已声明的 Harness 修改工具。

本包还包含浏览器插件。它以较低的 slot 优先级覆盖默认 Assistant 单元格，保留标准文本、推理、图片和通用回退展示，并使用 Harness 的紧凑 disclosure row 与状态点渲染 `codex-action` 块。折叠行显示解析后的动作、类别和阶段；展开后显示摘要、准确的协议事件、动作 ID，以及 Harness JSON tree 中的持久 JSON 记录。`thread/start` 会明确报告分层 prompt 所有权和发现的指令来源数量；它不会被标记为 Harness 工具或请求失败。

`thread/start` 块用于披露提供方生命周期，并不表示模型执行了原生动作。由 Codex 添加、且不属于注入的 Harness 历史记录的 developer、system 和 user 消息会显示为 `context/injected` 报告。它们会被记录以供审计，但不会在下一个无状态请求中作为 Harness 编写的历史内容再次提交。

当 App Server 请求 `deepseek_harness` 命名空间内的已声明工具时，适配器会发出真正的 Harness `tool-call`，结束当前模型 step，并保持 App Server callback 待处理。命名空间和映射后的名称必须同时匹配，调用才能进入 Harness；`harness_skill` 还必须准确匹配当前 Harness 目录中的名称，并且只有验证后才会映射回 `skill`。即使未带命名空间的 Codex 原生调用名称与 Harness 工具相似，它仍属于提供方轨迹；只有经过验证、带 Harness 命名空间的调用才不会显示为原生动作。Harness 负责这些调用的执行、审批、展示和持久记录。后续请求完全匹配时，适配器会用已记录的工具结果回复待处理 callback，并继续同一个 Codex turn；任何不匹配都会触发冷启动重建。

## 安装

先完成一次原生 CLI 登录：

```sh
codex login
```

构建当前工作副本并打包：

```sh
pnpm install
pnpm run check
```

将生成的 tarball 安装到 Harness profile：

```sh
dsh plugin --profile web add ./dist/dsh-llm-codex-app-server-0.1.16.tgz
dsh --profile web --dump-config
dsh --profile web
```

该组合包注册 `codex-local` 提供方，以及固定版本 App Server 默认模型选择器中的所有模型：`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini` 和 `gpt-5.3-codex-spark`。请在 Models UI 中选择模型。安装不会自动替换 profile 的默认模型。标记为隐藏的 App Server 路由不会加入选择器。

Harness profile 设置了 `autoInstallPeers: false`，因此安装时可能报告缺少 peer dependency。启动时，profile 的模块回退机制会从当前 Harness 安装中提供这些 peer，使插件共享相同的 Cordis 和服务实例。

若要从源码安装，请使用 `dsh plugin --profile web add github:<owner>/<repo>#<commit>`。通过 Git 安装时，包的 `prepare` 脚本会构建 TypeScript，因此 pnpm 必须允许该包执行构建。已打包的 tarball 或 npm release 已经完成构建。

从 profile 中移除该组合包：

```sh
dsh plugin --profile web remove dsh-llm-codex-app-server
```

## 配置

后续 profile 补丁层可以替换 `llm-codex-app-server` 配置项。Harness 补丁配置项不会深度合并，因此替换时必须重新写出完整配置。

| 配置键 | 默认值 | 说明 |
|---|---:|---|
| `provider` | `codex-local` | Harness 提供方路由。 |
| `displayName` | `Codex (local login)` | 选择器标签。 |
| `modelProvider` | `openai` | Codex App Server 的模型提供方 ID。 |
| `models` | 7 个可见的 App Server 目录项 | 固定版本 App Server 的建议模型元数据和推理选项。未列出但符合安全格式的模型 ID 仍可路由。 |
| `timeoutMs` | `300000` | 单个 App Server turn 的实际运行时间上限。 |
| `disposeGraceMs` | `3000` | 终止进程树时的宽限时间。 |
| `maxJsonRpcLineBytes` | `4194304` | 单条换行分隔的 App Server JSON-RPC 消息允许的最大字节数。成功解析的消息不会累计到 stdout 总量限制中。 |
| `maxStderrBytes` | `65536` | 保留诊断输出的最大字节数。 |
| `maxRetries` | `0` | Harness 可见的临时进程或提供方错误重试次数。 |
| `maxCachedSessions` | `8` | 按最近最少使用策略驱逐前，可保留的最大空闲或等待工具结果的 Session 租约数。活跃请求可能暂时超过该值。 |
| `sessionIdleTimeoutMs` | `600000` | 已缓存 App Server Session 线程的空闲存活时间。 |
| `env` | `{}` | 叠加到经 Harness 清理的父进程环境之上的显式子进程环境。`CODEX_HOME` 不在标准位置时，请通过此项传入。 |

覆盖配置示例：

```yaml
- id: llm-codex-app-server
  name: dsh-llm-codex-app-server
  config:
    provider: codex-local
    displayName: Codex (local login)
    modelProvider: openai
    models:
      - id: gpt-5.6-sol
        name: GPT-5.6-Sol
        contextWindow: 1050000
        reasoningEfforts: [low, medium, high, xhigh, max, ultra]
        defaultReasoningEffort: low
    timeoutMs: 600000
    disposeGraceMs: 3000
    maxJsonRpcLineBytes: 4194304
    maxStderrBytes: 65536
    maxRetries: 0
    maxCachedSessions: 8
    sessionIdleTimeoutMs: 600000
    env:
      CODEX_HOME: !!js process.env.CODEX_HOME
```

## 兼容性与限制

- 协议基线为 Codex CLI `0.147.0`；由于实验性 App Server 协议对版本敏感，依赖和运行时握手均固定到该版本。
- 默认目录展示每个模型的完整上下文窗口：GPT-5.4、GPT-5.5 和 GPT-5.6 系列为 `1050000`，`gpt-5.4-mini` 为 `400000`，`gpt-5.3-codex-spark` 为 `128000`。固定版本的 App Server 可能在用量通知中报告较小的有效工作窗口。部署环境若强制使用该较小限制，可以覆盖模型元数据；由提供方确认的上下文溢出仍可触发 Harness 压缩和重试。
- 默认模型目录包含固定版本 App Server `0.147.0` 通过 `model/list` 返回的 7 个非隐藏路由。隐藏的工作模式和自动评审路由仍可手动指定，但不会出现在用户选择器中。
- Codex 共同拥有模型可见指令和工具目录。无需密钥的协议测试记录了在应用受支持的线程覆盖配置后仍然存在的额外权限、主 agent、协作、环境、交互和 Code Mode 层。
- Code Mode 保持启用，因为 `gpt-5.6-sol` 使用它分派 App Server 动态工具。Codex 原生图片生成和图片查看同样保持启用，以确保 Codex 的 `imagegen` skill 仍拥有所需工具；其他无关的可选原生集成保持禁用。
- 原生生成图片需要 profile 提供持久 `ctx.attachments` 服务。图片字节受该服务的媒体类型、字节数、数量和像素限制约束，绝不会以内联形式存入 `codex-action` 块或重放状态。
- Codex 原生动作仍可能发生。它们运行在私有空工作目录中，使用只读 sandbox，并将审批策略设为 `never`；其生命周期快照显示为提供方轨迹。除非协议可以在不使用用户权限的情况下回答，否则审批或交互请求会被安全拒绝。
- `thread/start` 生命周期报告会显示发现的指令来源。非空报告属于信息披露，并不代表请求失败。不在该列表中的 Codex 生成上下文会单独显示为 `context/injected`。
- 该提供方只接受文本输入。图片输入会在进程启动前被拒绝。
- 此 App Server 路径没有公开可靠的对应选项，因此会拒绝 `temperature`、`maxTokens` 和 `stop`。依赖 `maxTokens` 的辅助调用（包括由 LLM 生成 Session 标题和 Basic compaction）不能使用该提供方。
- App Server 自动压缩阈值设为 Harness 的安全整数上限，使 Harness 可以优先替换已记录历史。任何原生压缩 item 或通知仍会使实时租约不可复用，并且绝不会写入可重建的重放状态。Basic compaction 必须使用支持其 `maxTokens` 要求的摘要提供方。
- `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=deepseek-harness` 用于标识适配器请求；升级 Codex 时会重新验证这一内部兼容点。
- Session 级线程属于内存中的可丢弃缓存。进程重启、插件重载、过期、驱逐、压缩、fork、修复、重试不匹配或请求 epoch 发生任何变化后，Harness 日志与适配器重放状态会重建模型可见历史；不会恢复 Codex rollout 文件。
- 重放状态版本 `4` 的 `items` 只包含提供方输出；观测到的 Codex 自有上下文单独保存在 `contextItems` 中供审计，绝不会重新注入。原生图片输出使用持久附件标记，并且只在冷启动 App Server 注入时恢复。重建时，Harness 调用会保留其 `deepseek_harness` 命名空间和映射后的 App Server 名称。重建逻辑按稳定的提供方 item 或调用标识合并累积快照，因此旧版插件写入的 Session 不会在后续请求中不断复制相同的不透明输出。更旧的重放版本会回退到 Harness 消息重建。
- 身份验证和订阅可用性由原生 Codex 安装负责。登录失败会显示为 Harness `AUTH` 错误；本插件不提供凭据 UI。

## 开发

[ADR 0001](docs/adr/0001-use-app-server-as-a-harness-owned-transport.md) 根据 [提供方调查](docs/app-server-provider-plan.md) 捕获的出站请求中 Codex 自有指令与工具，否决了原始传输层方案。[ADR 0002](docs/adr/0002-use-app-server-as-a-layered-codex-provider.md) 接受当前实现的所有权划分。[ADR 0003](docs/adr/0003-separate-codex-trajectory-from-harness-tools-and-replay.md) 记录原始动作、提供方上下文、重放和 Harness 工具调用如何保持相互独立。[ADR 0004](docs/adr/0004-render-codex-trajectory-in-the-browser-plugin.md) 记录独立组合包使用的客户端渲染器覆盖层。[ADR 0005](docs/adr/0005-coalesce-stateless-codex-replay.md) 按提供方标识约束冷启动重放重建。[ADR 0006](docs/adr/0006-reuse-disposable-session-threads.md) 定义精确的 Session 续接和可丢弃缓存所有权。[ADR 0007](docs/adr/0007-namespace-harness-dynamic-tools.md) 将 App Server 命名空间定义为工具所有权标签。[ADR 0008](docs/adr/0008-retain-native-image-tools.md) 保留 Codex 图片 skill 所需的原生图片工具。[ADR 0009](docs/adr/0009-externalize-native-generated-images.md) 记录持久图片投影与重放恢复。

```sh
pnpm run typecheck
pnpm run test
pnpm run build
pnpm pack --pack-destination dist
```

单元测试和协议测试无需账户。完成 `codex login` 后，可运行真实的本地登录往返测试：

```sh
pnpm run test:e2e
```

真实测试会加载 Harness LLM 和本地 subprocess 提供方，在同一个已缓存 App Server 线程上完成一次 Harness 工具往返和一次普通后续请求，要求提供方缓存读取量非零，并验证插件 dispose 后进程树已完全退出。
