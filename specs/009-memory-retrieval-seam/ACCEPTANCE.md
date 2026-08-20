# 009 验收标准：Memory Retrieval Seam

- BM25 对中英文 token/中文 bigram 产生稳定非零命中和可解释 reason。
- Provider 调用前已完成 confirmed、exact Owner/authority/scope、validity、confidential 双门过滤。
- Provider 未知 ID 和重复 hit 不能绕过 Archive 回查。
- Recall Snapshot 包含 memory ID、source message ID、kind、score、provider reason 与正文，遵守 limit/字符预算。
- DSH pre-step 持久化实际 Snapshot 文本；Provider 失败时 Owner turn 正常完成。
- 中性评测覆盖至少六类 RP 记忆与跨域零泄漏。
- 定向测试、built smoke、publication audit 与 `git diff --check` 通过。
