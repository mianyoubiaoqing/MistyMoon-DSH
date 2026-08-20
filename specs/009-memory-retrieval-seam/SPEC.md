# 009：Memory Retrieval Seam

状态：2026-08-20 已按 `002-p0-memory-program` 完成实现与机械验收。本段只交付 G，不启用 PageIndex、图服务或远端 Provider。

## 结果

Memory 暴露异步、可降级的 `retrieve()`，返回版本化、可解释的 Recall Snapshot。内置本地 BM25 是默认 Provider；Provider 只看经过 Owner/authority/scope/status/validity/confidential 硬过滤的 confirmed projection，只返回 memory ID、分数和 reason。Memory 回查权威档案后才生成正文。

## 边界

- `RecallIndexProvider` 接收只读 projection，不拥有 Archive、审核或 scope。
- Provider 输出严格限制为已提供的 memory ID；未知、重复、非有限分数和未知字段 fail/drop closed。
- 多路 hit 按稳定 provider identity 融合，最终结果保留 provider、reason、score、source message、当前版本和正文。
- `maxCharacters` 与 `limit` 在最终 projection 层执行，不截断单条记忆。
- 模型可见 Snapshot 以 DSH 原生 plugin message 持久化，包含 memory/source/reason receipt。
- 既有同步 `recall()` 保留兼容，但使用相同 BM25 基线与硬过滤。

## 评测

中性中文用例覆盖称呼/边界、共同事件、承诺、时间纠正、短期 state 和跨 scope 干扰；记录 precision@k、关键命中、scope 泄漏、解释完整率和延迟。

## 回滚

移除异步 seam 后可退回同步本地检索；Archive 与治理记录不变。Provider 故障只能退回 baseline 或无召回，不能失败 Owner turn。
