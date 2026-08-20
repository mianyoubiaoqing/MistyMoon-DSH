# 006：Memory Conflict / Supersession

状态：2026-08-20 已按 `002-p0-memory-program` 完成实现与机械验收。本段只交付 D，不包含候选编辑/合并 UI、批量管理、召回 Provider 或生命周期。

## 结果

Memory 对一个 pending candidate 与同一可信 Owner/authority/scope 下的活动记录生成解释性 `duplicate`、`conflict` 或 `related` 关系。关系是可重建的 Derived Memory View，不改变档案。存在 duplicate/conflict 时，批准必须携带 Owner 决策：保留两者，或以新记录原子替代一个活动目标。

## 边界

- `MemoryConflictEvaluator` 只接收已由 Archive 硬过滤的候选和活动记录，不读档案、不写治理状态。
- 内置 evaluator 为本地确定性基线，输出 memory ID、关系、分数和稳定 reason code；未知或越权 ID 被 Memory 丢弃。
- `assessCandidate()` 只返回当前 exact scope 的结果。
- `approveCandidate()` 在 duplicate/conflict 存在时 fail closed，直到收到 `keep-both` 或 `supersede`。
- `supersede` 必须指向同一 scope 的活动 confirmed memory；一个事务追加新 confirmed 版本与 resolution，并把旧版本投影为 `superseded`。历史事件不改写。

## 隐私与失败

- 关系评估遵守 confidential 双门，不通过不返回关系或正文。
- evaluator 失败不能自动批准、替代或删除数据。
- 不从候选正文推断 Owner、authority、scope 或授权。

## 回滚

移除 evaluator 会停止新冲突门；已提交的 `supersedesMemoryId` 链仍由 Archive 重放。回滚不得恢复已被 Owner 明确替代的旧值为活动记录。
