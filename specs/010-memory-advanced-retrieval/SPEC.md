# 010：Advanced Memory Retrieval

状态：2026-08-20 已按 `002-p0-memory-program` 完成。本段只交付 H；未引入、启动或默认启用外部引擎。

## 结果

G 的 Retrieval Engine 可消费一个动态 Advanced Provider source。Memory 提供 PageIndex 与 graph-relationship 两个窄 Adapter，以及 `disabled` → `shadow` → Owner-confirmed `opt-in` 策略。BM25 永远保留为 baseline；shadow 不影响模型结果，opt-in 只参与 ID/score/reason 融合，最终正文仍回查 Archive。

## 策略

- 新注册 Adapter 默认 `disabled`，不调用 backend。
- `shadow` 只允许 `local-process` data boundary，生成无正文的 overlap/latency/status comparison，不影响 Recall Snapshot items。
- `opt-in` 要求当前配置动作携带 Owner confirmation；取消确认或 disable 立即停止调用。
- `remote` boundary 在本 RC 中只能 disabled；不能通过配置或 prompt 发送真实私有 projection。
- 每个 Provider 有 10–5000ms timeout，取消向下传播；throw、timeout、schema 错误均只降级到 BM25。

## Adapter

- PageIndex Adapter 把已过滤 records 映射为按 memory kind 分组的 versioned pages，再调用不可信 backend。
- Graph Adapter 把已过滤 records 映射为 memory nodes 与本地可重建关系边，再调用不可信 backend。
- backend 不接触 Archive、Owner identity、candidate、Persona 或审批状态，只返回 ID/score/reason。

## 回滚

将所有 Provider 设为 disabled 或移除注册即可回到纯 BM25；Derived View 可丢弃重建，Archive 不变。
