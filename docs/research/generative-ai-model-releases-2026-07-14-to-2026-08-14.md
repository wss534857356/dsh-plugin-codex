# 2026-07-14 至 2026-08-14 全球主流生成式 AI / 基础模型发布核查

- **核查截止：** 2026-08-14（Asia/Shanghai）
- **时间窗：** 2026-07-14 00:00:00 至 2026-08-14 23:59:59（Asia/Shanghai）
- **纳入口径：** 厂商正式发布或正式上线；属于全新模型、重大版本或模型级重要预览/可用性更新；且厂商一手页面能够确认精确发布日期。
- **排除：** 纯功能/UI/套餐更新、合作伙伴转售、第三方报道、传闻，以及无法从一手页面核验精确日期的候选项。

## 结论

**本轮确认 1 项符合条件的重大版本：DeepSeek‑V4‑Pro 正式版，官方发布日期 2026-08-13。**

本次短收尾重点复核 Kimi K3、Qwen3.8-Max、DeepSeek V4 Pro。前两项虽能找到官方侧名称或仓库痕迹，但未能从厂商正式发布页核验精确发布日期，因此明确不纳入；DeepSeek 官方 API 文档提供带日期的正式版发布页，予以纳入。

## 合格发布清单

| 日期 | 厂商 | 模型 | 分类 | 官方一手来源 |
|---|---|---|---|---|
| 2026-08-13 | DeepSeek | DeepSeek‑V4‑Pro 正式版 | 重大版本/正式可用性更新 | [DeepSeek‑V4‑Pro 正式版上线](https://api-docs.deepseek.com/zh-cn/news/news260813/)（同页英文版：[GA Release](https://api-docs.deepseek.com/news/news260813/)） |

## 三项重点复核

| 候选 | 官方证据 | 结论 |
|---|---|---|
| Kimi K3 | [MoonshotAI/Kimi-K3 官方 GitHub 仓库](https://github.com/MoonshotAI/Kimi-K3) | 官方仓库存在，但本轮无法从官方发布页或模型卡确认精确发布日期；**无法核验，不纳入**。 |
| Qwen3.8-Max | 官方 Qwen Code 文档中可见该名称：[案例页](https://qwenlm.github.io/qwen-code-docs/zh/blog/cases/qwencode-bailian-skill-openai-cover-gen/)；另见官方仓库相关 [PR #8974](https://github.com/QwenLM/qwen-code/pull/8974) | 这些页面不是可确认精确发布日期的正式模型发布公告；**无法核验，不纳入**。 |
| DeepSeek V4 Pro | [DeepSeek‑V4‑Pro 正式版上线](https://api-docs.deepseek.com/zh-cn/news/news260813/) | 官方发布页明确为正式版，页面编号及官方更新记录对应 **2026-08-13**；落入时间窗，纳入。 |

## 官方候选页（不计入清单）

| 厂商 | 候选模型/内容 | 暂定类别 | 官方一手链接 | 未纳入原因 |
|---|---|---|---|---|
| OpenAI | GPT-5.6 | 重大版本候选 | [Advancing the price-performance frontier with GPT-5.6](https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/) | 未能从官方页面正文核验精确发布日期 |
| Anthropic | Claude Opus 5 | 重大版本候选 | [Introducing Claude Opus 5](https://www.anthropic.com/news/claude-opus-5) | 未能从官方页面正文核验精确发布日期 |
| Anthropic | Claude Sonnet 5 | 重大版本候选 | [Introducing Claude Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5) | 未能从官方页面正文核验精确发布日期及窗口归属 |
| Google | Gemini Omni 相关内容 | 发布性质待判定 | [Gemini Omni experts roundtable](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-omni-experts-roundtable/) | 未核验日期，且标题本身不足以证明是正式模型发布 |
| xAI | Grok 4.5 | 重大版本候选 | [Grok 4.5 everywhere](https://x.ai/news/grok-4-5-everywhere) | 未能从官方页面正文核验精确发布日期 |

## 指定厂商逐项状态

“未找到官方确认”表示本轮没有取得符合严格证据门槛的记录，**不表示已经证明该厂商绝无发布**。

| 厂商 | 本轮状态 | 官方核查入口 |
|---|---|---|
| OpenAI | 未找到可同时核验精确日期与窗口归属的合格记录；GPT-5.6 为待核验候选 | [OpenAI News](https://openai.com/news/) |
| Anthropic | 未找到可同时核验精确日期与窗口归属的合格记录；Opus 5、Sonnet 5 为待核验候选 | [Anthropic Newsroom](https://www.anthropic.com/news) |
| Google / DeepMind | 未找到官方确认的合格记录；Gemini Omni 页面为待判定候选 | [Google DeepMind Blog](https://deepmind.google/discover/blog/) |
| Meta | 未找到官方确认的窗口内合格记录 | [Meta AI Blog](https://ai.meta.com/blog/) |
| xAI | 未找到可核验精确日期的合格记录；Grok 4.5 为待核验候选 | [xAI News](https://x.ai/news) |
| DeepSeek | **确认 DeepSeek‑V4‑Pro 正式版于 2026-08-13 发布** | [官方发布页](https://api-docs.deepseek.com/zh-cn/news/news260813/) |
| 阿里 Qwen | Qwen3.8-Max 无可核验精确发布日期的官方正式发布页，**无法核验，不纳入**；其余未找到官方确认的窗口内新模型 | [Qwen Blog](https://qwenlm.github.io/blog/)、[QwenLM GitHub](https://github.com/QwenLM) |
| 月之暗面 Kimi | Kimi K3 官方仓库存在但无法核验精确发布日期，**无法核验，不纳入**；其余未找到官方确认的窗口内新模型 | [Kimi-K3 官方仓库](https://github.com/MoonshotAI/Kimi-K3) |
| 智谱 GLM | 未找到官方确认的窗口内合格记录 | [Z.ai](https://z.ai/)、[Z.ai GitHub](https://github.com/zai-org) |
| MiniMax | 未找到官方确认的窗口内合格记录 | [MiniMax News](https://www.minimax.io/news)、[MiniMax API Docs](https://platform.minimax.io/docs/) |
| Mistral | 未找到官方确认的窗口内合格记录 | [Mistral News](https://mistral.ai/news) |

## 方法与证据纪律

1. 以官方博客、官方文档、官方模型卡、官方 GitHub/发布页为最终证据。
2. 搜索引擎与第三方报道仅用于发现候选项，不用于确认发布日期。
3. 精确日期若只出现在二手页面，而官方一手页面日期无法读取或确认，则不纳入。
4. 官方页面标题只证明页面存在；不能单凭标题证明发布日期、正式上线状态或窗口归属。
5. “无发布”是很强的否定命题。由于动态归档、地区站点和未索引模型卡无法在本轮穷尽，本文只报告“未找到官方确认”，不作绝对断言。
6. 若后续能直接读取上述官方页面的日期元数据或正文日期，应据此复核并将合格候选移入正式清单。

## 分类结果

- **全新模型：** 0 项已核验。
- **重大版本：** 1 项已核验：DeepSeek‑V4‑Pro（2026-08-13）；GPT-5.6、Claude Opus 5、Claude Sonnet 5、Grok 4.5、Kimi K3、Qwen3.8-Max 均因精确日期未核验而不纳入。
- **预览/可用性更新：** 0 项已核验。
