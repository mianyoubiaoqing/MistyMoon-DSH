# 008 验收标准：Memory Management UI

- 独立 Memory Tab 可搜索并按 kind、visibility、record/candidate status 筛选。
- confidential 结果仅在已绑定的可信 loopback facade 内可见，浏览器不能扩权。
- source view 提供 Observation/source/revision/lineage 元数据，不回显原 DSH 消息或 Provider payload。
- 批量审核限制 1–50 个互异 candidate；逐项状态可解释、重试幂等。
- 编辑、合并、keep-both、supersede 从 UI 进入 Memory-owned service，不复制业务规则。
- RPC 未知/多余字段和非法组合返回 bad-request。
- Host 测试、Client build、built smoke、publication audit 与 `git diff --check` 通过。
