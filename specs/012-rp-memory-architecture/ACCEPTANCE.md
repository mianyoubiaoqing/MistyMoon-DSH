# 012 验收标准：RP 长期记忆目标架构

本文件用于 Review 设计与未来叶子 Spec，不代表当前运行时已经具备这些能力。

## 1. 领域和所有权

- Persona、Confirmed Memory、Derived Memory View 与 Canon State 有互斥定义。
- Companion Reality、Character Scene 和 Tabletop Campaign/Campaign Branch 具有不可省略的 scope。
- Owner scope 只能来自 DSH 已认证映射；模型和 Provider 不能扩大它。
- Work Agent transcript 默认不产生陪伴记忆。

## 2. 治理

- 自动抽取、导入和冲突发现只创建 Memory Candidate。
- 未批准、已拒绝、已遗忘和已替代记录在 Provider 搜索与最终投影中均为零命中。
- 纠正以原子追加事务形成新版本和替代链；不原地改写历史。
- emotion/relationship 推断不能自动确认。

## 3. 时间与来源

- 可区分事实有效时间、系统得知时间和记录版本时间。
- 未知时间不由模型静默猜测。
- 每条 confirmed/episode/summary 可追溯到 DSH source IDs；summary 保留完整 lineage。
- 任一 summary 来源失效后，summary 不再参与召回。

## 4. 召回隔离场景

1. 两个 Owner 使用相同关键词和同一 Provider，不能通过搜索或 direct ID 互相命中。
2. 同一 Owner 的现实偏好不会进入 Character Scene；场景事件不会进入 Companion Reality。
3. Campaign Branch A 的状态或 episode 不进入 Branch B。
4. “过去偏好 A、现在偏好 B”只投影 B，但 A 的来源和有效期可审计。
5. “忘记此事”后，即使外部索引删除失败也不会投影。
6. 记忆正文包含系统命令样式文本时仍只作为引用数据。

## 5. 召回质量与解释

- 建立完全中性的中文 RP 集，至少覆盖称呼边界、共同事件、未完成承诺、时间纠正、短期情绪和跨范围干扰。
- 记录 lexical baseline 与候选 Adapter 的 precision@k、关键边界召回率、错误 scope 泄漏数、p95 延迟和解释完整率。
- 每个命中至少说明稳定 memory ID、来源、当前版本与命中理由。
- 外部 Provider 只返回 ID/score/reason，最终正文必须从权威档案回查。

## 6. DSH 可重建性

- 每次模型可见 Recall Snapshot 以 DSH 原生消息精确持久化。
- 仅凭 DSH 日志和权威 memory IDs 能说明模型看到了什么以及为何选择。
- Provider 超时、崩溃或 schema 不兼容时，Owner turn 正常完成并降级到默认检索或无召回。

## 7. 外部 Provider 门槛

- 默认运行不需要 Python、Docker、图数据库或远端 API。
- Graphiti/Mem0/Cognee 均默认关闭，并通过 Owner 隔离、删除传播、重建、超时、注入和关闭测试后才可 opt-in。
- Graphiti 固定到不受已知 `<=0.28.1` Cypher injection 影响的版本。
- 引入代码或依赖前完成许可证、NOTICE、二进制和数据路径审查。

## 8. 实施停止门

- `003-memory-storage-reliability` 未完成前，不实施后台抽取或外部索引写入。
- 每个 Program 叶子段仍需单独 Spec、用户批准、实现与验收。
- 任何需要修改 DSH、读取真实档案、猜测 Owner 或自动迁移的数据方案立即停止。

## 9. 文档机械检查

~~~powershell
rg -n "Companion Reality|Character Scene|Tabletop Campaign|Owner scope|Recall Snapshot" specs/012-rp-memory-architecture
rg -n "candidate|confirmed|supersed|lineage|Provider" specs/012-rp-memory-architecture
pnpm audit:publication
git diff --check
~~~
