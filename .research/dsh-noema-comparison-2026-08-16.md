# DSH Noema 与 MistyMoon 记忆实现比较（2026-08-16）

## 结论

**现在不应把 MistyMoon 的记忆插件整体替换成 dsh-noema。** 更合适的方向是：保留 MistyMoon 的 RP 记忆治理、DSH 原生自动召回投影、消息来源追踪与未来通道身份层；把 Noema 作为一个实验性的可选存储/检索 Provider，或先移植它的冲突处理、文件锁、原子写入、BM25/PageIndex/图召回和可解释检索思想。

这不是对 Noema 引擎能力的否定。Noema 的检索、冲突治理、并发耐久性和可检查存储明显强于 MistyMoon 当前的最小实现；但当前 dsh-noema 适配层依赖模型自行调用 `noema_recall`，默认自动批准 `noema_remember`，把所有写入固定为单用户 `User/Preference/Internal`，没有保存 DSH `sourceMessageId`，也没有把自动召回结果通过 MistyMoon 现有的 `agent/pre-step` 日志路径注入模型。因此直接替换会在 RP 连续性、主人审核、保密级别和可重放性上发生倒退。[DSH 工具与默认批准](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/tools.ts#L39-L176)；[仅提示模型主动召回](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/guidance.ts#L18-L35)；[MCP 固定写入字段](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-mcp/src/lib.rs#L402-L449)；[MistyMoon 自动召回及 DSH 消息投影](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/packages/memory/src/index.ts#L1011-L1053)

建议决策：

- **wholesale replacement：否。** 当前不满足等价替换条件。
- **optional provider：是，但应先做适配层和 shadow mode。** 不直接同时挂载两套面向模型的写入工具。
- **borrow concepts：立即可做。** 优先移植冲突检测、原子写入/文件锁、召回解释和检索融合。
- **直接依赖稳定性：谨慎。** dsh-noema 与 Noema 都处于 RC/early implementation，接口和磁盘格式尚无稳定承诺。[dsh-noema 版本](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/package.json#L1-L20)；[Noema 项目状态](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/README.md#L38-L42)

## 审计基线

- dsh-noema 固定到 `acfb4cd58c9486412fb3bfc9e978eae66e04e5a7`（2026-08-15）。其 `noema/` gitlink 固定 Noema 到 `92f558385ad17f9399380df212c492d3ee82d5f0`。[dsh-noema 固定提交](https://github.com/ZSeven-W/dsh-noema/tree/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7)；[Noema 固定提交](https://github.com/ZSeven-W/noema/tree/92f558385ad17f9399380df212c492d3ee82d5f0)
- MistyMoon 基线为 `f5208537355b3ba12bfb5174dec0ec3ed40227d6`，公开版本 `0.0.1-rc1`。[MistyMoon 固定提交](https://github.com/mianyoubiaoqing/MistyMoon-DSH/tree/f5208537355b3ba12bfb5174dec0ec3ed40227d6)；[MistyMoon manifest](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/package.json#L1-L18)
- 本报告区分“dsh-noema 的 DSH 适配层”和“其 Rust Noema 子模块”。很多强能力位于 Rust 引擎中，但没有全部暴露给 DSH。

## 架构与 DSH 集成

```text
DSH
└─ @zseven-w/dsh-noema（TypeScript/Cordis 插件）
   ├─ 15 个 DSH tools
   ├─ systemPrompt 使用说明
   ├─ loopback-only 设置/管理页面
   ├─ 外部记忆文件导入器
   └─ 子进程管理器 → stdio MCP → noema-mcp（Rust）
                                └─ noema-core 文件存储/检索/治理
```

dsh-noema 是标准外置 DSH bundle：`cordis.patch.yml` 只插入 `@zseven-w/dsh-noema`，插件通过 DSH 的 tools、settings、system-prompt 和 webserver peer API 接入；没有修改 deepseek-harness 源码。[bundle patch](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/cordis.patch.yml#L1-L6)；[插件入口](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/index.ts#L69-L141)；[DSH peer 依赖](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/package.json#L73-L85)

它自己实现了 MCP stdio 客户端并直接使用 Node `spawn` 启动 Rust 二进制，而不是通过 DSH subprocess capability；这会增加一个独立生命周期、权限和诊断面。[直接 spawn](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/mcp-stdio.ts#L172-L181)；[保活与重启](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/server-manager.ts#L111-L145)

兼容性以 DSH `0.1.0-rc.6` 为中心，peer dependency 指向 rc.6；Node engine 是 `>=24.11.0`，比 DSH 本身支持的 Node 22 范围更窄。[版本与 engine](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/package.json#L18-L20)；[peer dependencies](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/package.json#L73-L85)

## 捕获、写入、召回与会话日志

### dsh-noema / Noema

- **捕获不是自动会话抽取。** DSH 适配层注册工具，并在系统提示词里要求模型在会话开始调用 `noema_recall`、遇到稳定事实时调用 `noema_remember`；源码没有 `agent/pre-step` 或 post-response 监听器。[工具注册](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/index.ts#L92-L107)；[引导文本](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/guidance.ts#L18-L35)
- **默认会立即批准。** 插件的 `acceptByDefault` 默认是 `true`，并把缺省 `accept` 注入 `noema_remember`；Rust MCP 也用 `args.accept.unwrap_or(true)`。这与 Noema core 默认 `WritePolicy::Review` 以及 MistyMoon“推断记忆必须主人批准”的产品规则不一致。[插件默认值](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/settings.ts#L56-L75)；[MCP 自动批准](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-mcp/src/lib.rs#L402-L449)；[core 默认 Review](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/config.rs#L55-L74)
- **召回内容只有在工具被实际调用时才进入 DSH 工具调用/结果记录。** 插件没有创建额外 DSH `user/message` 的自动召回快照；因此它不能保证每个请求都召回，也没有 MistyMoon 当前“模型可见文本等于会话可重建文本”的主动保证。这一点是对上述源码缺少 pre-step 投影的架构推断，不是 Noema README 的明示承诺。
- **写入来源不能追溯到 DSH 消息。** MCP 参数没有 `sourceMessageId`，且候选默认来源构造为 `noema-cli`；DSH tool call 自身虽可在会话里审计，但 Noema 记录无法从存储记录反查准确 DSH 来源消息。[MCP RememberArgs](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-mcp/src/lib.rs#L111-L133)；[候选默认 source](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/hippocampus.rs#L45-L75)

### MistyMoon

MistyMoon 在 `agent/pre-step` 中读取用户消息，自动处理明确的“记住”请求，按当前用户消息查询已批准记忆，并追加 `source.kind=plugin` 的 DSH `user/message` 快照；每条记忆保留 `sourceMessageId`，候选批准还保留 `sourceCandidateId`。[消息与候选字段](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/packages/memory/src/index.ts#L41-L80)；[pre-step 投影](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/packages/memory/src/index.ts#L1011-L1053)

因此，**Noema 可以替代检索内核，但当前 dsh-noema 不能直接替代 MistyMoon 的 DSH 投影与来源治理层。**

## 存储、检索与治理能力

| 维度 | dsh-noema / Noema | MistyMoon 当前实现 | 判断 |
| --- | --- | --- | --- |
| 热存储 | 每条记忆是带 JSON frontmatter 的 Markdown；候选/决策/审计为 JSONL；按 tenant/user/project 分目录。[记录字段](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/memory.rs#L216-L263) | 单一私有 append-only JSONL。[类型与 path](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/packages/memory/src/index.ts#L25-L58) | Noema 更易人工检查和局部恢复。 |
| 并发/崩溃 | tenant 文件锁、临时文件、`sync_all`、原子 rename；候选 vacuum 也锁住 read-rewrite 周期。[原子写](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/lock.rs#L41-L64)；[vacuum](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/vacuum.rs#L8-L54) | 单进程 Promise 写串行；多个进程共写同一 JSONL 没有跨进程锁。[写队列](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/packages/memory/src/index.ts#L317-L329) | Noema 显著更强，值得优先借鉴。 |
| 召回 | BM25/词法、PageIndex、图扩展，用 RRF 融合；有 explain、预算填充、使用次数和最近使用时间更新。[fusion recall](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/fusion.rs#L39-L105)；[recall 与使用更新](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/api/mod.rs#L78-L151) | 小写词/中文 bigram 重叠分数，按分数和时间排序。[词法实现](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/packages/memory/src/index.ts#L299-L316) | Noema 显著更强，尤其适合长期增长。 |
| 中英文实体 | jieba/CJK 与实体/主题 PageIndex，固定提交包含相应实现。[文本分析模块](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/text.rs)；[PageIndex](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/pageindex.rs) | 中文 bigram，无实体目录。 | Noema 更适合雾月中文 RP，但需 RP 实际语料评测。 |
| 候选审核 | accept/reject/edit/merge，write policy；冲突和近重复会转人工审核。[路由规则](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/review.rs#L10-L67) | propose/list/approve/reject；尚无 edit/merge/冲突检测。[候选接口](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/packages/memory/src/index.ts#L127-L155) | Noema 更成熟；但 dsh-noema 默认自动批准削弱了优势。 |
| 冲突更新 | 接受冲突候选时 tombstone 旧记忆，并在新记忆加入 `supersedes` link。[接受与 supersedes](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/api/mod.rs#L839-L898) | 只有用户明确 `memory_replace`，自动冲突检测在 P0 待办。[P0 路线](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/README.md#L161-L171) | 最值得移植的能力之一。 |
| 删除 | tombstone 或 hard erase，含 principal 修改检查。[forget](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/api/mod.rs#L684-L714) | append-only forgotten/superseded，默认可恢复；没有硬删除工具。 | Noema 能满足永久删除，但 MistyMoon 必须继续要求人工确认。 |
| 审计 | 独立 payload-free audit event，不写 memory body。[AuditEvent](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/audit.rs#L31-L84) | 记忆 JSONL 本身含内容和来源，历史可重放。 | 两者可组合：Noema 操作审计 + Misty 来源映射。 |
| 管理 UI | 设置页能搜索、catalog/browse、添加、审核、删除和改配置；接口只允许 loopback + same-origin。[路由安全](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/status-route.ts#L42-L111)；[管理操作](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/status-route.ts#L224-L301) | 当前设置页有候选批准/拒绝，完整搜索、批量和来源查看仍是 P0。[路线](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/README.md#L161-L171) | Noema UI 可参考，但不应直接取代 RP 管理页。 |
| 导入 | 9 种编码 Agent 的 Markdown/rules 导入，按 path+heading+body hash 账本去重，并强制 `accept:true`。[导入与账本](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/import-service.ts#L112-L153)；[导入提交](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/import-service.ts#L250-L326) | 只读迁移旧 MistyMoon SQLite 的 confirmed 记录，按来源幂等；不迁移人格/会话/向量等。[迁移说明](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/README.md#L41-L48) | Noema 覆盖广，但没有 MistyMoon JSONL/SQLite 适配，也不应默认批准外部文件。 |
| 整合/衰减/归档 | 数据模型有 Cortex/Deep/Tombstone，vacuum 已实现；但当前 CLI `sleep` 只扫描/报告 extraction jobs，offload/restore 分支只输出完成文本，DSH MCP 也未暴露这些命令。[CLI 现状](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-cli/src/main.rs#L323-L395) | P0 待办。 | 不能把 Noema README 的完整生命周期图视为已可替代功能。 |
| 格式迁移 | `schema_version=1`，但固定提交未发现版本迁移执行器；项目明确格式可能变化。[schema version](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/memory.rs#L1-L9)；[不稳定声明](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/README.md#L38-L42) | 解析器严格要求 v1，迁移/损坏恢复仍是 P0。 | 两边都未达到长期格式承诺。 |

## 身份、跨会话与多租户边界

Noema core 的记录包含 tenant、owner、scope、project/team、ACL、sensitivity 和 recall policy，且召回/修改会检查 principal；这套领域模型比 MistyMoon 当前的 `personal/confidential` 丰富。[MemoryRecord 字段](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/memory.rs#L216-L263)；[修改授权](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/api/mod.rs#L1258-L1277)

但 dsh-noema 使用 stdio MCP 时没有请求级 principal，MCP 会退回配置中的 default principal；`noema_remember` 又固定 `Scope::User`、`project_path:null`、`MemoryKind::Preference`、`SensitivityLevel::Internal`。所以当前 DSH 插件实际仍是单租户/单主人存储，不能直接解决未来 QQ、手机端、熟人/陌生人隔离，也不能保真迁移 MistyMoon 的 `confidential` 记忆。[principal fallback](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-mcp/src/lib.rs#L167-L202)；[固定写入字段](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-mcp/src/lib.rs#L402-L449)

**推断：** Noema core 的多租户模型未来可成为 MistyMoon channel identity 的后端，但需要新的 DSH Provider 把“当前会话已认证身份”显式转换成 Noema principal；现有 dsh-noema stdio 适配层做不到这一点。

## 安全与隐私

- Noema 默认本地文件、无向量/embedding、无需外部 LLM Provider；召回是确定性的词法/PageIndex/图融合。[Noema 设计声明](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/README.md#L107-L119)
- core 会把 secret 拒绝在审核前，并按 clearance、recall policy、ACL 过滤；审计不存 payload。[候选路由](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/review.rs#L16-L45)；[安全说明](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/README.md#L341-L357)
- dsh-noema 的管理 HTTP 路由有 loopback、Host、Origin/Sec-Fetch-Site 与 JSON content-type 检查，优于普通无保护本机接口。[路由实现](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/status-route.ts#L42-L111)
- 风险：`noema_import` 是模型可调用工具，允许给定任意 `path` 作为工作区根并直接读取固定名称文件/规则目录，读取没有走 DSH fs policy；服务器进程也直接 `spawn`，没有走 DSH subprocess policy。这不是远程数据外传，但扩大了插件自身的本机文件与进程权限。[workspace path](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/tools.ts#L163-L243)；[直接文件读取](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/import-service.ts#L154-L224)；[直接 spawn](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/mcp-stdio.ts#L172-L181)
- 风险：默认 `acceptByDefault:true` 和导入强制 `accept:true` 会绕开 MistyMoon 的“推断/外部内容先审核”规则。[默认设置](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/settings.ts#L56-L75)；[导入写入](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/import-service.ts#L284-L301)

## Windows 与运行成熟度

固定版本发布了 Windows x64/arm64 可选原生包，发布工作流在六个平台构建并运行真实 bundled MCP e2e；`v0.1.0-rc.1` 的 Windows x64 与 arm64 release job 均成功。[平台表](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/platforms.json#L41-L58)；[release workflow](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/.github/workflows/release.yml#L76-L124)；[成功发布运行](https://github.com/ZSeven-W/dsh-noema/actions/runs/31806367678)

本机验证（Windows x64、Node 24.14.0，2026-08-16）：

- 从 npm 官方 tarball 取出的 `noema-mcp.exe` 通过 dsh-noema 的真实 `remember → recall` e2e（1/1）。
- `pnpm test` 为 28 项：21 通过、6 失败、1 跳过。失败包括 POSIX 路径断言/fixture、含空格的 `C:\Program Files\nodejs\node.exe` 自定义命令被错误分词，以及两个 keep-alive 测试由该命令问题连带失败。当前主分支 CI 只在 Ubuntu 跑完整 JS 和 Rust tests，所以不会发现这些 Windows 全套测试失败。[check workflow](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/.github/workflows/check.yml#L20-L65)；[命令分词实现](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/server-manager.ts#L31-L86)
- 本机没有 `HOME` 环境变量。Noema core 在未设置 `NOEMA_ROOT` 时只读取 `HOME`，缺失则退回 `.`；实测默认会在子进程 cwd 创建 `.agent-memory`，而不是 Windows 用户目录。dsh-noema 默认 `noemaRoot:''`，因此 MistyMoon 集成必须显式设置 `$DSH_HOME/mistymoon/memory/noema`。[Noema default_root](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/config.rs#L103-L109)；[插件默认 noemaRoot](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/src/settings.ts#L56-L75)

当前 dsh-noema 主分支的 Ubuntu `Plugin check` 成功；本机没有 Rust toolchain，因此未重复运行 core/mcp Rust tests。[当前 CI](https://github.com/ZSeven-W/dsh-noema/actions/runs/31868574300)

## 许可证判断

dsh-noema 根包有完整 MIT LICENSE，package manifest 也声明 MIT；与 MistyMoon 的 MIT 项目原则上兼容。[LICENSE](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/LICENSE)；[manifest](https://github.com/ZSeven-W/dsh-noema/blob/acfb4cd58c9486412fb3bfc9e978eae66e04e5a7/package.json#L1-L16)

底层 Noema 的 Cargo workspace 声明 `license = "MIT"`，但固定提交的仓库树中没有独立顶层 `LICENSE` 文件。由于 dsh-noema 发布的二进制来自该子模块，若 MistyMoon 只是通过 npm 依赖使用，保留依赖包自带 LICENSE 的风险较低；若要 fork、vendor Rust 源码或把二进制重新装入 MistyMoon 安装器，应先让上游补充明确的 Noema LICENSE/NOTICE，并保留版权声明。[Cargo license metadata](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/Cargo.toml#L1-L13)；[固定提交完整 tree API](https://api.github.com/repos/ZSeven-W/noema/git/trees/92f558385ad17f9399380df212c492d3ee82d5f0?recursive=1)

以上是工程许可证风险评估，不是正式法律意见。

## 可取之处及优先级

### 建议直接移植或复用

1. **冲突/近重复进入审核，批准新事实时 tombstone 旧事实并写 supersedes。** 直接补齐 MistyMoon P0 冲突检测。[冲突路由](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/review.rs#L16-L67)；[supersedes](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/api/mod.rs#L839-L898)
2. **文件锁 + 原子写 + fsync。** 当前 MistyMoon 的进程内 Promise 队列不能防两个 DSH/桌面进程并发写。[Noema 原子写](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/lock.rs#L41-L64)；[MistyMoon 写队列](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/packages/memory/src/index.ts#L317-L329)
3. **可解释的混合召回。** 先以 shadow mode 比较 Noema 与现有 lexical top-k，再决定正式切换。[fusion](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/fusion.rs#L39-L105)
4. **候选 edit/merge 和 payload-free 操作审计。** 适合扩展 MistyMoon 设置页，不必暴露 Noema 的全部编码 Agent UI。[review API](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/api/mod.rs#L824-L1035)；[audit](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-core/src/audit.rs#L31-L84)

### 不应原样采用

1. `acceptByDefault:true`、导入 `accept:true`。
2. 让模型决定是否在每个会话开头召回。
3. 把全部 RP 记忆固定成 `Preference/Internal/User`。
4. 把导入工具的任意路径读取和 server command 直接作为默认开放的模型能力。
5. 把 `sleep/offload/restore` 的路线或占位输出当成已完成能力。

## 可选 Provider 方案

建议先定义 MistyMoon 自己拥有的 `CompanionMemoryProvider`，DSH 交互层不依赖 Noema 工具名：

```text
DSH agent/pre-step
  → MistyMoon identity + RP memory policy
  → CompanionMemoryProvider.recall(query, audience)
       ├─ JsonlProvider（当前，默认）
       └─ NoemaProvider（实验，shadow/opt-in）
  → MistyMoon 生成带来源的 DSH user/message snapshot
  → DSH 会话持久化

候选捕获/主人 UI
  → MistyMoon 审核规则
  → Provider.propose / decide / forget
  → MistyMoon sourceMessageId 映射日志
```

Noema Provider 的安全默认值应是：

- `NOEMA_ROOT=$DSH_HOME/mistymoon/memory/noema`，禁止依赖 Windows `HOME`。
- `acceptByDefault=false`、`importOnStartup=false`、`importWorkspaceFiles=false`。
- 不注册或隐藏 `noema_policy_set`、任意路径 `noema_import` 和 hard delete，除非进入主人确认流程。
- MistyMoon 继续负责每步自动召回和 DSH 消息投影；Noema 只负责存储/排名/候选状态。
- 在通道身份完成前只允许 owner principal；完成后新增请求级 principal 适配，不能复用当前 stdio default principal。
- 明确关闭双写，或使用带幂等键的 outbox；不能让 MistyMoon JSONL 与 Noema 各自成为事实源。

## 迁移风险与验收门槛

直接迁移当前 JSONL 到 Noema 有以下损失：Noema MCP 不接收原始 createdAt、`sourceMessageId`、`sourceCandidateId` 或 `confidential` sensitivity；Noema 会重新生成 id/时间并把来源写成 `noema-cli`。因此不应使用现有 `noema_import` 做正式迁移。[MCP 参数](https://github.com/ZSeven-W/noema/blob/92f558385ad17f9399380df212c492d3ee82d5f0/crates/noema-mcp/src/lib.rs#L111-L133)；[MistyMoon 字段](https://github.com/mianyoubiaoqing/MistyMoon-DSH/blob/f5208537355b3ba12bfb5174dec0ec3ed40227d6/packages/memory/src/index.ts#L41-L68)

若将来启用 Noema Provider，至少经过：

1. 备份并冻结当前 JSONL 的校验和，保留只读回滚路径。
2. 编写专用迁移器，只导入 active confirmed；为 Misty id ↔ Noema id、来源消息、原始时间和保密级别保存 sidecar/outbox。
3. 先运行双检索 shadow mode，不双写；用真实匿名化 RP 查询比较命中、误召回、中文人名/昵称和 token 预算。
4. 补齐 DSH 自动召回日志快照、主人候选审核、永久删除确认、Windows 显式 root 和崩溃恢复测试。
5. 修复/上游确认 Windows 全套测试、Noema LICENSE 文件与磁盘格式迁移政策。
6. 仅在数据计数、抽样内容、召回结果和回滚演练通过后切换读路径；旧 JSONL 至少保留一个版本周期。

在这些条件满足前，**继续以 MistyMoon JSONL 为唯一事实源，并把 Noema 视为技术预览依赖**。
