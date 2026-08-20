# 017 验收标准：Governed Memory Lifecycle

- plan 无副作用；缺少 Owner confirmation 的 apply 被拒绝。
- consolidate 保存完整、唯一、扁平的 `sourceMemoryIds`，并采用来源中最严格 visibility。
- 任一 source forgotten、superseded、过期或丢失后，summary 不再召回；重开 Archive 后行为一致。
- decay 只改变 Recall Tier/rank multiplier；正文、事实 status、visibility、validity 和来源不变。
- `boundary`、`commitment`、`state` 不出现在自动 decay plan。
- archive 后记录仍可审计但不召回；restore 后可再次召回，没有永久物理删除。
- plan 在 target/source 状态漂移后 apply 失败，不部分提交。
- Derived View Provider 只收到 ID；删除/失效失败或超时返回 `stale` receipt，Archive 回查仍阻止投影。
- 其他 Owner、authority、scope 和 confidential gate 不能被 lifecycle 输入扩大。
- 定向测试、重开 replay、built smoke、publication audit 与 `git diff --check` 通过。

