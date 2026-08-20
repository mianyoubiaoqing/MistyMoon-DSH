# 005 验收标准：Memory Candidate Extraction

- 严格拒绝未知字段、空正文、未知 kind/visibility、无效时间、超过八条以及不属于输入 evidence 的 source ID。
- 同一 evidence 的多候选与一个 Observation 在同一事务提交；重试幂等，漂移结果拒绝。
- Provider 不能写 Archive，所有新项均为 `pending`，`recall()` 为零命中。
- 只处理 Owner Eligibility 认可的顶层当前 turn 消息；child 和未认证消息为零调用。
- 超时、取消、Provider throw 与无效输出均不阻断 Owner turn、不留下半批次。
- 模型型 receipt 必须指向 DSH Session；默认配置不启用远端 Provider。
- 定向测试、built smoke、`pnpm audit:publication` 与 `git diff --check` 通过。
