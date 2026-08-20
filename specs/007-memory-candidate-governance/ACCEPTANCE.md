# 007 验收标准：Memory Candidate Governance

- 编辑追加一个带单一 `sourceCandidateIds` 的 pending candidate，并在同一事务 supersede 原候选。
- 合并追加一个带多个有序、去重 source IDs 的 pending candidate，并原子 supersede 所有来源。
- 新候选不会自动批准或召回；旧候选保留审计历史。
- exact retry 幂等，变更后的同 source 请求拒绝。
- 跨 Owner/authority/scope、resolved source 和重复 source ID 拒绝且零写入。
- audit projection 不包含 content、visibility、Provider receipt 或 Persona/Memory 正文。
- 定向测试、built smoke、publication audit 与 `git diff --check` 通过。
