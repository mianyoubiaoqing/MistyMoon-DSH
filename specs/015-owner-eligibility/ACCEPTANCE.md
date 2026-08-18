# 015 验收标准：Owner Eligibility

- [x] 共享 policy 对 source、canonical depth 与 identity evidence 三项逐项 fail closed。
- [x] Foundation 和 Memory 只消费同一个 Cordis service，不复制判断。
- [x] DSH Host RPC 顶层 Owner 保持现有 RP/Memory 行为。
- [x] one-shot/depth 1 user prompt 不触发 voice、refresh、observe、recall 或 Memory tools。
- [x] 缺 `rpcId` 的顶层 user prompt 不被当成已认证 Owner。
- [x] current-turn 工具授权不继承旧 turn、fork seed 或另一 Session 的 evidence。
- [x] 当前实现不修改 DSH 源码、客户端、Profile 或用户私有数据。
- [x] 发布审计不包含真实 owner id、会话、日志、凭据或本机路径。

验证：2026-08-17 完整 `pnpm check` 通过 21 个测试文件、150 项测试、built Cordis smoke 与 196 文件 publication audit。
