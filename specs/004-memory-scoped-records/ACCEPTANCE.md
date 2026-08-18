# 004 验收标准：Scoped Memory Records

全部使用中性临时 fixture；不得读取真实 Memory、Persona、Session 或 DSH Home。

## 1. Pure domain

- `MemoryScopeV1` 三个分支严格校验，空/额外/未知字段拒绝。
- Owner、authority、scope、source kind/id 共同形成稳定幂等来源键；不同 Owner、Scene、Campaign Branch 不冲突。
- Observation 与 candidate/confirmed record 同 transaction；record 只引用当前 transaction 或既有有效 Observation。
- kind 枚举完整；非法 kind 拒绝。ISO 时间严格校验，`validTo < validFrom` 拒绝，未知时间不补猜。
- schema v2 record/candidate 缺 owner、scope、observation、kind 或 recordedAt 时结构化 quarantine。

## 2. Scope isolation

- 同一查询下，Companion Reality、Scene A、Scene B、Campaign A/Branch 1、Branch 2 各自只返回完全匹配 scope。
- Owner A 永不返回 Owner B 的记录，即使正文和裸 source id 相同。
- Character Scene/Campaign record 不自动复制到 Companion Reality；离开虚构 scope 后零泄漏。
- inactive、未到 validFrom 或已过 validTo 的记录不召回。

## 3. Confidential hard filter

使用同一 Owner/scope/query 的 personal 与 confidential fixture 覆盖四种组合：

| Channel policy | Request intent | Confidential recalled |
| --- | --- | --- |
| personal-only | ordinary | no |
| personal-only | explicit-confidential-recall | no |
| owner-confidential | ordinary | no |
| owner-confidential | explicit-confidential-recall | yes |

过滤在 ranking/Recall Snapshot 前完成；被排除正文不出现在 plugin message、diagnostic 或 selection metadata。模型文本和工具参数不能设置这两个可信字段。

## 4. DSH authority

- 顶层、已认证 `local-dsh-host-rpc` Owner message 产生 Companion Reality Observation + record。
- 非 user source、Work child、缺 identity、Owner mismatch 或 turn 已结束时不观察、不召回。
- 工具从 `ToolExecution.agent` 当前 turn 取得 context；tool args schema 不含 ownerId/authority/scope/disclosure override。
- 不支持的远程 channel 默认 fail closed。

## 5. Candidate/governance compatibility

- propose/approve/reject 继承 Owner/scope/observation；批准 transaction 原子包含 approval Observation、confirmed record 与 resolution。
- Settings loopback governance 可列出/审核候选，但客户端无法改 owner/scope/kind；非本机来源仍拒绝。
- replace/forget 保持原 Owner/scope；跨 Owner/scope target 返回稳定拒绝。
- legacy SQLite import 需要显式 trusted context，且来源幂等键不会跨 Owner/scope 合并。

## 6. Legacy scope migration

- storage v2/domain v1 与原始 v1 都得到 `scope-migration-required`，普通 recall/mutation fail closed，DSH turn 继续。
- plan 无正文，包含 exact digest、counts、scope/kind/time policy、backup requirement、expiry/token。
- apply 缺 token、过期、digest drift、lease timeout、backup/fault failure均不产生混合 domain schema；exact backup 可恢复。
- successful apply 后所有活动 event 都有 Observation、Owner、scope、kind、recordedAt，fold 与旧治理状态等价。
- interior corruption 仍只 `restore-required`；scope migration 不绕过 A 的 quarantine/recovery。

## 7. Storage 与兼容

- A 的 100 并发、fault matrix、checkpoint、migration/trailing recovery、dispose 全部继续通过。
- 一个 logical mutation 仍恰好一个 storage transaction；不得因 Observation 增加独立追加窗口。
- archive/config/CLI 上限继续在不可信边界校验，inspection/错误不含正文。

## 8. 门禁

至少运行：

```powershell
pnpm exec vitest run packages/memory/tests packages/settings-ui/tests/settings.spec.ts packages/installer/tests/root-bundle.spec.ts
pnpm exec tsc --noEmit -p packages/memory/tsconfig.json
pnpm build
pnpm smoke:built
pnpm audit:publication
git diff --check
pnpm check
```

## 9. 失败条件

- 任一新 confirmed/candidate 没有 Owner、scope、Observation、kind 或 recordedAt；
- 根据正文、tool args、Persona 或 Provider 返回选择/扩大 scope；
- confidential 在双重允许之外进入 ranking 或模型投影；
- legacy domain event 被静默赋值或继续普通召回；
- Character Scene、Campaign Branch 与 Companion Reality 混召回；
- Settings UI 复制 Memory 业务规则或直接访问文件；
- 实现段 C–I、修改 DSH/Foundation 或操作真实数据。
