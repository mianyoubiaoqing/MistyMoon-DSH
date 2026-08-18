# 013 验收标准：角色场景与跑团体验模式

本文件验收设计完整性和未来实现行为，不表示当前产品已经支持这些模式。

## 1. 三轴独立

- RP Presentation Level、Experience Mode 与 DSH Collaboration Mode 分别持久化和切换。
- 任一 Experience Mode 不复制、修改或发布 Agent preset。
- `off` 停止角色表达和自动 Canon 推进，但不删除 Story/Campaign。
- Plan、权限、安全和工具限制不受角色卡、场景或规则文本覆盖。

## 2. Character Scene

- Scene Role 与长期陪伴 Persona 分开存储、草稿、预览和发布。
- 导入卡不能自动启用 system prompt、post-history instruction、世界书或未知扩展。
- Scene A 的 Canon/episode 不进入 Scene B 或 Companion Reality。
- 分支只继承分叉点前的 Canon State；两个分支后续变化互不影响。
- 第一阶段可机械限制为单 Scene Role。

## 3. Tabletop Campaign

- 每次玩家行动可追踪到场景信息、是否裁定、裁定证据、叙述结果和 Canon commit。
- 骰子结果来自可审计工具；相同日志可证明实际结果，模型不能覆盖。
- Rules Work Agent 的建议不能在没有 RP Host commit 的情况下改变角色表、库存、任务或世界。
- 当前状态从 Canon State 读取；删除记忆索引不改变角色表和世界。
- 回复取消、工具失败或状态校验失败不会留下半提交。

## 4. Agent 边界

- 只有 RP Host Agent 直接向 Owner/玩家扮演、主持和生成最终叙述。
- 编码、研究、长规则查询和数值核算由 Work Agent 执行。
- Work Agent 不能调用最终 RP 输出或递归委派工具。
- RP Host Agent 不改写 Work Report 中的代码、命令、规则引文、数值和验证结果。

## 5. 范围和记忆

- Companion Reality、Character Scene、Campaign 与 Campaign Branch 的混召回测试均为零泄漏。
- Character Scene/Campaign 的 episode 带 fiction scope；Work Agent transcript 默认不建候选。
- 未确认 channel identity 时不启用共享场景或战役长期召回。
- 离开虚构模式后的首次 Companion Chat 请求不含上一 scope 的 active recall。

## 6. 体验循环验证

使用中性战役 fixture 完成至少三轮：确定性行动、需要骰子的行动、规则不明确的行动。每轮检查：

1. 玩家能看到行动前的可见条件；
2. 系统明确是否需要裁定；
3. 结果包含可验证反馈和代价；
4. Canon State 只提交一次；
5. 下一轮呈现与已提交后果一致。

## 7. 许可证与私密数据

- 角色卡、世界书、规则书和素材逐项记录许可证；未获再分发许可的内容不进入包。
- fixture 只使用中性生成内容，不读取真实角色、战役、会话或记忆。
- 发布前通过仓库隐私审计，不包含本机路径、私有卡、战役日志或掷骰转储。

## 8. 机械检查

~~~powershell
rg -n "companion-chat|character-scene|tabletop-campaign" specs/013-roleplay-experience-modes
rg -n "Canon State|Campaign Branch|Scene Role|Work Agent" specs/013-roleplay-experience-modes
pnpm audit:publication
git diff --check
~~~

## 9. 实施停止门

- RP Host/Work Agent 隔离未经原型证明前，不开放模式实现。
- 规则 Adapter、多人频道、多角色和世界书分别需要后续叶子 Spec。
- 任何要求修改 DSH 源码、读取私有数据或让外部 Agent 直接提交 Canon 的方案立即停止。
