# 008：Memory Management UI

状态：2026-08-20 已按 `002-p0-memory-program` 完成实现与机械验收。本段只交付 F，不改变召回算法或生命周期。

## 结果

本机 loopback Settings 新增独立 Memory 管理 Tab。Owner 可搜索/筛选 confirmed history 与 candidate queue、查看来源元数据和谱系、执行冲突决策、编辑/合并候选，并批量批准或拒绝。

## 边界

- 浏览器只调用 `MemoryGovernanceService` 的 context-free facade，不能传 Owner、authority、scope、disclosure 或档案路径。
- 搜索在 Memory 内先执行 exact scope/confidential 硬过滤，再匹配 query、kind、visibility 和状态。
- source view 只返回 Observation/source IDs、版本链和时间，不读取或回显 DSH 原消息、Persona 或 Provider 私密载荷。
- 批量审核最多 50 项，每项使用独立幂等 source ID 和 Archive 事务；返回逐项成功/失败，不把部分成功伪装成原子批次。
- 候选编辑/合并继续使用 E 的 append-only lineage；冲突批准继续要求 D 的显式 resolution。

## 安全

RPC 仅允许 loopback authority，所有 payload 严格拒绝未知字段。UI 不直接读 JSONL，不复制 scope、冲突、谱系或审批规则。

## 回滚

移除 Tab/RPC 只移除管理入口，不改变 Memory Archive；DSH 工具与档案治理仍可用。
