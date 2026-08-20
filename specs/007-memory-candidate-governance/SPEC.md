# 007：Memory Candidate Governance

状态：2026-08-20 已按 `002-p0-memory-program` 完成实现与机械验收。本段只交付 E，不包含完整管理页、召回算法或生命周期。

## 结果

Owner 可以编辑一个 pending candidate，或把多个 pending candidate 合并为一个新的 pending candidate。原候选永不原地改写；新候选保存 `sourceCandidateIds` 谱系，原候选在同一事务中转为 `superseded`。任何新候选仍须独立审批。

## 公共边界

- `editCandidate()` 只接受一个 exact-scope pending source 和 Owner 提供的完整新草稿。
- `mergeCandidates()` 至少接受两个互异、同一 exact scope 的 pending source 和 Owner 提供的完整合并草稿。
- 操作使用治理 Observation，支持 source idempotency；重试返回同一结果，漂移请求 fail closed。
- `listGovernanceAudit()` 只返回 action、source/result candidate IDs、时间和 source message ID，不返回正文、visibility 或其他敏感载荷。
- Settings UI 只消费 `MemoryGovernanceService`，不直接修改 Archive 或复制谱系规则。

## 失败与回滚

越权、已处理、重复 source ID、空内容、无效时间或跨 scope 合并均在写入前失败。移除编辑/合并入口不改变既有谱系；历史继续可重放。
