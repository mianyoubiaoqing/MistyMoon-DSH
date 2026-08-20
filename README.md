# MistyMoon for DeepSeek Harness

MistyMoon 是一套以角色扮演（Roleplay，简称 RP）和长期陪伴为核心的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 外置插件。项目保留 MistyMoon 的人格、关系、长期记忆与陪伴体验，同时复用 DSH 的 Agent Runtime、会话、工具、权限和 Web 插件体系，不修改 DSH 源码，也不重复实现 Agent Loop。

> 当前版本为 `0.0.1-rc.6`，仍处于候选开发阶段，尚无面向普通用户的安装包。项目不再通过 npm registry 分发；请只在本地开发环境中使用，并保留私有数据备份。

## 产品定位

MistyMoon 不是单纯的聊天 UI 或通用记忆数据库，而是 DSH 上的 RP 产品层：

- 以稳定人格、持续关系和跨会话记忆维持角色连续性。
- 允许主人在本机编辑、审核和发布自己的私有人格，不把真实人格上传到公开仓库。
- 将角色行为与通用 Agent Runtime 分离；DSH 负责推理、会话、工具和权限，MistyMoon 负责 RP 语义与陪伴体验。
- 支持未来接入 QQ/NapCat、桌面形象、手机端和主动陪伴，但这些入口共享同一人格、记忆和身份治理规则。

## 当前能力

### 私有人格与 RP

- 首次启动时，从中性模板创建一份用户私有的人格文件。
- 人格文件支持身份、关系、熟人和陌生人差异、表达规则、参考对话与回复长度预算。
- 设置页将编辑保存为不参与对话的草稿，可预览模型可见人格；只有明确点击发布后才会从下一次请求开始生效，并可回滚到旧活动版本。
- 安装或升级插件不会覆盖用户已经修改的人格。
- 真实人格只保存在用户的 DSH Home，不会进入本仓库或 Desktop 应用包。
- 人格投影按 Agent preset 分流。专用 `mistymoon-rp-host-v2` 使用完整已发布 Persona 作为唯一模型可见运行时身份，允许只读的 `web_search` / `web_fetch`、限定在当前 Session 工作区内的 `read` / `grep` / `glob`、固定 Work 委派工具 `mistymoon_code_flash` 与 `ask_user_question`，并直接完成 Owner-facing 回复；模型路由沿用会话在 DSH Web UI 中选择的 provider/model，不被 preset 覆盖。其组装提示词精确隐藏 DSH harness identity 文案，但保留安全、权限、沙箱、审批、协作模式及未知工具治理 section。实际 system 文本由 DSH `request/header` 记录，因此仍可从会话日志重建。该 preset 不叠加 turn-voice/final-voice-refresh，也不暴露 `mistymoon_prepare_final_reply`。其他通用 preset 保持原有互斥双阶段输出画像：每个真实 owner turn 一条受预算的 `mistymoon:turn-voice`，合法 prepare 后原子切换为一次 `mistymoon:final-voice-refresh`，任一请求最多一个 active profile。
- Persona 只拥有 RP Host 的模型可见身份，不授予工具或修改 DSH 的安全、权限、审批、协作模式、工具治理和 Owner 当前请求。真实工具 catalog 与执行 guard 是权威；未知 prompt section 默认保留，工具后注册或 HMR 不会扩大封闭能力面。Web 只读不需要额外确认，本地读取不能越出 Session 工作区；登录、提交、上传、购买、公开发布等外部副作用仍须 capability gate 和 Owner 确认。编码、修改、长研究和审查交给中性 Work child，child 不继承 Persona、父 transcript、关系记忆或 final-reply。
- Work child 发布后使用 DSH rc.7 原生子 Agent 目录和只读会话页向 Owner 展示已落日志的完整工程过程；导航绑定准确的父/子 Session 与 one-shot mode，不新增全 workspace transcript API，也不把 child 内容召回到 RP、人格或长期记忆。
- 每个会话可使用 `/rp off`、`/rp companion` 或 `/rp immersive` 选择展示等级；默认 `companion`，`off` 完全关闭两条路径，Coding 场景不会把代码、命令、计划、诊断或技术决策角色化。

### 长期记忆

- 识别“请记住……”等明确请求，并写入私有的 v2 事务式 JSONL 档案。
- 每个逻辑变更只写入一条带摘要链的事务；跨进程 lease、写前重读、文件落盘和相邻 checkpoint 防止并发丢失及完整尾事务被静默删除。
- 每条新 candidate/record 都携带可信 Owner、channel authority、严格的 Companion Reality / Character Scene / Campaign Branch scope、不可变 Observation、memory kind 和事实有效时间；不同 Owner 或 scope 不能混召回。
- `confidential` 在排序前硬过滤：只有通道策略允许且当前已认证 Owner 明确请求保密召回时才可进入模型可见快照，不能依靠提示词兜底。
- 旧 domain schema v1 档案必须先显式 plan/apply scope migration，由 Owner 提供 owner、authority、scope、默认 kind 和时间策略；不得从正文猜测。损坏档案进入 quarantine，不参与召回，也不阻断普通 DSH 工作。
- 来源幂等键包含 Owner、authority、scope、source kind 和 source id，避免重复写入且不跨域错误合并。
- 召回内容以带来源的 DSH 消息写入会话，因此实际发送给模型的上下文可以从会话日志重建。
- 支持列出、纠正和遗忘记忆；旧值保留在审计历史中，但不会继续参与召回。
- 支持候选记忆的提议、查看、批准和拒绝。候选内容只有经过主人批准后才会成为正式长期记忆。
- 设置页提供候选记忆审核区域；待审核和已拒绝的候选不会进入模型上下文。

### 本机设置页

- 入口：**设置 → 插件 → MistyMoon**。
- 可编辑人格、关系规则、参考对话、回复预算和单次记忆召回上限。
- 可导入 Character Card V1/V2/V3 JSON、PNG/APNG 和 CHARX，在字段映射与人格差异预览后保存为未发布草稿。
- 角色卡的系统提示词和场景映射默认关闭；Creator Notes、问候、世界书、扩展和未知字段不会自动进入人格或模型上下文。
- 可在页面中批准或拒绝候选记忆。
- 可从 DSH 当前已注册、且支持 `max` reasoning 的模型目录中选择后续 Work child 使用的 provider/model。MistyMoon 只保存引用，不复制 API Key、Base URL、余额或账号配置；非默认 exact pair 会明确标为 experimental，并以保存操作作为 Owner 确认。
- Host API 只允许本机回环来源访问，避免私有人格和记忆通过普通远程页面暴露。

### 旧版数据迁移

- 可只读预览旧 MistyMoon SQLite 数据库。
- 仅迁移状态为 `confirmed` 的长期记忆。
- 不迁移旧人格、会话、事件、候选记忆、已遗忘记录、图索引、向量索引或凭据。
- 重复执行迁移具有幂等性，不会重复导入同一条来源记录。

## 架构原则

MistyMoon 通过 DSH 原生插件扩展点实现功能：

```text
DeepSeek Harness
├─ Agent、会话、工具、权限与 Web Runtime
└─ MistyMoon RP 插件套件
   ├─ identity       Owner Eligibility 与通道认证适配
   ├─ foundation     私有人格生命周期与会话级 RP 投影
   ├─ memory         长期记忆、候选审核与召回
   ├─ settings-ui    本机设置和候选记忆审核页面
   ├─ work-agent     低耦合的共享基线、固定预设解析与兼容性合同
   ├─ work-agent-dsh 唯一的 DSH child lifecycle Adapter
   └─ installer      Desktop 构建/开发预览使用的版本化安装、状态与回滚 seam
```

Identity 插件先于 Foundation 和 Memory 装载，只把通过 `source.kind=user`、顶层 delegation depth 与当前通道认证三项校验的消息认定为 Owner。当前 `local-dsh-host-rpc` authority 只覆盖默认回环 Web 单 Owner 部署；child、无 Host RPC 证据的消息和未来未适配通道全部 fail closed。记忆插件只维护一个进程级档案实例。Agent 工具、召回流程与设置页共同使用该实例，避免多个进程内视图同时写入同一份 JSONL 文件。DSH 会话保存原始对话和模型可见投影，MistyMoon 记忆档案只保存经过选择的跨会话事实。

`work-agent` 提供零 DSH 运行时依赖的共享基线、固定 preset 和 profile revision 合同；`work-agent-dsh` 是唯一的 DSH lifecycle Adapter。当前实现已在 rc.7 中性临时 Home 验证 fresh depth-one Anchored child、保护段、工具面、模型可见日志与失败回滚，并实现已资格化的 Flash/max 前台 provider、跨 RP Host 的同 workspace 串行租约和“只影响下一次 fresh activation”的 profile controller。Routing Suite 不属于目标基线，J-Space 仍为 not-ready 实验项。Flash/max 独立样例 15/15 后，Owner 接受 Flash-only 首发并由 `cordis.patch.yml` 加载；后续批次虽保留了 Pro/max 15/15，但未批准发布专用 Pro 工具，且暴露 Flash 稳定性证据缺口，因此不会自动选择 Pro 或发起付费复核。若 Owner 已在 DSH 配置 Pro，通用设置页仍可把该 exact pair 作为明确确认的 experimental 模型使用。

Work child 的部署默认模型可在 **设置 → 插件 → MistyMoon** 中选择。页面从 DSH 的实时 provider/model catalog 读取选项，只展示能够解析 `max` reasoning 的已注册模型；默认仍是已资格化的 `deepseek-official / deepseek-v4-flash`。选择 OpenCode Go、Pro 或任意其他非默认 exact pair 时，保存即表示 Owner 确认 experimental 使用及可能消耗所选提供商的套餐额度/余额，且只影响之后创建的 fresh child；运行中 child 不重绑。route 缺失、region、额度或协议错误均直接失败，不自动 fallback。OpenCode Go 的条款、供应商数据保留政策与套餐风险应在选择前向供应商独立核对。

详细模块职责、外部记忆 Provider 和安全边界见 [架构说明](docs/architecture.md)；开发与 Agent 协作遵循 [AGENTS.md](AGENTS.md)。

## 本套件包含的插件

下表中的组件作为一个仓库内套件共同维护，并将在未来 DSH Desktop 发行物中预装：

| 组件 | DSH 加载名或入口 | 职责 |
| --- | --- | --- |
| Identity | `@mistymoon/dsh/identity` | 统一 Owner Eligibility、顶层 delegation gate 与当前回环 Web authority |
| Foundation | `@mistymoon/dsh/foundation` | 私有人格生命周期、RP 等级、会话级人格投影、Character Card 解析和字段映射 |
| Memory | `@mistymoon/dsh/memory` | 长期记忆档案、候选审核、召回快照和记忆工具 |
| Settings UI Host | `@mistymoon/dsh` | 本机回环 RPC、人设草稿/发布/回滚、角色卡导入和记忆审核 |
| Settings UI Client | `@mistymoon/dsh/client` | DSH Web 中的 MistyMoon 设置页面 |
| Work Agent Contracts | `@mistymoon/dsh/work-agent` | Phase 0 的共享基线、固定 Work Preset 解析与兼容性决策；当前不是运行时插件 |
| DSH Work Agent Adapter | `@mistymoon/dsh/work-agent-dsh` | Anchored fresh child、已资格化 Flash/max provider、workspace lease、next-activation profile 与发布前重校验；由 bundle 自动注册 |
| Bundle Patch | `cordis.patch.yml` | 将以上运行时插件组合进 DSH Profile |
| Installer | `mistymoon-dsh-install` / `@mistymoon/dsh/installer` | Desktop 构建和开发预览使用的 `install` / `update` / `status` / `rollback` 事务入口；不是公开用户安装方式或常驻运行时插件 |

以下项目不属于当前插件套件，也不会因为本仓库采用 MIT 就自动获得再分发许可：`dsh-noema`、`dsh-anchored-standard`、Mnemon、Mem0、NapCat、OwO-Desktop、Live2D Runtime 与任何角色模型或素材。未来 DSH Desktop 只会封装已完成许可证审计且明确获准再分发的依赖；其他项目仍是可选 Provider/Adapter 或用户独立安装的依赖。

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- DeepSeek Harness `0.1.0-rc.7`

## 分发与安装状态

项目已停止设计 npm 用户安装流程，仓库根包也被标记为 private。目标是在 P0、P1（桌面跑团模式除外）完成后，提供预装 MistyMoon 套件的签名 DSH Desktop；普通用户无需登录 npm、执行 `pnpm dlx`、手工复制 bundle 或 provision preset。

当前尚未发布可供普通用户安装的 Desktop。现有 installer 仅供 Desktop 封装流水线、开发预览和中性临时环境测试复用；它继续验证 bundle/preset 指纹，并以补偿事务维护内部安装状态，但不是稳定公开 CLI 承诺。Desktop 发布前还必须完成许可证与第三方资产审计、代码签名、全新 Windows 安装、升级/回滚、卸载边界和用户数据保留测试。

DSH 仍负责生成和维护 Profile；MistyMoon 不手工修改 DSH Profile 格式。真实 Persona、Memory、凭据、会话和日志始终保存在应用目录之外的独立私有 DSH Home，应用升级和回滚不得覆盖这些数据。具体决策见 [ADR 0002](docs/adr/0002-desktop-bundled-distribution.md)。

## 开发预览

Windows 默认将预览数据保存在 `%LOCALAPPDATA%\MistyMoon\dsh`。可以通过 `MISTYMOON_DSH_HOME` 指定其他私有目录。

```powershell
pnpm preview:install
pnpm preview:smoke
pnpm preview:start
```

指定 Web 端口：

```powershell
pnpm preview:start -- --port 3081
```

## 迁移旧记忆

先只读预览，不修改源数据库和目标档案：

```powershell
pnpm preview:migrate-memory -- <LEGACY_MEMORY_DB>
```

确认统计结果和警告后，再显式导入：

```powershell
pnpm preview:migrate-memory -- <LEGACY_MEMORY_DB> --apply
```

`preview:install` 使用与发布 CLI 相同的 bundle + preset 预览/确认 seam；默认要求输入 `yes`，自动化的中性临时 Home 可显式传入 `--yes`。`preview:smoke` 和 `preview:start` 只消费已安装结果，不再隐式重复安装。

已有 v1 JSONL 档案使用本机维护 CLI。所有命令默认只读；`apply` 必须使用刚生成、尚未过期且绑定 exact digest 的 token：

```powershell
pnpm memory:maintenance -- inspect <MEMORY_ARCHIVE>
pnpm memory:maintenance -- plan-migrate <MEMORY_ARCHIVE> <OWNER_ID> <AUTHORITY> '<SCOPE_JSON>' <MEMORY_KIND> [BACKUP_PATH]
pnpm memory:maintenance -- plan-recover <MEMORY_ARCHIVE> [BACKUP_PATH]
pnpm memory:maintenance -- apply <MEMORY_ARCHIVE> <PLAN_TOKEN> <EXPECTED_DIGEST>
pnpm memory:maintenance -- rehearse-rollback <MEMORY_ARCHIVE> <BACKUP_PATH> <EXPECTED_BACKUP_DIGEST>
```

`plan-migrate` 的 scope JSON 必须是严格的 `MemoryScopeV1`，例如 `{"version":1,"kind":"companion-reality"}`；memory kind 必须是公开枚举之一。计划把这些显式赋值写入无正文 token，绝不从旧正文猜测。尾部半事务使用 `plan-recover`；内部损坏只返回无正文的 `restore-required`，不会自动跳过。默认最多保留 20 个自动命名 backup，达到上限后要求 Owner 先处理，不会自动删除。`rehearse-rollback` 只读校验当前 v2 与 exact legacy backup，实际恢复仍需停写后由 Owner 执行。Windows 会完成 exact backup、文件 fsync、原子替换、checkpoint 和重开校验，但 Node 不支持目录句柄 fsync，因此突然断电恰好发生在 rename 窗口时可能需要从备份恢复。真实档案的任何 `apply` 仍需 Owner 单独确认。

## 私有数据与开源边界

仓库只发布插件代码、中性人格模板和示例人格。以下内容被发布审计和 `.gitignore` 排除：

- 用户真实人格与提示词
- 长期记忆、候选记忆和迁移数据
- DSH 会话、日志和运行状态
- `.env`、API Key、Token 与其他凭据
- SQLite、JSONL 和用户导出文件

默认私有文件位于 DSH Home 下的 `mistymoon` 目录中：

```text
mistymoon/
├─ persona/
│  ├─ persona.json
│  ├─ draft.json（仅在存在未发布草稿时）
│  └─ versions/（活动人格的回滚历史）
├─ memory/memories.jsonl
├─ packages/（Desktop 内部按版本保留、供更新与回滚使用的 bundle）
├─ install-state.json（无私密正文的安装状态与指纹）
└─ settings/
   ├─ settings.json
   └─ work-model.json（仅保存 provider/model 引用与 revision）
```

发布前必须运行：

```powershell
pnpm audit:publication
```

## 开发与验证

```powershell
pnpm install
pnpm check
```

`pnpm check` 会依次执行严格类型检查、单元测试、构建、已构建 Cordis 插件冒烟测试和发布隐私审计。

## 待更新内容

下面是当前计划，优先级可能根据实际 RP 体验和测试结果调整。未勾选项目不代表已经可用。

### P0：RP 连续性、记忆可靠性与治理

- [x] 统一 Owner Eligibility：Foundation/Memory 共享顶层与通道认证门，child 不触发人格、记忆或治理工具
- [x] 版本化私有人格、关系规则、参考对话与回复预算
- [x] 明确记忆的追加式保存、纠正、遗忘和审计历史
- [x] 候选记忆的提议、批准、拒绝和设置页审核
- [x] RP 展示等级与 DSH 预设/协作模式正交，兼容 `minimal` 且不覆盖 Coding、工具、权限和安全规则
- [x] 通用 preset 的互斥双阶段输出画像：每个 owner turn 一条受字段预算的 turn-voice profile，合法 finalization 后原子切换为一条 final-voice-refresh，任一请求 active profile 不超过一；RP Host 专用完整 Persona system projection 由 P1 单独实现
- [x] 人格草稿、精确预览、显式发布、并发覆盖保护和版本回滚
- [x] Character Card V1/V2/V3 JSON 的不可信输入解析、未知字段保留和私有草稿模型
- [x] Character Card 草稿预览、字段映射 UI，以及带大小/路径/压缩比限制的 PNG/APNG、CHARX 容器解析；详见 [导入设计](docs/persona-import.md)
- [ ] 自动候选提取 Provider：对回复后的稳定事实生成候选，但不自动批准
- [ ] 冲突检测与替代链：发现矛盾时要求主人选择，接受新值后以墓碑和 `supersedes` 保留旧值
- [ ] 记忆整合、衰减、归档与恢复
- [ ] 专用记忆管理页：搜索、筛选、批量审核和来源查看
- [x] 为记忆日志增加 v2 事务格式、跨进程 lease、显式迁移、checkpoint、quarantine 和尾部损坏恢复工具
- [x] Scoped Memory Records：可信 Owner/authority/scope、Observation、memory kind、有效时间、跨域隔离和 confidential 双门硬过滤
- [ ] BM25、PageIndex 与图关系融合召回，以及可解释的召回结果
- [ ] 候选记忆的编辑、合并和不含敏感载荷的操作审计

### P1：RP Agent、体验模式与通信

> 前三项已按 Owner 接受的 Flash-only 首发范围完成并接入 bundle：Flash/max 曾完成一批 5×3、15/15。后续稳定性批次中 Pro/max 为 15/15，但 Flash 批次总门未通过且中段脱敏结果未被宿主完整保留；因此不自动扩大到 Pro，Flash 也不被描述为长期质量保证。精确复核在首例后再次耗尽额度；公开发布前需用可恢复 case-resume 补齐稳定性证据。

- [x] 注册 RP 专用 Agent 预设：RP Host Agent 使用完整已发布 Persona 身份、只读 Web、工作区内只读文件检查、风险确认与已资格化 Flash 委派工具；Work Agent 负责编码、研究、审查和规则分析，通用 preset 保留既有 final-reply 路径；详见 [委派设计](specs/011-rp-agent-delegation/SPEC.md)
- [x] Work Agent 默认使用固定 Anchored Standard 编码层，保留 durable 工具阶段；Routing Suite 不作为产品依赖，J-Space 仅作为复杂任务的 child-only skill/ledger 并保持实验门
- [x] 基于 DSH child 设计可切换 Work Agent：创建时选择完整、版本化的 Work Preset；logical switch 只影响下一次 fresh one-shot activation，共享不可变治理基线而不共享 RP transcript；同 Session native switch 等待 DSH 上游接口；详见 [工程架构](specs/014-switchable-work-agent/SPEC.md)
- [x] Phase 0 DSH Adapter：在 rc.7 中性临时 Home 下验证 Anchored-only provision、restart discovery、独立 composition、空 seed、真实 header/request/tool surface、模型可见日志和 publication 前回滚，以及不自动注册的 fixed/governed one-shot provider 的共享 baseline、发布点重校验、取消和 dispose；尚不等于产品 provider
- [x] 设置页读取 DSH 实时模型目录并保存后续 Work child 的 exact provider/model 引用；非默认 route 要求 Owner 确认、固定 `max` reasoning、不可用时 fail closed 且不 fallback
- [ ] 扩展 DSH 模型 route：Flash/high、Flash/max、Pro/max 的官方 Adapter wire 请求及禁用/缺失 fail-loud 已捕获，Flash/max 产品 route 已注册；Pro 与其他 DSH provider 仍需独立资格门，不使用提示词伪造思维链
- [ ] 将 Experience Mode 与 `/rp off|companion|immersive`、DSH 协作模式分离：`companion-chat`、`character-scene`、`tabletop-campaign`
- [ ] 类酒馆 Character Scene：独立 Scene Role、场景正史、分支与虚构记忆范围，不覆盖长期陪伴 Persona
- [ ] 桌面跑团：RP Host 主持、可审计骰子、规则 Adapter、Campaign Branch 与原子 Canon commit；详见 [体验模式设计](specs/013-roleplay-experience-modes/SPEC.md)
- [ ] 按 [RP 长期记忆目标架构](specs/012-rp-memory-architecture/SPEC.md) 完成 Experience Adapter 与可解释召回评测；底层 Companion Reality / Character Scene / Campaign Branch record 隔离已经完成

- [ ] NapCat/QQ Channel Adapter
- [ ] MistyMoon 启动时启动 NapCat，并提供健康检查、重连和受控关闭
- [ ] 主人、熟人和陌生人的通道身份映射与 RP 隐私策略
- [ ] 主动陪伴调度、免打扰时段和频率限制
- [ ] Presence 状态：情绪、动作和桌宠展示意图
- [ ] 不同入口共享角色连续性，同时避免把一个用户的私密记忆泄露给另一个用户

### P2：桌面端与移动端

- [ ] Windows Launcher 与类似游戏的单安装器体验
- [ ] 配置代际、启动健康检查和上一个可用版本回滚
- [ ] Windows 代码签名、更新包哈希和离线签名验证
- [ ] 手机端页面与安全的远程 RP 会话入口
- [ ] 基于系统 SSH 端口转发或窄权限 SSH Gateway 的手机直连方案
- [ ] Noema 只读 shadow mode 与可选记忆 Provider；通过身份、来源、生命周期和 Windows 一致性门槛后再开放替换
- [ ] Mnemon 和 Mem0 可选记忆 Provider
- [ ] LivingMemory 逻辑数据导入器，不复制其 AGPL 实现

### P3：表现层与受控演化

- [ ] 可选 Live2D/桌宠适配器，将 RP 状态映射为表情和动作，并与 Agent Runtime 解耦
- [ ] 模型、动作、字体、声音等第三方素材的独立许可证审查
- [ ] 隔离工作区中的自我修改、测试和风险分级
- [ ] 仅对低风险插件变更自动部署，并提供健康检查与自动回滚
- [ ] 人格发布、永久删除记忆、权限提升和公开推送始终要求人工确认

## Windows 打包说明

计划采用单个安装程序提供类似游戏客户端的安装体验。安装完成后的 Electron、Node 和 DSH Runtime 通常仍是目录结构，不承诺把全部运行时压缩成一个长期自解压的 PE 文件。这样更利于增量更新、签名校验、故障诊断和安全回滚。

## 许可证

本仓库使用 [MIT License](LICENSE)。DeepSeek Harness、Electron、NapCat、Mem0、Mnemon、Live2D 组件、模型、字体、声音及其他第三方依赖仍保留各自许可证和 NOTICE 要求。

OwO-Desktop、Live2D Cubism 模型或朋友项目中的素材不会因为本仓库使用 MIT 就自动获得再分发许可；接入前必须分别确认代码与素材授权。
