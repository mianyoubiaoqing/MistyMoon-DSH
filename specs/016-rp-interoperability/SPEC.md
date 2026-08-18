# 016：RP 互操作、Prompt Itemization 与派生摘要

状态：2026-08-18 根据 DSH RP 与成熟开源 RP 生态调研建立。只授权中性 fixture、只读兼容验证和独立实现；不授权复制 AGPL/GPL 源码、导入真实角色卡或安装第三方项目到真实 DSH Home。

## 目标

在不改变 MistyMoon 权威数据与 DSH Agent Loop 的前提下，建立一组可重复的 RP 互操作合同：

1. Character、Owner Persona、Relationship、Worldbook、Scene/Campaign 和 Confirmed Memory 分开导入、存储和投影；
2. 所有模型上下文都能按来源、位置、预算和 revision itemize，并由 DSH 日志重建；
3. 群聊 speaker selection 是确定的 policy receipt，不由多个角色 prompt 争夺 system authority；
4. summary/vector/graph 是可回滚、可删除重建的派生层，正文始终回查权威 revision 与 source citation；
5. 外部插件通过 capability/receipt seam 接入，不能旁路 Owner scope、approval、visibility 或 DSH 会话日志。

## 中性 Fixtures

公开测试资产只使用生成内容，放在 `fixtures/rp-interop/`：

- Character Card V2 JSON、V3 JSON 和 CHARX，包含可识别的未知扩展字段；
- 独立 Owner Persona 与 Relationship 文档，证明导入 Character 不覆盖二者；
- Worldbook，覆盖 keyword、regex、always-on、priority、order、position、depth 和硬预算；
- 三角色群聊，覆盖 manual、mention、ordered、weighted speaker policy 和 visibility；
- versioned summary，覆盖 source citation、编辑、暂停、rollback 与来源失效；
- 场景/战役 scope，证明 Companion Reality、Scene 与 Campaign Branch 不混召回。

Fixture 不包含真实人格、记忆、对话、角色卡、图片、凭据、本机路径或未获授权素材。未知字段在 round-trip 中保留于私有 draft extension area，但不自动进入 system prompt。

## Interfaces

### `PromptItemization`

输入是一次已经治理的 projection plan，输出只读 items：`kind`、`sourceId`、`revision`、`position`、`estimatedTokens`、`selectedReason` 和最终 content hash。Owner-only 本机视图可以按需显示私有正文；日志和诊断默认只记录 receipt。模型实际看见的最终文本仍由 DSH 原生消息或 `request/header.system` 持久化。

### `WorldbookProjectionPolicy`

只接受已发布 Worldbook revision、可信 scope、当前消息和硬预算，返回有序条目与 selection receipt。命令式文本始终作为不可信引用数据；不得改变 DSH safety、权限、工具或 collaboration mode。

### `SpeakerPolicy`

支持 `manual | mention | ordered | weighted`，返回一个 active speaker id、候选集、原因和 policy revision。一个 provider request 恰好零或一个 active speaker；非 active 角色仅贡献经过 visibility 与预算过滤的 scene context。

### `DerivedSummaryStore`

保存 summary revision、完整 source IDs、生成器版本和状态（active/paused/invalidated）。编辑或 rollback 创建新 revision；任一来源被替代、遗忘或越权后，依赖 summary 立即失效并可重建。

### `RpExtensionCapability`

外部 Adapter 声明只读/写入能力、数据 scope、timeout/cancel、receipt schema、删除传播和重建语义。MistyMoon 在消费边界复核每个返回 ID；Adapter 不持有权威正文或 Owner authority。

## 固定第三方 Conformance

- `dsh-tavern@b495df2b79c325eb4d9401baffee17484d702e49`：只在系统临时 rc.7 Home 做 build/load/dispose/session-fork/owner-isolation smoke，不安装到真实 Home，不采用其全局 RP system-section 策略。
- SillyTavern `1.18.0`、RisuAI `v2026.6.215`、Agnaistic 固定 commit：只用本规范的中性 fixture 对照导入/导出、itemization、speaker 与 summary 行为，不引入其代码、样式或资产。
- 任何外部项目版本变化都必须重新固定 commit、许可证和行为基线；README 自述或 package range 不等于 rc.7 兼容。

## 许可证

SillyTavern、Agnaistic、KoboldCpp 的 AGPL 与 RisuAI 的 GPL 实现只作为 clean-room 行为参考。MIT/Apache 候选也必须保存固定 commit、copyright、LICENSE/NOTICE，并审计依赖和资产来源后才可复用小段 Adapter；默认优先把观察转成 conformance test 后独立实现。
