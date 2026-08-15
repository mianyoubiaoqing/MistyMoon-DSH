# MistyMoon 架构

MistyMoon 是 DSH 上以 RP 和长期陪伴为核心的产品层，不是第二套 Agent Runtime。它通过 DSH 插件组合注入人格、受治理记忆和本机设置能力，不修改 DSH 源码。

## 运行时关系

```text
用户与各通道
      │
      ▼
DSH Agent / Session / Permission / Tools
      │
      ├─ Foundation ── 私有人格文档 ── agent/pre-step RP 快照
      │
      ├─ Memory ────── 所有者治理档案 ── agent/pre-step 自动召回
      │                                  │
      │                                  └─ DSH 会话中的模型可见快照
      │
      └─ Settings UI ─ 本机回环 Host API ─ 草稿、审核与运行设置
```

DSH 会话日志保存原始交互和实际送入模型的人格、记忆投影。MistyMoon 私有目录保存跨会话的活动人格、长期事实、候选与设置。索引可以重建，来源记录和审计历史不能依赖索引反推。

## Foundation

Foundation 管理版本化活动人格 `persona.json`、未发布的 `draft.json` 和 `versions/` 回滚历史。首次运行只从中性模板创建活动文件，升级不得覆盖用户版本。设置页保存只更新草稿；发布会先归档当前活动版本，并在草稿所基于的活动人格未被其他进程改变时原子替换活动文件。

DSH 的 `minimal` 等完整预设会在系统提示词组装结束时恢复为唯一系统提示词，因此外置插件不能通过公开扩展点稳定地把 RP system prompt 放在它前面或后面。Foundation 不修改这一语义，也不复制 Agent 预设。它在 DSH 已完成系统提示词组装后，通过 `agent/pre-step` 把一条带插件来源的 RP 用户上下文插到真实用户消息之前；Agent Loop 随后把两条消息写入 DSH 会话日志再发送给模型。

长任务的第一步使用上述完整快照；发生工具调用后，每个继续执行的模型步骤都会在消息末尾增加一条仅含角色名、语气与“不干扰 DSH 操作”的精简提醒。该提醒同样带插件来源并写入会话日志，不修改代码、工具结果或系统提示词。它让最终自然语言回复附近始终存在人格语气信号，同时避免在每一步重复完整人格造成上下文膨胀。初始步骤若不是主人消息（例如子 Agent 或系统触发）不会启用 RP 提醒。

```text
DSH 系统提示词（minimal / standard / 其他预设）
  → MistyMoon RP 快照（plugin source，可重建）
  → 当前真实用户请求
```

RP 展示等级与 DSH 能力模式正交：`off` 不投影，`companion` 只投影身份、关系和自然语言语气，`immersive` 投影完整人格。三种等级都不改变 Agent 预设、协作模式、Plan、工具、权限、模型路由或安全规则。RP 快照明确规定 Coding、调试、研究和工具调用保持 DSH 行为与技术准确性，不角色化代码、命令、计划、诊断和技术决策。等级选择写入当前 DSH 会话日志，可用 `/rp` 命令查看和切换。

角色卡导入也归 Foundation 管理；任何导入结果先成为私有草稿，不能自动发布。设置页只提交生命周期操作，不自行拼接提示词。

Character Card 导入由 Host 解析 V1/V2/V3 JSON、PNG/APNG `tEXt` 块和 CHARX 根 `card.json`。容器解析限制总大小、JSON 大小、PNG CRC、ZIP 条目数、路径、展开总量和压缩比；CHARX 资产不解压、不执行、不自动联网。字段映射默认排除 `system_prompt` 和 `scenario`，Creator Notes、问候、世界书、扩展与未知字段永不自动进入人格。用户保存映射后得到普通未发布人格草稿，仍须通过同一发布流程才会进入后续 RP 快照。

## Memory

Memory 当前使用追加式 JSONL 档案：新事实、纠正、遗忘和审核决定都是新记录。活动视图由历史投影得到；纠正不改写旧值，遗忘记录保留审计但不再召回。

自动召回挂在 `agent/pre-step`，由 MistyMoon 根据当前会话和所有者范围选择正式记忆，再以带来源的 DSH 消息写入会话。模型不需要记得主动调用工具，工具也不能绕过审核状态直接读取底层档案。

长期方向是定义稳定的 `MemoryProvider` 接口：

```text
MistyMoon 治理层
├─ 身份、可见性、候选审核、来源消息 ID、替代关系
├─ 自动召回与 DSH 会话投影
└─ Provider
   ├─ 内置 JSONL / 可重建索引
   ├─ Noema（候选，先 shadow mode）
   ├─ Mnemon（候选）
   └─ Mem0（候选，独立服务）
```

Provider 可以负责持久化、全文检索、图检索和排序，但不能拥有产品级身份或审核策略。切换 Provider 必须保持相同的规范化事实、来源、可见性和修订语义。

## Noema 决策

截至固定提交 `ZSeven-W/dsh-noema@acfb4cd58c9486412fb3bfc9e978eae66e04e5a7`，不直接替换 MistyMoon Memory。Noema 的 BM25、PageIndex、图关系、多路融合、可解释召回、冲突候选、替代墓碑和文件原子写入值得采用；但当前 DSH 适配器主要通过系统提示词让模型自行调用 `noema_recall`，默认自动接受新记忆，且导入身份、可见性和来源消息 ID 不能保真映射 MistyMoon 的 RP 治理。

采用路径分三步：

1. 先在内置档案吸收替代链、冲突审核、文件锁、原子写和无敏感载荷审计。
2. 定义 Provider 一致性测试，让相同输入得到相同所有者范围和生命周期结果。
3. 以只读 shadow mode 接入 Noema，对比召回质量、延迟和故障恢复；通过门槛后才允许用户选择它作为索引/检索后端。

Noema 内核仓库在审计固定点缺少独立许可证文件，尽管其 Cargo 元数据声明 MIT。澄清前不把其二进制随 MistyMoon 包再分发。完整审计见 [dsh-noema 对比报告](../.research/dsh-noema-comparison-2026-08-16.md)。

## 通道和桌面端

QQ/NapCat、Web、手机 SSH 入口和未来桌面形象都是 Adapter。它们先把外部账号映射为 MistyMoon 主人、熟人或陌生人身份，再进入同一 Agent 与治理层。未经映射的外部身份不能自动继承本机主人的私密记忆。

Windows 发行计划采用单个签名安装程序和安装后的目录化 Runtime。NapCat 由启动器显式拉起、健康检查和受控停止；启动器只管理自己创建的进程。Live2D 只消费 Presence/表现意图，不读取原始私密记忆。

## 自动部署

自我修改必须发生在隔离工作区，经过构建、测试、发布审计和风险分类。只有可回滚、无权限扩张、不改人格与记忆语义的低风险插件变更可以自动部署。人格发布、永久删除、凭据、网络暴露、权限和公开 Git 操作始终需要人工确认。
