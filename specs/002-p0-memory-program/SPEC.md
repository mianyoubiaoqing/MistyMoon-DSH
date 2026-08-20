# 002：P0 Memory Program 分段执行规范

状态：2026-08-18 Owner 已明确授权下一会话在仓库代码与中性 fixture 上按依赖顺序彻底实现 Memory。A–I 仍须各自先形成独立 `SPEC.md`、`ACCEPTANCE.md` 与可验收纵切片，但普通、可回滚的本地实现不再逐段等待重复授权。该授权不包含真实档案迁移/恢复、远端 Provider 启用、永久物理删除、部署、发布、commit 或 push；这些高风险动作仍须单独确认。

基线：MistyMoon `dd4506e7ffe9ac7902b23c9387b1cc82b598e393`；DSH 官方 `master` `47f943859bef60e4160492346772ded9b24f765a`，已通过 `git ls-remote` 核对。MistyMoon 与 DSH 工作区现有修改均视为用户所有。

## 问题陈述

README 剩余 P0 同时包含自动写入、冲突治理、存储格式、管理 UI、召回算法和长期生命周期。若作为一个实施任务交付，会同时改变数据格式、后台模型调用、跨包 Interface、UI/RPC 和召回质量，无法形成小型可回滚变更，也无法判断失败来自哪一层。

当前 Memory 已有追加式 JSONL、候选审核、显式纠正/遗忘和词法召回，但仍直接 `appendFile()`，只在单进程对象内串行写入；记录也尚未携带 Owner、通道 authority、Experience scope、memory kind 与有效时间。自动候选提取尚未启用。先增加后台写入会放大并发、崩溃恢复和幂等风险，因此存储可靠性必须先于 scoped domain record，二者又必须先于自动提取与召回升级。

## 目标

- 把剩余 P0 拆成可独立批准、实现、验收、回滚的叶子 Spec。
- 每段只改变一个主要 Module 或一条完整 capability seam。
- 前一段的完成报告不能自动授权后一段。
- Bundle 只负责组合；Memory 拥有治理和档案；Settings UI 只消费稳定 Interface。
- 任何送入模型的提取或召回内容都必须由 DSH 会话日志重建。
- 不修改 DSH 源码，不削弱 Coding、工具、权限、Plan、审批或安全能力。

## 非目标

- 本 Program Spec 不定义可直接编码的完整实现细节。
- 不一次性升级所有数据格式、算法和 UI。
- 不把 Noema、Mem0、Mnemon 或其他外部引擎作为 P0 必需依赖。
- 不授权 commit、push、发布、安装或迁移真实用户数据。

## 分段顺序

| 段 | 叶子 Spec | 唯一主要结果 | 依赖 | 明确不包含 |
| --- | --- | --- | --- | --- |
| A | `003-memory-storage-reliability` | 版本化事务记录、跨进程单写者、显式迁移和损坏恢复 | 无 | 自动提取、冲突模型、管理页、召回算法 |
| B | `004-memory-scoped-records` | Trusted Owner/authority/scope、Memory Observation、kind 与有效时间成为所有写入和读取的必需领域边界 | A | 自动提取、冲突检测、BM25、管理页 |
| C | `005-memory-candidate-extraction`（已完成） | 回复后自动候选提取 Provider；候选永不自动批准 | A、B | 冲突替代、候选编辑、定时整合 |
| D | `006-memory-conflict-supersession`（已完成） | 冲突/近重复检测与 Owner 决策后的墓碑、`supersedes` 链 | A、B、C | 自动合并、批量 UI、向量召回 |
| E | `007-memory-candidate-governance`（已完成） | 候选编辑、合并和不含敏感载荷的操作审计 | A、D | 完整搜索页、召回算法 |
| F | `008-memory-management-ui`（已完成） | 搜索、筛选、批量审核和来源查看的专用页面 | A、B、D、E | 直接文件访问、业务规则复制 |
| G | `009-memory-retrieval-seam`（已完成） | 可解释的 Retrieval Service Definition、内置词法/BM25 Provider 与 Consumer | A、B、D | PageIndex/图引擎强制依赖 |
| H | `010-memory-advanced-retrieval`（已完成） | 可选 PageIndex/图关系融合 Adapter 和 shadow 对比 | G | 改变治理事实来源、自动启用外部 Provider |
| I | `017-memory-lifecycle` | 整合、衰减、归档与恢复 | A、B、D、G | 永久物理删除、无人确认的事实改写 |

`011`–`016` 已被 RP/Work/Identity 规范占用，因此 Lifecycle 使用 `017`。若实施时编号又被占用，使用当时下一个未占用编号并同步本表。A–I 的普通、可回滚本地实现均受本页状态所述授权覆盖；高风险排除项仍须单独确认。

## 依赖和停止门

```text
A Storage Reliability
└─> B Scoped Records
    ├─> C Candidate Extraction ─> D Conflict/Supersession ─> E Candidate Governance ─> F Management UI
    └─> G Retrieval Seam ─> H Advanced Retrieval
                 └───────────────> I Lifecycle
D ───────────────────────────────> I
```

每段必须满足：

1. 叶子 Spec 属于 2026-08-18 Owner 的 Memory 完成授权；若扩展到上述排除项，则另行取得确认。
2. DSH Agent 只实现该段允许的文件和行为。
3. Codex 独立对照叶子 Spec 验收。
4. 用户决定是否合并、部署或进入下一段。

任一步发现需要修改 DSH、读取私有数据、改变未批准格式或跨越到后一段，立即停止并提交问题。

## 稳定 Module 与 seam 方向

- `MemoryArchive`：拥有事实、候选、决策、事务持久化和当前投影；调用者不接触 JSONL。
- `MemoryDomain`：只接受由宿主建立的 Owner、channel authority 与 fiction scope；创建不可变 `Memory Observation`，并统一验证 visibility、kind、有效时间和来源。模型文本、工具参数与 Provider 返回值不能声明或扩大 scope。
- `MemoryCandidateExtractor`：接收已选择并带来源的 owner evidence，返回未经批准的候选草稿；Provider 不写档案。
- `MemoryConflictEvaluator`：对候选与活动记忆产生解释性关系结果；owner 决策 Consumer 才能改变状态。
- `MemoryRetrieval`：接收已治理的活动事实和查询，返回带原因的排序结果；Provider 不改变治理状态。
- `MemoryLifecycle`：提出整合/归档计划；未经 owner 批准不执行不可逆状态改变。
- Settings UI 只通过 Memory 提供的 Interface/RPC Consumer 工作，不读取文件或复制规则。

Interface 可在叶子 Spec 中细化，但不得为了某一 Adapter 把外部引擎类型泄漏给调用者。

## 数据与隐私不变量

- 只有 confirmed、当前 Owner、authority、visibility 与 Experience scope 全部匹配的记忆可进入召回。
- `confidential` 默认不进入自动 Recall Snapshot；只有可信 Owner 的明确意图和允许该通道披露的策略同时成立时才能投影。
- Character Scene、Tabletop Campaign Branch 与 Companion Reality 禁止自动互相复制或混召回。
- pending/rejected/conflict/archived 数据默认不进入模型请求。
- 自动提取只创建 pending candidate，不创建 confirmed memory。
- 每项事实与候选保留可审计来源；报告、fixture 和 snapshot 只用中性生成数据。
- 私有人格、记忆、角色卡、凭据、真实会话和本机私有路径不得进入 Git、PR、测试或报告。
- 外部 Provider 只能替换检索/提取 implementation，不能拥有 owner 身份、审核或永久删除策略。

## 兼容性

- 所有叶子段只使用 DSH 官方最新公开 seam。
- DSH session、PersonaDocument、Character Card 和 Settings RPC 的无关格式保持不变。
- 破坏性 Memory 格式变化必须由段 A 的显式迁移、备份和回滚规则承接。
- 一个段不能以“未来段会补齐”为由提交不安全的中间状态。

## 允许修改

本 Program Spec 只允许创建或修订 `specs/002-p0-memory-program/**` 以及后续独立叶子 Spec。它本身不允许修改 `packages/**`、Bundle、配置、锁文件或 DSH。

## 部署与回滚

Program 文档无需部署。每个叶子 Spec 自己定义部署和回滚；未通过 Codex 与用户 Review 的段不能成为下一段的运行时前提。

## 已确认的执行决策

1. A–I 顺序获批；存储可靠性与 scoped domain record 必须先于任何后台抽取或外部索引写入。
2. 每段保持独立 Spec、测试和可回滚边界，但未经 Owner 明确授权不得 commit、push 或创建 PR；下一会话可在前一段验收通过后继续下一段。
3. 段 H 默认只完成 shadow/opt-in Provider，不开放为默认，也不发送真实私有内容到远端服务。
