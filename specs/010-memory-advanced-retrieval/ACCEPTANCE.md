# 010 验收标准：Advanced Memory Retrieval

- 新 Adapter 默认 disabled 且零调用。
- shadow 只产生无正文 comparison，不能改变 items 排名或模型投影。
- opt-in 缺少 Owner confirmation 时拒绝；确认后只融合 Archive 已允许的 IDs。
- remote Adapter 在 RC.6 不能进入 shadow/opt-in。
- timeout、取消、throw、无效 schema 和未知 ID 均保留 BM25 结果并记录稳定状态。
- PageIndex/graph backend 只收到硬过滤后的 projection，不收到 Owner/scope/Persona/candidate。
- 不增加 Python、Docker、图数据库或远端依赖，不启用真实私有数据调用。
- 定向测试、built smoke、publication audit 与 `git diff --check` 通过。
