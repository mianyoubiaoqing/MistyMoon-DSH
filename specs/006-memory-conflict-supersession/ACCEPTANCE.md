# 006 验收标准：Memory Conflict / Supersession

- exact duplicate 与稳定模板近重复/矛盾得到可解释关系，低相关项不进入结果。
- 评估发生在 exact Owner/authority/scope 和 confidential 过滤后。
- 存在 duplicate/conflict 时，无 Owner resolution 的批准失败且不写事件。
- `keep-both` 明确保留两条 active confirmed memory。
- `supersede` 原子创建新版本、批准 candidate、墓碑旧版本并保留 `supersedesMemoryId`。
- 越权、非活动或不存在的 supersede target fail closed。
- 定向测试、built smoke、publication audit 与 `git diff --check` 通过。
